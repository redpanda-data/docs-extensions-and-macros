'use strict'

const fs = require('fs')
const path = require('path')

const { SourceCache } = require('../source-text')
const { STANDARD } = require('../standards')
const {
  maskComments,
  findBalancedClose,
  splitTopLevelArgs,
  collectStringConsts,
  evalStringExpr,
  lineOf,
  collectGoFiles
} = require('../go-source')

/**
 * operator surface: pflag usage strings of the Redpanda Operator `run`
 * command, in redpanda-operator operator/cmd/run.
 *
 * These strings are published on the generated operator flags reference
 * page, next to a Default column that doc-tools renders from the flag's
 * real default, so a usage string never needs to restate it.
 *
 * The scan is the rpk surface's comment-masked Go scanner, narrowed to flag
 * registrations. Three call shapes occur in run.go:
 *
 *   cmd.Flags().BoolVar(&o.x, "name", false, "usage")   // Var forms
 *   o.d = cmd.Flags().Duration("name", 15*time.Second, "usage")
 *   cmd.Flags().Var(&o.selector, "name", "usage")       // no default argument
 *
 * Unlike rpk, deprecated flags are extracted: the reference page lists them
 * in a Deprecated section with both the usage string and the
 * MarkDeprecated message, so both are published text. Flags that are only
 * hidden (MarkHidden with no MarkDeprecated) never reach the page and are
 * skipped.
 */

const CONVENTION = {
  case: 'sentence',
  terminal_period: false,
  verbatim_asciidoc: false,
  // No transformer: the reference page renders the usage string as written,
  // so flags, paths and other code values need their own backticks.
  transformer: null
}

const RUN_ROOT = path.join('operator', 'cmd', 'run')

const FLAG_CALL = /\.\s*(?:Flags|PersistentFlags)\s*\(\s*\)\s*\.\s*([A-Za-z0-9]+)\s*\(/g
// pflag registration methods: value-type names (String, BoolVar, DurationVar,
// StringToStringVar, ...) plus the generic Var/VarP that take a pflag.Value
// and no default. Accessors (Lookup, MarkHidden, ...) never match.
const FLAG_METHOD = /^(?:(?:String|Bool|Int|Uint|Float|Duration|Count|Bytes|IP)[A-Za-z0-9]*|Var|VarP)$/
const MARK_CALL = /\.\s*Mark(Hidden|Deprecated)\s*\(/g

const DURATION_UNITS = {
  Nanosecond: 'ns',
  Microsecond: 'µs',
  Millisecond: 'ms',
  Second: 's',
  Minute: 'm',
  Hour: 'h'
}

/**
 * Best-effort literal value of a default argument, as the strings a usage
 * text might restate it with. `15*time.Second` -> ['15s'], `30*time.Minute`
 * -> ['30m', '30m0s'], `100` -> ['100'], `"tls.crt"` -> ['tls.crt'].
 * Returns [] when the default is not a literal (a constant from another
 * package, a function call).
 */
function defaultForms (exprText, consts) {
  if (exprText == null) return []
  const expr = exprText.trim()
  if (/^-?\d+(?:\.\d+)?$/.test(expr)) return [expr]
  if (expr === 'true' || expr === 'false') return [expr]
  let m = expr.match(/^(\d+)\s*\*\s*time\.([A-Za-z]+)$/) || expr.match(/^time\.([A-Za-z]+)\s*\*\s*(\d+)$/)
  if (m) {
    const [n, unit] = /^\d+$/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]]
    const suffix = DURATION_UNITS[unit]
    if (!suffix) return []
    const forms = [`${n}${suffix}`]
    if (suffix === 'm') forms.push(`${n}m0s`)
    if (suffix === 'h') forms.push(`${n}h0m0s`)
    return forms
  }
  m = expr.match(/^time\.([A-Za-z]+)$/)
  if (m && DURATION_UNITS[m[1]]) return [`1${DURATION_UNITS[m[1]]}`]
  const str = evalStringExpr(expr, consts)
  if (str.verifiable && str.value !== '') return [str.value]
  return []
}

/** The default-argument text of a registration call, or null (Var/VarP). */
function defaultArg (method, args) {
  if (method === 'Var' || method === 'VarP') return null
  // Var forms: (&target, name, [shorthand,] default, usage)
  // Plain forms: (name, [shorthand,] default, usage)
  return args.length >= 3 ? args[args.length - 2] : null
}

