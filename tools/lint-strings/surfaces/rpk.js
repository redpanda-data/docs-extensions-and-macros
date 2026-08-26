'use strict'

const fs = require('fs')
const path = require('path')

const { SourceCache } = require('../source-text')
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
 * rpk surface: cobra.Command Use/Short/Long strings and pflag usage strings
 * in src/go/rpk/pkg/cli.
 *
 * Direct Go source scan (comment-masked regex/paren scanner in the style of
 * surfaces/metrics.js) so findings carry exact file:line spans:
 * - cobra.Command composite literals -> Short and Long declarations (Use is
 *   captured to name the command, not linted as prose),
 * - .Flags()/.PersistentFlags() registration calls (StringVar, BoolVarP,
 *   Int32Var, Duration, ...) -> flag name + usage string.
 *
 * rpk is NOT a verbatim surface: generate-rpk-docs.js formatDescription()
 * rewrites these strings (~40 passes: auto-backticking, e.g. -> "for
 * example,", ALLCAPS -> === headings, ensurePeriod) before publication, so
 * escaping rules do not apply. The convention rules here catch what the
 * transformer cannot fix: lowercase starts, terminal periods, name echoes,
 * and Long-text patterns that change page structure when transformed.
 */

const CONVENTION = {
  case: 'sentence',
  terminal_period: false,
  verbatim_asciidoc: false,
  transformer: 'formatDescription'
}

// Composite literal only: gofmt writes `cobra.Command{` with no space, while
// a function signature returning *cobra.Command always has a space (or a
// star) before its body brace - so this never swallows a function body.
const COMMAND_LITERAL = /\bcobra\.Command\{/g
// Registration methods are pflag value-type names (String, BoolVarP,
// Int32Var, DurationP, StringSlice, ...). Accessors (Lookup, Set,
// GetString, MarkHidden, ...) do not start with a value-type prefix.
const FLAG_CALL = /\.\s*(?:Flags|PersistentFlags)\s*\(\s*\)\s*\.\s*([A-Za-z0-9]+)\s*\(/g
const FLAG_METHOD = /^(String|Bool|Int|Uint|Float|Duration|Count|Bytes|IP)[A-Za-z0-9]*$/
// Flag sets bound to a variable first: `f := cmd.Flags()` ... `f.StringVar(...)`.
const FLAGSET_ASSIGN = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:?=\s*[\w.]+\.(?:Flags|PersistentFlags)\s*\(\s*\)/g
// Hidden and deprecated flags never reach the generated docs (cobra help and
// printtree.go both skip them), so their usage strings are not linted.
const MARK_UNPUBLISHED = /\.\s*Mark(?:Hidden|Deprecated)\s*\(/g

/**
 * Parse the top-level fields of a composite literal body.
 * Returns Map(fieldName -> { start, end }) with offsets relative to body.
 */
function parseLiteralFields (body) {
  const fields = new Map()
  let depth = 0
  let i = 0
  while (i < body.length) {
    const ch = body[i]
    if (ch === '"' || ch === '`' || ch === "'") {
      let j = i + 1
      if (ch === '`') {
        while (j < body.length && body[j] !== '`') j++
      } else {
        while (j < body.length && body[j] !== ch) j += body[j] === '\\' ? 2 : 1
      }
      i = j + 1
      continue
    }
    if (ch === '(' || ch === '{' || ch === '[') { depth++; i++; continue }
    if (ch === ')' || ch === '}' || ch === ']') { depth--; i++; continue }
    if (depth === 0 && /[A-Za-z_]/.test(ch) && (i === 0 || /[\s,{]/.test(body[i - 1]))) {
      let j = i
      while (j < body.length && /[A-Za-z0-9_]/.test(body[j])) j++
      // A field key is `Ident:` not followed by another ':' (rules out `::`).
      if (body[j] === ':' && body[j + 1] !== ':' && body[j + 1] !== '=') {
        const name = body.slice(i, j)
        const valueStart = j + 1
        const valueEnd = findTopLevelComma(body, valueStart)
        fields.set(name, { start: i, valueStart, end: valueEnd })
        i = valueEnd + 1
        continue
      }
      i = j
      continue
    }
    i++
  }
  return fields
}

/** Offset of the next top-level comma at/after start (or body end). */
function findTopLevelComma (body, start) {
  let depth = 0
  let i = start
  while (i < body.length) {
    const ch = body[i]
    if (ch === '"' || ch === '`' || ch === "'") {
      let j = i + 1
      if (ch === '`') {
        while (j < body.length && body[j] !== '`') j++
      } else {
        while (j < body.length && body[j] !== ch) j += body[j] === '\\' ? 2 : 1
      }
      i = j + 1
      continue
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++
    if (ch === ')' || ch === '}' || ch === ']') depth--
    if (ch === ',' && depth === 0) return i
    i++
  }
  return body.length
}

/**
 * Scan one file's content for rpk doc-string declarations.
 * Exported for tests.
 */
function scanFile (content, file) {
  const declarations = []
  const masked = maskComments(content)
  const consts = collectStringConsts(masked)

  // cobra.Command composite literals -> Short / Long
  COMMAND_LITERAL.lastIndex = 0
  let match
  while ((match = COMMAND_LITERAL.exec(masked)) !== null) {
    const openIndex = match.index + match[0].length - 1
    const closeIndex = findBalancedClose(masked, openIndex, '{', '}')
    if (closeIndex === -1) continue
    const bodyStart = openIndex + 1
    const body = masked.slice(bodyStart, closeIndex)
    const fields = parseLiteralFields(body)

    let commandName = null
    let use = null
    if (fields.has('Use')) {
      const f = fields.get('Use')
      const result = evalStringExpr(body.slice(f.valueStart, f.end), consts)
      if (result.verifiable) {
        use = result.value
        commandName = use.trim().split(/\s+/)[0] || null
      }
    }

    for (const kind of ['Short', 'Long']) {
      if (!fields.has(kind)) continue
      const f = fields.get(kind)
      const result = evalStringExpr(body.slice(f.valueStart, f.end), consts)
      declarations.push({
        surface: 'rpk',
        name: commandName,
        file,
        line_start: lineOf(masked, bodyStart + f.start),
        line_end: lineOf(masked, bodyStart + f.end),
        string: result.verifiable ? result.value : null,
        declaration_text: null,
        convention: CONVENTION,
        meta: {
          kind: kind.toLowerCase(),
          use,
          unverifiable: !result.verifiable
        }
      })
    }
    COMMAND_LITERAL.lastIndex = closeIndex + 1
  }

  // Flag registrations -> flag usage strings. Two shapes: direct chains
  // (cmd.Flags().BoolVarP(...)) and flag sets bound to a variable first
  // (f := cmd.Flags(); f.StringVar(...)).
  const flagCalls = []
  FLAG_CALL.lastIndex = 0
  while ((match = FLAG_CALL.exec(masked)) !== null) {
    flagCalls.push({ index: match.index, method: match[1], openIndex: match.index + match[0].length - 1 })
  }
  const flagsetVars = new Set()
  FLAGSET_ASSIGN.lastIndex = 0
  while ((match = FLAGSET_ASSIGN.exec(masked)) !== null) flagsetVars.add(match[1])
  if (flagsetVars.size > 0) {
    const varCall = new RegExp(`\\b(${[...flagsetVars].join('|')})\\s*\\.\\s*([A-Za-z0-9]+)\\s*\\(`, 'g')
    while ((match = varCall.exec(masked)) !== null) {
      flagCalls.push({ index: match.index, method: match[2], openIndex: match.index + match[0].length - 1 })
    }
    flagCalls.sort((a, b) => a.index - b.index)
  }

  // Flags marked hidden or deprecated anywhere in the file are excluded:
  // they never ship to the generated docs, so their usage strings (often
  // intentionally empty) are not part of the docs contract.
  const unpublished = new Set()
  MARK_UNPUBLISHED.lastIndex = 0
  while ((match = MARK_UNPUBLISHED.exec(masked)) !== null) {
    const openIndex = match.index + match[0].length - 1
    const closeIndex = findBalancedClose(masked, openIndex)
    if (closeIndex === -1) continue
    const args = splitTopLevelArgs(masked.slice(openIndex + 1, closeIndex))
    if (args.length === 0) continue
    const result = evalStringExpr(args[0], consts)
    if (result.verifiable) unpublished.add(result.value)
  }

  for (const call of flagCalls) {
    if (!FLAG_METHOD.test(call.method)) continue
    const openIndex = call.openIndex
    const closeIndex = findBalancedClose(masked, openIndex)
    if (closeIndex === -1) continue
    const args = splitTopLevelArgs(masked.slice(openIndex + 1, closeIndex))
    if (args.length < 2) continue

    // Flag name: the first argument that is a resolvable string (Var forms
    // put &target first). Shorthand ("w") is the following one-char string.
    let flagName = null
    for (const arg of args.slice(0, -1)) {
      const result = evalStringExpr(arg, consts)
      if (result.verifiable) {
        flagName = result.value
        break
      }
    }
    if (flagName != null && unpublished.has(flagName)) continue
    const usage = evalStringExpr(args[args.length - 1], consts)

    declarations.push({
      surface: 'rpk',
      name: flagName,
      file,
      line_start: lineOf(masked, call.index),
      line_end: lineOf(masked, closeIndex),
      string: usage.verifiable ? usage.value : null,
      declaration_text: null,
      convention: CONVENTION,
      meta: {
        kind: 'flag',
        method: call.method,
        unverifiable: !usage.verifiable
      }
    })
  }

  return declarations
}

/**
 * Extract rpk declarations.
 *
 * @param {Object} options - { repo, files (Set of repo-relative paths, diff
 *   mode; when omitted, scans src/go/rpk/pkg/cli), log }
 */
function extract ({ repo, files = null }) {
  const CLI_ROOT = path.join('src', 'go', 'rpk', 'pkg', 'cli')
  let fileList
  if (files) {
    fileList = [...files].filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))
  } else {
    fileList = collectGoFiles(path.join(repo, CLI_ROOT)).map((f) => path.join(CLI_ROOT, f))
  }

  const cache = new SourceCache(repo)
  const declarations = []
  for (const file of fileList) {
    const absPath = path.isAbsolute(file) ? file : path.join(repo, file)
    if (!fs.existsSync(absPath)) continue
    const content = fs.readFileSync(absPath, 'utf8')
    if (!content.includes('cobra.Command') && !content.includes('Flags()')) continue
    for (const decl of scanFile(content, file)) {
      decl.declaration_text = cache.span(file, decl.line_start, decl.line_end)
      declarations.push(decl)
    }
  }
  return declarations
}

/**
 * Mirror of parseDescriptionSections' section-header heuristic in
 * tools/rpk-docs/generate-rpk-docs.js: an all-caps line (no double spaces,
 * not directly under a "$ command" invocation) is promoted to a `===`
 * heading in the generated docs.
 */
const ALLCAPS_LINE = /^([A-Z][A-Z\s\-/&]*[A-Z])$/

function isHeadingLine (lines, i) {
  const line = lines[i]
  if (/ {2}/.test(line) || !ALLCAPS_LINE.test(line)) return false
  for (let p = i - 1; p >= 0; p--) {
    if (lines[p].trim() === '') break
    if (/^\$\s/.test(lines[p])) return false
  }
  return true
}

/** Surface-specific convention rules. */
const RULES = [
  {
    name: 'rpk-short-multiline',
    description: 'Short must be a single line',
    severity: 'warning',
    check: (decl) => {
      if (decl.meta.kind !== 'short') return []
      const text = (decl.string || '').trim()
      if (text.includes('\n')) {
        return [{ message: 'Short spans multiple lines. The rpk convention is a one-line Short; move detail into Long.' }]
      }
      return []
    }
  },
  {
    name: 'rpk-terminal-period',
    description: 'Short and flag usage strings do not end with a period',
    severity: 'warning',
    check: (decl) => {
      if (decl.meta.kind !== 'short' && decl.meta.kind !== 'flag') return []
      const text = (decl.string || '').trim()
      if (!text) return []
      if (/\.$/.test(text)) {
        const what = decl.meta.kind === 'flag' ? 'Flag usage' : 'Short'
        return [{ message: `${what} ends with a period: "...${text.slice(-50)}". The rpk convention is no terminal period; formatDescription adds one where the output needs it.` }]
      }
      return []
    }
  },
  {
    name: 'rpk-long-allcaps-heading',
    description: 'ALLCAPS line in Long becomes a === heading in the docs',
    severity: 'info',
    check: (decl) => {
      if (decl.meta.kind !== 'long' || !decl.string) return []
      const issues = []
      const lines = decl.string.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (isHeadingLine(lines, i)) {
          issues.push({ message: `"${lines[i].trim()}" is an ALLCAPS line, which formatDescription promotes to a "===" heading on the docs page. Keep it if a section heading is intended; reword it if not.` })
        }
      }
      return issues
    }
  },
  {
    name: 'rpk-long-block-delimiter',
    description: 'A standalone ==== or ---- line in Long breaks AsciiDoc blocks',
    severity: 'warning',
    check: (decl) => {
      if (decl.meta.kind !== 'long' || !decl.string) return []
      const issues = []
      const lines = decl.string.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (!/^\s*(={4,}|-{4,})\s*$/.test(lines[i])) continue
        // An underline directly below an ALLCAPS heading is consumed by the
        // section parser; anywhere else it ships as an unterminated AsciiDoc
        // block delimiter and breaks the page.
        if (i > 0 && isHeadingLine(lines, i - 1)) continue
        issues.push({ message: `Line ${i + 1} of Long is a run of "${lines[i].trim()[0]}" characters. Outside a heading underline, this renders as an AsciiDoc block delimiter and breaks the generated page.` })
      }
      return issues
    }
  }
]

module.exports = {
  name: 'rpk',
  convention: CONVENTION,
  extract,
  scanFile,
  rules: RULES,
  // Shorts and flag usages are one-liners by convention; the generic
  // too-short prose rule would flag nearly every conforming declaration.
  skipRules: ['too-short']
}