/**
 * Scan one file's content for operator flag declarations.
 * Exported for tests.
 */
function scanFile (content, file) {
  const declarations = []
  const masked = maskComments(content)
  const consts = collectStringConsts(masked)

  const hidden = new Set()
  const deprecated = new Map() // flag name -> { message, verifiable, index, closeIndex }
  MARK_CALL.lastIndex = 0
  let match
  while ((match = MARK_CALL.exec(masked)) !== null) {
    const openIndex = match.index + match[0].length - 1
    const closeIndex = findBalancedClose(masked, openIndex)
    if (closeIndex === -1) continue
    const args = splitTopLevelArgs(masked.slice(openIndex + 1, closeIndex))
    if (args.length === 0) continue
    const name = evalStringExpr(args[0], consts)
    if (!name.verifiable) continue
    if (match[1] === 'Hidden') {
      hidden.add(name.value)
    } else {
      const message = args.length > 1 ? evalStringExpr(args[1], consts) : { verifiable: false, value: null }
      deprecated.set(name.value, { message, index: match.index, closeIndex })
    }
  }

  FLAG_CALL.lastIndex = 0
  while ((match = FLAG_CALL.exec(masked)) !== null) {
    const method = match[1]
    if (!FLAG_METHOD.test(method)) continue
    const openIndex = match.index + match[0].length - 1
    const closeIndex = findBalancedClose(masked, openIndex)
    if (closeIndex === -1) continue
    const args = splitTopLevelArgs(masked.slice(openIndex + 1, closeIndex))
    if (args.length < 2) continue

    let flagName = null
    for (const arg of args.slice(0, -1)) {
      const result = evalStringExpr(arg, consts)
      if (result.verifiable) {
        flagName = result.value
        break
      }
    }
    if (flagName == null) continue
    const dep = deprecated.get(flagName)
    if (hidden.has(flagName) && !dep) continue

    const usage = evalStringExpr(args[args.length - 1], consts)
    const def = defaultArg(method, args)
    declarations.push({
      surface: 'operator',
      name: `--${flagName}`,
      file,
      line_start: lineOf(masked, match.index),
      line_end: lineOf(masked, closeIndex),
      string: usage.verifiable ? usage.value : null,
      declaration_text: null,
      convention: CONVENTION,
      meta: {
        kind: 'flag',
        method,
        default_text: def == null ? null : def.trim(),
        default_forms: defaultForms(def, consts),
        deprecated: dep ? (dep.message.verifiable ? dep.message.value : '') : null,
        unverifiable: !usage.verifiable
      }
    })

    if (dep) {
      declarations.push({
        surface: 'operator',
        name: `--${flagName}`,
        file,
        line_start: lineOf(masked, dep.index),
        line_end: lineOf(masked, dep.closeIndex),
        string: dep.message.verifiable ? dep.message.value : null,
        declaration_text: null,
        convention: CONVENTION,
        meta: {
          kind: 'deprecation',
          // cobra prints the message after "Flag --x has been deprecated,",
          // so it correctly opens in lowercase and reads as a clause.
          skip_rules: ['starts-lowercase'],
          unverifiable: !dep.message.verifiable
        }
      })
    }
  }

  return declarations
}

/**
 * Extract operator flag declarations.
 *
 * @param {Object} options - { repo, files (Set of repo-relative paths, diff
 *   mode; when omitted, scans operator/cmd/run), log }
 */
function extract ({ repo, files = null }) {
  let fileList
  if (files) {
    fileList = [...files].filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))
  } else {
    fileList = collectGoFiles(path.join(repo, RUN_ROOT)).map((f) => path.join(RUN_ROOT, f))
  }

  const cache = new SourceCache(repo)
  const declarations = []
  for (const file of fileList) {
    const absPath = path.isAbsolute(file) ? file : path.join(repo, file)
    if (!fs.existsSync(absPath)) continue
    const content = fs.readFileSync(absPath, 'utf8')
    if (!content.includes('Flags()')) continue
    for (const decl of scanFile(content, file)) {
      decl.declaration_text = cache.span(file, decl.line_start, decl.line_end)
      declarations.push(decl)
    }
  }
  return declarations
}

function escapeRegExp (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Where a usage string restates the flag's default. Returns the matched
 * phrase or null. Three shapes: a "(default ...)" parenthetical, a
 * "Default <value>" or "defaults to <value>" phrase naming the literal
 * default, and a "Default <value>" sentence opener with a literal-looking
 * value (the default argument may be a constant the scanner cannot read).
 */
function restatedDefault (text, forms) {
  let m = text.match(/\(default\b[^)]*\)/i)
  if (m) return m[0]
  for (const form of forms) {
    const re = new RegExp(`\\bdefaults?\\b\\s*(?:is|to|of|:|=)?\\s*\`?${escapeRegExp(form)}\`?(?![\\w.])`, 'i')
    m = text.match(re)
    if (m) return m[0]
  }
  m = text.match(/(?:^|[.;]\s+)(Default\s+`?(?:-?\d[\w.]*|true|false)`?)/)
  if (m) return m[1]
  return null
}

const RULES = [
  {
    name: 'operator-terminal-period',
    description: 'Flag usage strings do not end with a period',
    why: 'A flag usage string is a one-line label, not a sentence, so it takes no terminal period.',
    standard: STANDARD.rpk,
    severity: 'warning',
    check: (decl) => {
      if (decl.meta.kind !== 'flag') return []
      const text = (decl.string || '').trim()
      if (/\.$/.test(text)) {
        return [{ message: `Flag usage ends with a period: "...${text.slice(-50)}". Flag usage is a one-line label with no terminal period.` }]
      }
      return []
    }
  },
  {
    name: 'operator-restated-default',
    description: 'Flag usage restates the default the reference page already renders',
    why: 'The operator flags reference renders each default from the flag itself, so a default written into the usage string duplicates it and goes stale when the default changes.',
    standard: STANDARD.qualityBar,
    severity: 'warning',
    check: (decl) => {
      if (decl.meta.kind !== 'flag') return []
      const text = (decl.string || '').trim()
      if (!text) return []
      const phrase = restatedDefault(text, decl.meta.default_forms || [])
      if (!phrase) return []
      return [{ message: `Flag usage restates its default ("${phrase}"). The reference page renders the default; remove it from the string, and keep only what a sentinel value such as \`0\` or an empty string means.` }]
    }
  },
  {
    name: 'operator-unmarked-deprecation',
    description: 'Flag usage says the flag is deprecated, but the flag is not marked deprecated',
    why: 'Only flags registered with MarkDeprecated are listed as deprecated on the reference page and warn when used, so a flag that is deprecated in prose only looks current to readers.',
    standard: STANDARD.qualityBar,
    severity: 'info',
    check: (decl) => {
      if (decl.meta.kind !== 'flag' || decl.meta.deprecated != null) return []
      const text = (decl.string || '').trim()
      if (/\bdeprecated\b/i.test(text)) {
        return [{ message: 'Usage calls this flag deprecated, but it is not registered with MarkDeprecated. Mark it deprecated with a message that says what to use instead, so the reference page and the CLI both report it.' }]
      }
      return []
    }
  },
  {
    name: 'operator-deprecation-no-alternative',
    description: 'Deprecation message does not say what to do instead',
    why: 'Readers who hit a deprecated flag need to know what replaces it or that they can remove it, and the deprecation message is the only place both the CLI warning and the reference page take that from.',
    standard: STANDARD.qualityBar,
    severity: 'info',
    check: (decl) => {
      if (decl.meta.kind !== 'deprecation') return []
      const text = (decl.string || '').trim()
      if (!text) {
        return [{ message: 'Deprecation message is empty. Say what to use instead, or that the flag has no effect and can be removed.' }]
      }
      if (/\b(?:use|instead|replac\w*|supersed\w*|remove|no effect|ignored|has no replacement|unnecessary)\b/i.test(text)) return []
      return [{ message: `Deprecation message does not say what to use instead: "${text.slice(0, 80)}". Name the replacement, or say the flag can be removed.` }]
    }
  }
]

function identity (decl) {
  return [decl.file, (decl.meta && decl.meta.kind) || null, decl.name]
}

module.exports = {
  name: 'operator',
  convention: CONVENTION,
  extract,
  scanFile,
  identity,
  defaultForms,
  restatedDefault,
  rules: RULES,
  // Flag usage strings are one-line labels, so the generic too-short rule
  // would fire on nearly every conforming string.
  skipRules: ['too-short']
}
