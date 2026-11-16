'use strict'

/* The rpk engine of check-reference-values.
 *
 * Two checks, both against one rpk-<version>.json (or the raw docs-data
 * snapshot):
 *
 *   Reference: every rpk invocation in a listing, literal or fenced shell
 *   block, and every backticked `rpk ...` span in prose, is parsed the way
 *   cobra parses it. A subcommand the tree does not have is unknown-command,
 *   a flag no command on the path defines is unknown-flag, and a deprecated
 *   command is a warning that carries its replacement.
 *
 *   Values: a sentence that states a flag's default by hand ("--limit
 *   defaults to 50", a Default column in a flags table) is compared with
 *   what rpkval: renders for that flag, using propval's phrases, value
 *   parser and statuses.
 *
 * Plugin flags scraped from --help (isScraped) are never reported as
 * mismatches or unknown flags, because their data is not reliable enough to
 * fail a build on until DOC-2689.
 */

const {
  walkAdoc,
  PHRASES,
  QUALIFIER_RX,
  HISTORICAL_RX,
  ASSOCIATION_WINDOW,
  splitCells,
  sentenceBounds,
} = require('../migrate-property-values')
const { DEFAULT_EXCLUDE } = require('../migrate-property-refs')
const rpkValues = require('../../extension-utils/rpk-values')
const rpkLinks = require('../../extension-utils/rpk-links')
const shared = require('./shared')
const mentions = require('./mentions')
const oldNames = require('./names')

// rpk redpanda start forwards flags it does not know to Seastar, so they are
// not rpk's to validate. A stopgap until the generator emits passThroughFlags
// on the command; delete this list then.
const PASS_THROUGH_COMMANDS = ['rpk redpanda start']

// Flags cobra adds without the tree listing them: --help on every command,
// and --version and the hidden --print-tree on rpk itself.
const IMPLICIT_FLAGS = new Set(['help'])
const IMPLICIT_ROOT_FLAGS = new Set(['version', 'print-tree'])

// A word after rpk that makes the text English, not a command: an error
// message quoted in backticks (`rpk is not on PATH`).
const ENGLISH_WORDS = new Set(['is', 'isn\'t', 'was', 'will', 'can', 'cannot', 'does', 'doesn\'t', 'not', 'and', 'or', 'the', 'a', 'an', 'to', 'on', 'in', 'of', 'for', 'with', 'has', 'must', 'should'])

const SHELL_LANGUAGES = new Set(['', 'bash', 'sh', 'shell', 'console', 'zsh', 'terminal', 'powershell', 'text'])

const RPK_EXCLUDE = [...DEFAULT_EXCLUDE, 'modules/reference/pages/rpk/', 'modules/reference/partials/rpk-']

const DEFAULT_PHRASES = PHRASES.filter((p) => p.field === 'default')
// "prints at most 50 entries by default", "is 5000 by default": a value then
// "by default". The value is captured.
const TRAILING_DEFAULT_RX = /(?:^|\s)((?:at\s+most\s+|up\s+to\s+|at\s+least\s+)?(?:`[^`]+`|-?\d[\d,]*(?:\.\d+)?(?:\s*[A-Za-z%]+)?|true|false|enabled|disabled|on|off))(?:\s+[a-z]+)?\s+by\s+default\b/gi
// "the default `--x` of 5", "the default `--x` is 5".
const DEFAULT_OF_RX = /\bdefault\s+(`--[a-z][\w.-]*`)\s+(?:of|is)\s+/gi
const { MACRO_VALUE_RX } = shared

/**
 * The language of a block from its style line ([source,bash], [,yaml],
 * ```bash), '' when none is named.
 */
function blockLanguage (style) {
  if (!style) return ''
  const fenced = style.match(/^`{3,}\s*([\w-]*)/)
  if (fenced) return fenced[1].toLowerCase()
  const attrs = style.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim())
  const first = attrs[0]
  if (first === 'source' || first === '') return (attrs[1] || '').toLowerCase()
  if (['listing', 'literal'].includes(first)) return ''
  // [bash] style shorthand, or a role/id only.
  if (/^[\w-]+$/.test(first) && !first.includes('=')) return first.toLowerCase()
  return ''
}

/**
 * Shell-style tokens of one logical command line. Quotes are respected; a
 * comment, a callout, or the end of the line ends the tokens. Operators are
 * their own tokens.
 *
 * @param {string} text
 * @param {number[]} [lineOf] - Map from character offset to line index.
 * @returns {{type: 'word'|'op', value: string, raw: string, start: number, quoted?: boolean}[]}
 */
function shellTokens (text) {
  const tokens = []
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (/\s/.test(ch)) { i++; continue }
    // A comment starts at an unquoted # after whitespace or at the start.
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) break
    const rest = text.slice(i)
    if (/^<\d+>(\s|$)/.test(rest) || /^\(\d+\)(\s|$)/.test(rest)) break
    const op = rest.match(/^(?:&&|\|\||\$\(|2>&1|&>|>>|2>|[|;)`>&<])/)
    if (op) {
      tokens.push({ type: 'op', value: op[0], raw: op[0], start: i })
      i += op[0].length
      continue
    }
    let value = ''
    let quoted = false
    const start = i
    while (i < n) {
      const c = text[i]
      if (/\s/.test(c) || '|;)`&<>'.includes(c) || (c === '$' && text[i + 1] === '(')) {
        // A > or & inside a word (key=a>b is rare) still ends it; $( starts a
        // substitution only at a word start.
        break
      }
      if (c === "'") {
        quoted = true
        const end = text.indexOf("'", i + 1)
        if (end === -1) { value += text.slice(i + 1); i = n; break }
        value += text.slice(i + 1, end)
        i = end + 1
        continue
      }
      if (c === '"') {
        quoted = true
        let j = i + 1
        while (j < n && text[j] !== '"') {
          if (text[j] === '\\' && j + 1 < n) { value += text[j + 1]; j += 2; continue }
          value += text[j]
          j++
        }
        i = j + 1
        continue
      }
      if (c === '\\' && i + 1 < n) { value += text[i + 1]; i += 2; continue }
      value += c
      i++
    }
    tokens.push({ type: 'word', value, raw: text.slice(start, i), start, quoted })
  }
  return tokens
}

// An opaque word: a placeholder, an attribute reference, a variable, an
// ellipsis, or alternatives written with a slash in prose (list/delete).
// Never a command.
const isOpaque = (word) => /^<[^>]*>$|\{[\w-]+\}|^\$\{?\w+\}?|\.\.\.|^\[.*\]$|^[a-z][\w-]*(?:\/[a-z][\w-]*)+$/.test(word)
const isFlagToken = (word) => /^--?[A-Za-z]/.test(word)

// Where an rpk invocation may start: the start, a prompt, an operator,
// sudo, or -- (kubectl exec ... -- rpk).
function invocationStarts (tokens) {
  const starts = []
  tokens.forEach((t, i) => {
    if (t.type !== 'word' || t.raw !== 'rpk') return
    const prev = tokens[i - 1]
    if (!prev) return starts.push(i)
    if (prev.type === 'op' && ['|', '&&', '||', ';', '$(', '`'].includes(prev.value)) return starts.push(i)
    if (prev.type === 'word' && (prev.raw === 'sudo' || prev.raw === '--')) return starts.push(i)
    if (i === 1 && prev.type === 'word' && ['$', '#', '>', '%'].includes(prev.raw)) return starts.push(i)
    if (i === 1 && prev.type === 'op' && prev.value === '>') return starts.push(i)
  })
  return starts
}

/**
 * Parse one invocation, from the token after rpk to the end of the command.
 *
 * @returns {{names: string[], nodes: object[], node: object, flags: object[], problem?: object, stoppedAt?: string}}
 *   flags: {name, short, value, hasValue, token, at: {names, nodes}}
 */
function parseInvocation (tree, tokens, deprecatedCommands, { isScrapedPath = () => false } = {}) {
  let node = tree
  const nodes = []
  const names = []
  const flags = []
  // The token each command name was written as, which may be an alias.
  const commandTokens = []
  let problem
  let positional = false
  const findAny = (name, short) => {
    // For deciding whether a flag takes a value: the flag wherever it is on
    // the path so far, or a global flag.
    const key = short ? name : name
    for (let i = nodes.length - 1; i >= 0; i--) {
      const f = rpkValues.flagOn(nodes[i], key)
      if (f) return f
    }
    return rpkValues.flagOn({ flags: tree.global_flags || [] }, key)
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type === 'op') break
    const word = t.value
    if (word === '--' && !t.quoted) break
    if (!t.quoted && isFlagToken(word) && !/^-\d/.test(word)) {
      const at = { names: [...names], nodes: [...nodes] }
      if (word.startsWith('--')) {
        const eq = word.indexOf('=')
        const name = eq === -1 ? word.slice(2) : word.slice(2, eq)
        let value
        let hasValue = eq !== -1
        if (hasValue) value = word.slice(eq + 1)
        else {
          const next = tokens[i + 1]
          const flag = findAny(name, false)
          const nextIsValue = next && next.type === 'word' && !(isFlagToken(next.value) && !/^-\d/.test(next.value) && !next.quoted)
          const takes = flag ? flag.type !== 'bool' : !(next && rpkValues.childOf(node, next.value))
          if (nextIsValue && takes) {
            value = next.value
            hasValue = true
            i++
          }
        }
        flags.push({ name, short: false, value, hasValue, token: t, at })
      } else {
        const short = word[1]
        let value
        let hasValue = word.length > 2
        if (hasValue) value = word.slice(2).replace(/^=/, '')
        else {
          const next = tokens[i + 1]
          const flag = findAny(short, true)
          const nextIsValue = next && next.type === 'word' && !(isFlagToken(next.value) && !/^-\d/.test(next.value) && !next.quoted)
          const takes = flag ? flag.type !== 'bool' : !(next && rpkValues.childOf(node, next.value))
          if (nextIsValue && takes) {
            value = next.value
            hasValue = true
            i++
          }
        }
        flags.push({ name: short, short: true, value, hasValue, token: t, at })
      }
      continue
    }
    if (positional) continue
    if (isOpaque(word) || t.quoted) {
      positional = true
      continue
    }
    const child = rpkValues.childOf(node, word)
    if (child) {
      node = child
      nodes.push(child)
      names.push(child.name)
      commandTokens.push(t)
      continue
    }
    // cobra's own help command, on every command with subcommands.
    if (word === 'help') break
    if (!names.length && ENGLISH_WORDS.has(word.toLowerCase())) {
      problem = { kind: 'not-a-command', token: t, typed: [word] }
      break
    }
    const deprecated = rpkValues.deprecatedEntry(deprecatedCommands, [...names, word])
    if (deprecated) {
      // The deprecated command is the longest deprecated_commands key the
      // words that follow extend it to (rpk redpanda admin brokers); the
      // tokens after it are its flags and arguments.
      const following = []
      for (const next of tokens.slice(i + 1)) {
        if (next.type !== 'word' || next.quoted || isFlagToken(next.value) || isOpaque(next.value)) break
        following.push(next)
      }
      let entry = deprecated
      let words = [t]
      for (let n = following.length; n >= 1; n--) {
        const longer = rpkValues.deprecatedEntry(deprecatedCommands, [...names, word, ...following.slice(0, n).map((x) => x.value)])
        if (longer && longer.key.split(' ').length === names.length + 2 + n) {
          entry = longer
          words = [t, ...following.slice(0, n)]
          break
        }
      }
      const last = tokens.indexOf(words[words.length - 1])
      problem = { kind: 'deprecated-command', token: t, typed: [...names, ...words.map((x) => x.value)], entry, commandTokens: [...commandTokens, ...words], after: tokens.slice(last + 1) }
      break
    }
    const children = Array.isArray(node.commands) ? node.commands : []
    if (children.length && !rpkValues.acceptsPositional(node, names)) {
      if (children.every((c) => rpkValues.PLUGIN_SHIM_COMMANDS.has(c.name))) {
        problem = { kind: 'runtime-plugin', token: t, typed: [...names, word] }
      } else if (names.length && isScrapedPath(names)) {
        // A scraped plugin tree is the plugin release the snapshot installed,
        // which can trail the docs: not reliable enough to call a command
        // unknown.
        problem = { kind: 'plugin-command-not-in-data', token: t, typed: [...names, word] }
      } else {
        problem = { kind: 'unknown-command', token: t, typed: [...names, word], suggestions: require('../../extension-utils/attachment-datasets').suggest(word, children.flatMap((c) => [c.name, ...(c.aliases || [])])) }
      }
      break
    }
    positional = true
  }
  return { names, nodes, node, flags, problem, commandTokens }
}

/**
 * Resolve one flag of a parsed invocation, in the order cobra could accept
 * it: the final command, the node where it was written, the global flags.
 *
 * @returns {{flag?: object, global?: boolean, status: 'ok'|'ancestor'|'pass-through'|'plugin'|'unknown', defined?: string[]}}
 */
function resolveInvocationFlag (registry, parsed, f) {
  const tree = registry.data.tree
  const { node, nodes, names } = parsed
  if (!f.short && IMPLICIT_FLAGS.has(f.name)) return { status: 'ok', implicit: true }
  if (!f.short && !names.length && IMPLICIT_ROOT_FLAGS.has(f.name)) return { status: 'ok', implicit: true }
  if (f.short && f.name === 'h') return { status: 'ok', implicit: true }
  const own = node !== tree ? rpkValues.flagOn(node, f.name) : undefined
  if (own) return { status: 'ok', flag: own, global: false }
  const appearedOn = f.at.nodes[f.at.nodes.length - 1]
  const there = appearedOn ? rpkValues.flagOn(appearedOn, f.name) : undefined
  if (there) return { status: 'ok', flag: there, global: false, on: f.at.names }
  const global = rpkValues.flagOn({ flags: tree.global_flags || [] }, f.name)
  if (global) return { status: 'ok', flag: global, global: true }
  const ancestor = rpkValues.ancestorFlag(nodes, names, f.name)
  if (ancestor) return { status: 'ancestor', flag: ancestor.flag, defined: ancestor.names }
  const command = ['rpk', ...names].join(' ')
  if (PASS_THROUGH_COMMANDS.includes(command) || nodes.some((n) => n.passThroughFlags === true)) return { status: 'pass-through' }
  if (rpkValues.isScraped(registry, names)) return { status: 'plugin' }
  // The command's own usage line names it (rpk security user create [USER] -p [PASS]).
  const token = f.short ? `-${f.name}` : `--${f.name}`
  if (node !== tree && typeof node.usage === 'string' && node.usage.split(/[\s[\]=]+/).includes(token)) return { status: 'usage' }
  return { status: 'unknown' }
}

const cmd = (words) => ['rpk', ...words].join(' ')

/**
 * Whether flags and words after a deprecated command fit its replacement:
 * the flags the replacement lacks, and whether a word other than a flag's
 * value follows.
 */
function afterDeprecated (registry, replacement, tokens) {
  const tree = registry.data.tree
  const flags = []
  let extra = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type === 'op') break
    if (t.quoted || !isFlagToken(t.value) || /^-\d/.test(t.value)) {
      extra = true
      continue
    }
    const long = t.value.startsWith('--')
    const name = long ? t.value.slice(2).split('=')[0] : t.value[1]
    flags.push(name)
    const found = replacement && (replacement.names.length ? rpkValues.findFlag(replacement.node, name, tree) : rpkValues.findFlag(tree, name, tree))
    const inline = long ? t.value.includes('=') : t.value.length > 2
    if (found && found.flag.type !== 'bool' && !inline) i++
  }
  return { flags, extra }
}

// How far around a line an old name's main name counts as already written.
const NEARBY_LINES = 6

// A placeholder (<topic>) as an opaque word of the same length, so token
// offsets stay offsets into the line.
const opaquePlaceholders = (text) => text.replace(/<\w[^<>`]*>/g, (m) => `{${'p'.repeat(m.length - 2)}}`)

/**
 * The old names on a prose line: backticked rpk spans and rpkcmd:/rpkval:
 * macros that write a command with an alias (status alias) or name a
 * deprecated command (reference warning), each with what to write instead
 * and whether --write may (names.js).
 *
 * @returns {object[]} findings, with start, end and proposed for a rewrite.
 */
function nameFindings (line, { index, relative, registry, version, nearby = line, elsewhere = '', historical = false }) {
  const tree = registry.data.tree
  const deprecated = registry.data.deprecated_commands
  const out = []
  const base = { file: relative, line: index + 1, text: line.trim(), kind: 'rpk', check: 'name' }
  const allowed = oldNames.lineAllowsRewrite(line)
  const ranges = mentions.linkRanges(line)
  const inMacro = (start, end) => ranges.some(([a, b]) => start >= a && end <= b)
  // The main or replacement name already written near the line: a list or
  // table that names both (broker-admin.adoc lists rpk cluster info and its
  // alias rpk cluster metadata), where a rewrite would repeat a row.
  const nearbyHas = (command) => new RegExp(`${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-]|[ \\t]+[a-z])`).test(nearby)
  // The old name written elsewhere on the page, such as in an example to run.
  const elsewhereHas = (command) => new RegExp(`${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}(?![\\w-])`).test(elsewhere)
  const decide = (f, writable, why, main) => {
    if (!f.proposed) return { ...f, writable: false }
    if (!writable) return { ...f, writable: false, note: why ? `${f.note}; ${why}` : f.note }
    if (historical) return { ...f, writable: false, note: `${f.note}; release, upgrade and migration notes record the names of their time, so --write leaves them` }
    if (!allowed.writable) return { ...f, writable: false, note: `${f.note}; ${allowed.note}` }
    if (main && nearbyHas(main)) return { ...f, writable: false, note: `${f.note}; ${main} is already written within ${NEARBY_LINES} lines, so the old name may be listed on purpose; change it by hand` }
    if (f.typed && elsewhereHas(f.typed)) return { ...f, writable: false, note: `${f.note}; the page also writes ${f.typed} elsewhere, such as in an example, so change them together by hand` }
    return { ...f, writable: true }
  }
  const aliasFinding = ({ start, end, written, proposed, typed, main, macro }) => decide({
    ...base,
    status: oldNames.STATUS,
    reason: 'alias',
    severity: 'warning',
    command: main,
    typed,
    token: typed,
    written,
    proposed,
    target: macro ? undefined : main,
    rename: { before: written, after: proposed, links: 'same' },
    start,
    end,
    note: `${rpkLinks.aliasNote(typed.split(' ').slice(1), main.split(' ').slice(1))}`,
  }, true, undefined, main)
  const deprecatedFinding = ({ start, end, written, proposed, typed, entry, advice, macro }) => decide({
    ...base,
    status: 'reference',
    reason: 'deprecated-command',
    severity: 'warning',
    command: typed,
    typed,
    token: typed,
    written,
    proposed: advice.writable ? proposed : undefined,
    replacement: advice.replacement,
    target: macro ? undefined : typed,
    rename: { before: written, after: proposed, links: 'any' },
    start,
    end,
    note: `${entry.key} is deprecated in rpk ${version}${!advice.replacement ? (entry.deprecatedMessage ? `: ${entry.deprecatedMessage}` : '') : advice.writable ? `; its replacement is ${advice.replacement}` : `; ${advice.why}`}`,
  }, advice.writable, undefined, advice.replacement)

  // Backticked spans.
  for (const span of shared.backtickSpans(line)) {
    if (!/^rpk\s/.test(span.text) || inMacro(span.start, span.end)) continue
    const tokens = shellTokens(opaquePlaceholders(span.text))
    const written = line.slice(span.start, span.end)
    const at = span.innerStart - span.start
    const swap = (tokens, words) => {
      // The span with the tokens from first to last replaced by words.
      const first = tokens[0]
      const last = tokens[tokens.length - 1]
      return written.slice(0, at + first.start) + words + written.slice(at + last.start + last.raw.length)
    }
    for (const start of invocationStarts(tokens)) {
      const parsed = parseInvocation(tree, tokens.slice(start + 1), deprecated, { isScrapedPath: (n) => rpkValues.isScraped(registry, n) })
      const p = parsed.problem
      if (p && p.kind === 'not-a-command') continue
      const aliased = parsed.commandTokens.filter((t, i) => t.value !== parsed.names[i])
      if (aliased.length) {
        const words = parsed.commandTokens.map((t, i) => (t.value !== parsed.names[i] ? parsed.names[i] : t.raw))
        const region = parsed.commandTokens
        // Keep whatever sits between command words (rarely a flag) as written.
        let replaced = ''
        region.forEach((t, i) => {
          replaced += words[i]
          if (i < region.length - 1) replaced += span.text.slice(t.start + t.raw.length, region[i + 1].start)
        })
        out.push(aliasFinding({
          start: span.start,
          end: span.end,
          written,
          proposed: swap(region, replaced),
          typed: cmd(parsed.commandTokens.map((t) => t.value)),
          main: cmd(parsed.names),
        }))
      }
      if (p && p.kind === 'deprecated-command') {
        const keyNames = String(p.entry.key).split(' ').slice(1)
        const replacement = rpkLinks.replacementCommand(registry, p.entry.replacement)
        const after = afterDeprecated(registry, replacement, p.after)
        const advice = rpkLinks.deprecationAdvice({ registry, entry: p.entry, typed: keyNames, flags: after.flags, extra: after.extra })
        out.push(deprecatedFinding({
          start: span.start,
          end: span.end,
          written,
          proposed: advice.names ? swap(p.commandTokens, advice.names.join(' ')) : undefined,
          typed: cmd(p.typed),
          entry: p.entry,
          advice,
        }))
      }
    }
  }

  // rpkcmd:[...], rpkval:[...] and rpkval::[...]: the command line before
  // the first comma.
  const macroCall = (start, end, written, tokens, rewrite, flag) => {
    const resolved = rpkValues.resolveCommand(tree, tokens, deprecated)
    if (resolved.ok && resolved.aliases.length) {
      out.push(aliasFinding({ start, end, written, proposed: rewrite({ words: resolved.aliases }), typed: cmd(tokens.slice(0, resolved.names.length)), main: cmd(resolved.names), macro: true }))
    }
    if (!resolved.ok && resolved.kind === 'deprecated-command') {
      const keyNames = String(resolved.entry.key).split(' ').slice(1)
      const advice = rpkLinks.deprecationAdvice({ registry, entry: resolved.entry, typed: keyNames, flags: flag ? [flag.replace(/^-+/, '')] : [], extra: resolved.typed.length > keyNames.length })
      out.push(deprecatedFinding({ start, end, written, proposed: advice.names ? rewrite({ span: { from: 0, to: keyNames.length, names: advice.names } }) : undefined, typed: cmd(resolved.typed), entry: resolved.entry, advice, macro: true }))
    }
  }
  for (const m of line.matchAll(/\b(rpkcmd|rpkval)(::?)\[((?:\\\]|[^\]])*)\]/g)) {
    const commandLine = m[3].split(',')[0]
    const rest = m[3].slice(commandLine.length)
    const parsed = rpkValues.parseCommandLine(commandLine)
    if (parsed.extra.length) continue
    macroCall(m.index, m.index + m[0].length, m[0], parsed.tokens, (how) => {
      const rewritten = rpkLinks.rewriteCommandWords(commandLine, how)
      return rewritten === undefined ? undefined : `${m[1]}${m[2]}[${rewritten}${rest}]`
    }, parsed.flag)
  }
  for (const m of line.matchAll(/\brpkval:(-{0,2}[\w.-]+)\[([^\]]*)\]/g)) {
    const attr = m[2].match(/(^|,)(\s*command=)("[^"]*"|[^,\]]*)/)
    if (!attr) continue
    const valueStart = attr.index + attr[1].length + attr[2].length
    macroCall(m.index, m.index + m[0].length, m[0], rpkValues.commandTokens(attr[3]), (how) => {
      const rewritten = rpkLinks.rewriteCommandWords(attr[3], how)
      return rewritten === undefined ? undefined : `rpkval:${m[1]}[${m[2].slice(0, valueStart)}${rewritten}${m[2].slice(valueStart + attr[3].length)}]`
    }, `--${m[1].replace(/^-+/, '')}`)
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * The rpk engine. Scans one checkout against one rpk registry.
 *
 * @param {object} opts
 * @param {string} opts.docsDir
 * @param {object} opts.registry - {tag, data, surface, ...}
 * @param {string[]} [opts.files]
 * @param {boolean} [opts.write]
 * @param {(file: string, original: string, replaced: string) => boolean} [opts.renderGuard]
 * @param {object} [opts.single] - {tagged, partial} for the single-sourcing guard.
 * @param {object} [opts.links] - {catalog, component, version, skip, cloud}:
 *   check hand-written xrefs to rpk reference pages against the pages in
 *   catalog, as the scanned component renders them, except in the files in
 *   skip. cloud ({component, version}) is the one Cloud lender, which renders
 *   a self-managed file's ifdef::env-cloud[] content. With links, the first
 *   unlinked mention of each command on a page is reported (mentions.js),
 *   over links.pages, the rendered pages (page-order.js).
 * @param {boolean} [opts.writeLinks] - With write, also turn unlinked
 *   mentions into rpkcmd:[...].
 */
function scanRpk ({ docsDir, registry, files: only, write = false, writeLinks = false, renderGuard, readFile = shared.readText, writeFile, links }) {
  const fsPath = require('path')
  const tree = registry.data.tree
  const cloudSurface = registry.surface === 'cloud'
  const findings = []
  let files = 0
  let skippedGenerated = 0
  let skippedStubs = 0
  let changedFiles = 0
  const counts = { examplesRestatingDefault: 0 }
  const version = registry.data.rpk_version || registry.tag
  const allFlags = rpkValues.allFlagNames(registry)

  // The commands a line names, as the scope that renders it links them: a
  // self-managed file's ifdef::env-cloud[] content as the Cloud lender does,
  // and not at all without one.
  const scopeOf = (ctx, cloud) => {
    if (!links) return undefined
    if (cloud || ctx.qualifier !== 'ifdef::env-cloud') return links
    return links.cloud ? { ...links, ...links.cloud } : undefined
  }
  const lineMentions = (index, line, ctx, cloud = cloudSurface) => {
    const scope = scopeOf(ctx, cloud)
    return scope ? mentions.rpkMentions(line, { registry, catalog: scope.catalog, component: scope.component, version: scope.version }) : []
  }
  const judge = links
    ? mentions.mentionJudge({
      pages: links.pages,
      collect: (file) => mentions.collectMentions(file.text, { cloudSurface: file.repo === 0 ? cloudSurface : Boolean(file.cloud), lineMentions: (index, line, ctx) => lineMentions(index, line, ctx, file.repo === 0 ? cloudSurface : Boolean(file.cloud)) }),
      linkedOn: (file, line) => mentions.rpkLinked(line, {
        tree,
        deprecated: registry.data.deprecated_commands,
        catalog: links.catalog,
        component: file.repo === 0 || file.component === undefined ? links.component : file.component,
        version: file.repo === 0 || file.component === undefined ? links.version : file.version,
        module: (file.relative.match(/^modules\/([^/]+)\//) || [])[1] || 'ROOT',
        aliases: links.aliases,
      }),
      historical: (relative) => HISTORICAL_RX.test(relative) || shared.RELEASES_RX.test(relative),
      ownPage: (file, m) => {
        const page = file.relative.match(/^modules\/reference\/pages\/(rpk\/.+)$/)
        const command = page && rpkLinks.commandOfPage(tree, page[1])
        return Boolean(command) && command.names.join(' ') === m.key
      },
    })
    : undefined

  for (const relative of shared.walkFiles(docsDir, { exclude: RPK_EXCLUDE, only })) {
    const full = fsPath.join(docsDir, relative)
    const original = readFile(full)
    if (shared.isGenerated(original)) { skippedGenerated++; continue }
    if (shared.isStubPage(original)) { skippedStubs++; continue }
    files++
    const historical = HISTORICAL_RX.test(relative) || shared.RELEASES_RX.test(relative)
    const tagged = /^\s*\/\/\s*tag::[^[\s]+\[\]\s*$/m.test(original) || /(?:^|\/)partials\//.test(relative)
    const lines = original.split('\n')
    // Lines a // value-check: ignore comment covers are reported (and then
    // dropped by the orchestrator) but never rewritten.
    const ignored = shared.ignoredLines(original)
    const fileFindings = []
    const seen = new Set()
    const sightings = commandSightings(lines, registry)
    // Unlinked mentions: the first of each command on a page that links it
    // nowhere, never in a nav file or release or upgrade notes.
    const mentionsOn = Boolean(links) && !historical && !(links.skip && links.skip.has(relative))
    const noMention = mentionsOn ? mentions.skippedLines(lines) : undefined
    // Level 1 and 2 headings bound the section a flag mention looks back in.
    const headings = []
    lines.forEach((l, i) => { if (/^={2,3}\s/.test(l)) headings.push(i) })
    const sectionStartOf = (i) => {
      let start
      for (const h of headings) if (h <= i) start = h
      return start
    }

    const reference = (line, problem) => {
      const key = `${line}:${problem.reason}:${problem.token || ''}`
      if (seen.has(key)) return
      seen.add(key)
      fileFindings.push({ file: relative, line: line + 1, text: lines[line].trim(), kind: 'rpk', status: problem.status || 'reference', ...problem })
    }

    // Parse one invocation's tokens and report reference problems.
    const checkInvocation = (tokens, lineOfToken, { example = false, prose = false } = {}) => {
      const parsed = parseInvocation(tree, tokens, registry.data.deprecated_commands, { isScrapedPath: (names) => rpkValues.isScraped(registry, names) })
      const command = cmd(parsed.names)
      if (parsed.problem) {
        const p = parsed.problem
        const typed = cmd(p.typed)
        // A prose span's deprecated command is a name finding (nameFindings).
        if (p.kind === 'deprecated-command' && prose) return parsed
        if (p.kind === 'deprecated-command') {
          const why = p.entry.replacement || p.entry.deprecatedMessage
          reference(lineOfToken(p.token), { reason: 'deprecated-command', severity: 'warning', command: typed, token: p.token.value, note: `${p.entry.key} is deprecated in rpk ${version}${why ? `: ${why}` : ''}` })
        } else if (p.kind === 'not-a-command') {
          return parsed
        } else if (p.kind === 'plugin-command-not-in-data') {
          reference(lineOfToken(p.token), { status: 'unverifiable', reason: 'plugin-command-not-in-data', command: typed, token: p.token.value, note: `${typed} is not in the --help scrape of the ${p.typed[0]} plugin (${registry.data.plugin_versions && registry.data.plugin_versions[p.typed[0]] ? `version ${registry.data.plugin_versions[p.typed[0]]}` : 'version unknown'})` })
        } else if (p.kind === 'runtime-plugin') {
          reference(lineOfToken(p.token), { status: 'unverifiable', reason: 'runtime-plugin', command: typed, token: p.token.value, note: `${command} installs its subcommands at run time; ${typed} is not in the data` })
        } else {
          reference(lineOfToken(p.token), { reason: 'unknown-command', severity: 'error', command: typed, token: p.token.value, note: `${command} has no subcommand '${p.token.value}' in rpk ${version}${p.suggestions.length ? `. Did you mean: ${p.suggestions.join(', ')}?` : ''}` })
        }
        return parsed
      }
      for (const f of parsed.flags) {
        const resolved = resolveInvocationFlag(registry, parsed, f)
        const flagText = f.short ? `-${f.name}` : `--${f.name}`
        const at = lineOfToken(f.token)
        if (resolved.status === 'unknown') {
          reference(at, { reason: 'unknown-flag', severity: 'error', command, flag: f.name, token: flagText, note: `${flagText} is not documented for ${command} in rpk ${version}; it may be hidden or legacy` })
        } else if (resolved.status === 'ancestor') {
          reference(at, { status: 'unverifiable', reason: 'ancestor-flag', command, flag: f.name, token: flagText, note: `${flagText} is defined on ${cmd(resolved.defined)}, probably as a persistent flag` })
        } else if (resolved.status === 'pass-through') {
          reference(at, { status: 'unverifiable', reason: 'pass-through', command, flag: f.name, token: flagText, note: `${command} passes flags it does not know through to Redpanda` })
        } else if (resolved.status === 'usage') {
          reference(at, { status: 'unverifiable', reason: 'usage-flag', command, flag: f.name, token: flagText, note: `${flagText} is not a flag in the data, but the usage line of ${command} names it` })
        } else if (resolved.status === 'plugin') {
          reference(at, { status: 'unverifiable', reason: 'plugin-flag-not-in-data', command, flag: f.name, token: flagText, note: `${flagText} is not in the --help scrape of the ${parsed.names[0]} plugin` })
        } else if (example && resolved.flag && f.hasValue && !rpkValues.isScraped(registry, parsed.names, resolved.flag)) {
          const def = rpkValues.formatFlagDefault(resolved.flag)
          if (def.ok && def.text === f.value) counts.examplesRestatingDefault++
        }
      }
      return parsed
    }

    const checkLineInvocations = (text, lineOfToken, opts) => {
      const tokens = shellTokens(text)
      // parseInvocation stops at the first operator, so each start only
      // needs the tokens after it.
      for (const start of invocationStarts(tokens)) checkInvocation(tokens.slice(start + 1), lineOfToken, opts)
    }

    const onBlock = (b) => {
      if (!SHELL_LANGUAGES.has(blockLanguage(b.style))) return
      // Join \ continuations into logical lines, keeping each token's line.
      let text = ''
      let map = []
      const flush = () => {
        if (text.trim()) {
          const prompt = text.match(/^\s*(?:[$#>%]\s+)/)
          const body = prompt ? text.slice(prompt[0].length) : text
          const offset = prompt ? prompt[0].length : 0
          const lineMap = map
          checkLineInvocations(body, (token) => lineMap[Math.min(token.start + offset, lineMap.length - 1)], { example: true })
        }
        text = ''
        map = []
      }
      for (const { index, text: raw } of b.lines) {
        const continued = /\\\s*$/.test(raw)
        const piece = continued ? raw.replace(/\\\s*$/, ' ') : raw
        for (let k = 0; k < piece.length; k++) map.push(index)
        text += piece
        if (!continued) flush()
      }
      flush()
    }

    const proseLine = (index, line, ctx, table) => {
      // Reference check of backticked rpk spans.
      for (const span of shared.backtickSpans(line)) {
        if (!/^rpk\s/.test(span.text)) continue
        checkLineInvocations(span.text, () => index, { prose: true })
      }
      // Aliases and deprecated commands in spans and macros.
      const named = nameFindings(line, { index, relative, registry, version, nearby: lines.slice(Math.max(0, index - NEARBY_LINES), index + NEARBY_LINES + 1).join('\n'), elsewhere: [...lines.slice(0, index), ...lines.slice(index + 1)].join('\n'), historical })
      if (ctx.hidden) {
        for (const f of named) {
          delete f.start
          delete f.end
          delete f.rename
          fileFindings.push(f)
        }
        return line
      }
      const claims = table ? tableClaims(index, line, ctx, registry) : proseClaims(index, line, ctx)
      let rewritten = line
      // A self-managed file's ifdef::env-cloud[] content renders only where
      // Cloud includes the file, so its links are checked as the Cloud
      // lender renders them, and not at all without one.
      const cloudOnly = !cloudSurface && ctx.qualifier === 'ifdef::env-cloud'
      const linkScope = links && cloudOnly ? (links.cloud ? { ...links, ...links.cloud } : undefined) : links
      const lineFindings = linkScope && !(links.skip && links.skip.has(relative))
        ? linkFindings(line, { index, relative, registry, links: linkScope, historical })
        : []
      lineFindings.push(...named)
      for (const claim of claims) {
        const finding = classifyClaim(claim, { index, line, ctx, sightings, registry, allFlags, historical, tagged, cloudSurface, relative, table, sectionStart: sectionStartOf(index) })
        if (finding) lineFindings.push(finding)
      }
      if (mentionsOn && !noMention.has(index) && !ignored.has(index + 1)) {
        for (const m of lineMentions(index, line, ctx)) {
          const verdict = judge(relative, original, index, m)
          if (verdict) lineFindings.push(mentions.toFinding(m, { kind: 'rpk', relative, index, line, historical, verdict }))
        }
      }
      let appliedFrom = Infinity
      for (const f of [...lineFindings].sort((a, b) => b.start - a.start)) {
        if (write && (f.autoSafe || f.writable || (writeLinks && f.linkable)) && !ignored.has(index + 1)) {
          // Two findings over the same text: the later one wins.
          if (f.end > appliedFrom) continue
          const candidate = rewritten.slice(0, f.start) + f.proposed + rewritten.slice(f.end)
          if (renderGuard && !renderGuard(relative, rewritten, candidate, f.rename)) {
            f.autoSafe = false
            f.applied = false
            if (f.linkable) f.linkable = false
            if (f.writable) {
              f.writable = false
              f.note = `${f.note}; render-changed`
            } else f.note = 'render-changed'
            continue
          }
          rewritten = candidate
          f.applied = true
          appliedFrom = f.start
        }
      }
      for (const f of lineFindings) {
        delete f.start
        delete f.end
        delete f.rename
        fileFindings.push(f)
      }
      return rewritten
    }

    const out = walkAdoc(original, {
      onBlock,
      onProse: (index, line, ctx) => {
        if (ctx.inner !== undefined) {
          const inner = proseLine(index, ctx.inner, { ...ctx }, false)
          return inner === ctx.inner ? line : line.slice(0, ctx.offset) + inner + line.slice(ctx.offset + ctx.inner.length)
        }
        return proseLine(index, line, ctx, false)
      },
      onTableLine: (index, line, ctx) => proseLine(index, line, ctx, true),
    }, { cloudSurface, newTable: () => ({ header: undefined, cols: 0, defaultCol: -1, cell: -1, subject: undefined, start: undefined }) })

    if (write && out !== original && !historical) {
      ;(writeFile || require('fs').writeFileSync)(full, out)
      changedFiles++
    }
    findings.push(...fileFindings.sort((a, b) => a.line - b.line))
  }

  const tally = countFindings(findings)
  return {
    files,
    skippedGenerated,
    skippedStubs,
    findings,
    counts: { ...tally, examplesRestatingDefault: counts.examplesRestatingDefault, ...(links ? { ...linkCounts(findings), ...mentions.mentionCounts(findings) } : {}), ...oldNames.nameCounts(findings) },
    changedFiles,
  }
}

/**
 * Counts of the rpk link findings, by what they are.
 */
function linkCounts (findings) {
  const links = findings.filter((f) => f.check === 'link')
  return {
    linksBroken: links.filter((f) => f.reason === 'broken-link').length,
    linksMislabeled: links.filter((f) => f.reason === 'link-label-mismatch').length,
    linksReplaceable: links.filter((f) => f.status === 'exact').length,
    linksNotLoaded: links.filter((f) => f.reason === 'link-target-not-loaded').length,
  }
}

// An xref and its label; the target stops at the bracket.
const XREF_RX = /xref:([^\s[\]]+)\[((?:\\\]|[^\]])*)\]/g

/**
 * The page an xref target names, by Antora's resource ID rules:
 * [version@][component:][module:]relative#fragment. No module means the
 * file's own; no component means the scanned component and version; a
 * component without a version means its latest. Undefined for a target with
 * an attribute reference or a relative path.
 *
 * @returns {{component: string, version: string|undefined, module: string, relative: string, fragment: string, named: boolean, pinned: boolean} | undefined}
 */
function xrefPage (spec, { component, version, module, catalog }) {
  const hash = spec.indexOf('#')
  const id = hash === -1 ? spec : spec.slice(0, hash)
  const fragment = hash === -1 ? '' : spec.slice(hash + 1)
  if (/[{}]/.test(id) || id.startsWith('.')) return undefined
  let rest = id
  let pinned
  const at = rest.indexOf('@')
  if (at !== -1) {
    pinned = rest.slice(0, at)
    rest = rest.slice(at + 1)
  }
  const parts = rest.split(':')
  if (parts.length > 3) return undefined
  const relative = parts.pop()
  const mod = parts.length ? parts.pop() : module
  const named = parts.length ? parts.pop() : undefined
  const comp = named || component
  const ver = pinned !== undefined ? pinned : named ? rpkLinks.latestVersion(catalog, named) : version
  return { component: comp, version: ver, module: mod, relative, fragment, named: Boolean(named), pinned: pinned !== undefined }
}

/**
 * The command an xref label names: its leading backticked rpk span, or the
 * whole label when it is plain text starting with rpk. exact when the label
 * is nothing but that span, naming a command and at most one known flag, as
 * rpkcmd:[...] would render it.
 *
 * @returns {{names: string[], typed: string, flag?: object, exact: boolean} | undefined}
 */
function labelCommand (tree, label) {
  const t = label.trim()
  const span = t.match(/^`(rpk(?:\s[^`]*)?)`/)
  const text = span ? span[1] : (/^rpk(?:\s|$)/.test(t) && !t.includes('`') ? t : undefined)
  if (text === undefined) return undefined
  const words = text.trim().split(/\s+/).slice(1)
  let node = tree
  const names = []
  const nodes = []
  let i = 0
  for (; i < words.length; i++) {
    const child = rpkValues.childOf(node, words[i])
    if (!child) break
    node = child
    names.push(child.name)
    nodes.push(child)
  }
  const rest = words.slice(i)
  // A word where a subcommand belongs: the span check reports it.
  if (rest.length && !isFlagToken(rest[0]) && Array.isArray(node.commands) && node.commands.length && !rpkValues.acceptsPositional(node, names)) return undefined
  const typed = ['rpk', ...words].join(' ')
  let flag
  if (rest.length === 1 && isFlagToken(rest[0])) {
    const found = rpkValues.findFlag(names.length ? node : tree, rest[0].replace(/^-+/, ''), tree)
    flag = found && found.flag
  }
  const exact = Boolean(span) && span[0] === t && (rest.length === 0 || Boolean(flag))
  return { names, typed, flag, exact }
}

/**
 * Findings for the hand-written xrefs to rpk reference pages on one prose
 * line, as the scanned component renders them:
 *
 *   broken-link (reference error): the target page does not exist there,
 *   or the target has no .adoc extension.
 *   link-label-mismatch (reference warning): the label names another
 *   command than the page documents.
 *   exact: the label is the command in backticks and the target is the page
 *   rpkcmd:[...] would link, so --write may replace the xref with the macro,
 *   unless the build has no rpk data attachment for rpkcmd: to link with.
 *   link-target-not-loaded (unverifiable): the target is in a component or
 *   version this scan has not read; pass it with --lender.
 */
function linkFindings (line, { index, relative, registry, links, historical }) {
  const tree = registry.data.tree
  const { catalog, component, version } = links
  const pages = rpkLinks.rpkPageIndex(catalog)
  const module = (relative.match(/^modules\/([^/]+)\//) || [])[1] || 'ROOT'
  const spans = shared.backtickSpans(line)
  const out = []
  for (const m of line.matchAll(XREF_RX)) {
    // An xref shown as code is not a link.
    if (spans.some((sp) => sp.start < m.index && m.index < sp.end)) continue
    const page = xrefPage(m[1], { component, version, module, catalog })
    if (!page || page.module !== rpkLinks.PAGE_MODULE || !page.relative.startsWith('rpk/')) continue
    // With no extension and no fragment, Asciidoctor reads the target as an
    // anchor on this page, so the link goes nowhere.
    const bare = !m[1].includes('#') && !/\.[\w]+$/.test(page.relative)
    if (!bare && !page.relative.endsWith('.adoc')) continue
    const base = { file: relative, line: index + 1, text: line.trim(), kind: 'rpk', check: 'link', target: `xref:${m[1]}`, token: m[1], written: m[0], association: 'link', autoSafe: false, start: m.index, end: m.index + m[0].length }
    if (bare) {
      const fixed = `${page.relative}.adoc`
      const commandPage = rpkLinks.commandOfPage(tree, fixed)
      const command = commandPage ? cmd(commandPage.names) : undefined
      let note = `the target has no .adoc extension, so Asciidoctor links an anchor on this page instead of reference:${fixed}`
      const pick = commandPage && rpkLinks.pickCommandPage(catalog, { component, version, relative: fixed })
      if (pick && pick.ok) note += `; rpkcmd:[${command}] links ${pick.id}`
      out.push({ ...base, status: 'reference', reason: 'broken-link', severity: 'error', command, note })
      continue
    }
    const where = `${page.component}@${page.version || 'unversioned'}`
    const known = page.version !== undefined && (() => {
      const found = typeof catalog.getComponent === 'function' && catalog.getComponent(page.component)
      return Boolean(found) && (found.versions || []).some((v) => (v.version == null ? '' : String(v.version)) === page.version)
    })()
    if (!known) {
      out.push({ ...base, status: 'unverifiable', reason: 'link-target-not-loaded', note: `${page.named ? page.component : where} is not in this scan; pass its checkout with --lender to check the link` })
      continue
    }
    // Antora resolves an xref to a page alias as a link to the page.
    const aliased = !rpkLinks.hasPage(pages, page.component, page.version, page.relative) && links.aliases
      ? links.aliases.get(`${page.component}@${page.version}:${page.relative}`)
      : undefined
    if (aliased) {
      base.alias = page.relative
      page.relative = aliased
    }
    const commandPage = rpkLinks.commandOfPage(tree, page.relative)
    const command = commandPage ? cmd(commandPage.names) : undefined
    if (!rpkLinks.hasPage(pages, page.component, page.version, page.relative)) {
      let note = `${where} has no page reference:${page.relative}`
      if (commandPage) {
        const pick = rpkLinks.pickCommandPage(catalog, { component, version, relative: page.relative })
        if (pick.ok) note += `; rpkcmd:[${command}] links ${pick.id}`
        else if (pick.reason === 'cloud-no-page') note += `; ${component} is Cloud and has no page for ${command}, so rpkcmd:[${command}] renders it as plain code`
        else note += `; no component in this scan has a page for ${command}`
      } else {
        note += `, and the path names no command in rpk ${registry.data.rpk_version || registry.tag}`
      }
      out.push({ ...base, status: 'reference', reason: 'broken-link', severity: 'error', command, note })
      continue
    }
    // index.adoc, rpk-x-options.adoc: a page, not a command.
    if (!commandPage) continue
    const label = labelCommand(tree, m[2])
    const sameCommand = label && label.names.join(' ') === commandPage.names.join(' ')
    // A label of just rpk names the tool ("the `rpk` CLI"), not a command.
    if (label && !sameCommand && label.typed !== 'rpk') {
      out.push({ ...base, status: 'reference', reason: 'link-label-mismatch', severity: 'warning', command, note: `the label names ${cmd(label.names)}, but the link goes to the page for ${command}${base.alias ? ` (through the page alias reference:${base.alias})` : ''}` })
      continue
    }
    // A fragment or a pinned version is a choice rpkcmd: cannot express.
    if (!sameCommand || !label.exact || page.fragment || page.pinned) continue
    const pick = rpkLinks.pickCommandPage(catalog, { component, version, relative: page.relative })
    if (!pick.ok || pick.id !== rpkLinks.resourceId(page)) continue
    const proposed = `rpkcmd:[${label.typed}]`
    const finding = { ...base, status: 'exact', command, target: proposed, dataValue: pick.id, proposed }
    if (label.flag) finding.flag = label.flag.name
    if (historical) finding.note = 'release or upgrade notes: proposed only'
    // --data-file checks the page, but rpkcmd: links only with the build's
    // own rpk data.
    else if (!rpkLinks.loadRpkForLinks(catalog, component, version)) finding.note = 'no rpk data attachment in this build; rpkcmd: would render without a link'
    else {
      finding.autoSafe = true
      if (base.alias) finding.note = `links through the page alias reference:${base.alias}`
    }
    out.push(finding)
  }
  return out
}

/**
 * Where a page names an rpk command: backticked rpk spans, invocations in
 * shell blocks, and xrefs to rpk reference pages. Used to find the command a
 * flag mentioned in prose belongs to.
 *
 * @returns {{line: number, col: number, names: string[], node: object, nodes: object[]}[]}
 */
function commandSightings (lines, registry) {
  const tree = registry.data.tree
  const out = []
  const resolve = (words) => {
    let node = tree
    const nodes = []
    const names = []
    for (const w of words) {
      const child = rpkValues.childOf(node, w)
      if (!child) break
      node = child
      nodes.push(child)
      names.push(child.name)
    }
    return names.length ? { names, node, nodes } : undefined
  }
  let fence = null
  lines.forEach((line, i) => {
    const t = line.trim()
    const d = t.match(/^(-{4,}|\.{4,}|`{3,})/)
    if (d) {
      const f = d[1].startsWith('```') ? '```' : d[1]
      fence = fence === null ? f : (fence === f ? null : fence)
      return
    }
    if (fence !== null) {
      const tokens = shellTokens(t.replace(/^[$#>%]\s+/, ''))
      for (const start of invocationStarts(tokens)) {
        const words = []
        for (const tok of tokens.slice(start + 1)) {
          if (tok.type === 'op' || isFlagToken(tok.value)) break
          words.push(tok.value)
        }
        const r = resolve(words)
        if (r) out.push({ line: i, col: 0, ...r, from: 'block' })
      }
      return
    }
    for (const span of shared.backtickSpans(line)) {
      if (!/^rpk(\s|$)/.test(span.text)) continue
      const words = span.text.split(/\s+/).slice(1).filter((w) => !isFlagToken(w))
      const r = resolve(words)
      if (r) out.push({ line: i, col: span.start, ...r, from: 'span' })
    }
    for (const m of macroCommandLines(line)) {
      const r = resolve(m.parsed.tokens)
      if (r) out.push({ line: i, col: m.start, ...r, from: 'macro' })
    }
    for (const m of line.matchAll(/xref:(?:[\w-]+:)?reference:rpk\/[\w-]+\/(rpk-[\w-]+)\.adoc/g)) {
      const r = resolveDashed(tree, m[1].slice(4))
      if (r) out.push({ line: i, col: m.index, ...r, from: 'xref' })
    }
  })
  return out
}

// rpk-cluster-partitions-move-cancel: command names may themselves hold
// dashes, so take the longest child name that matches at each step.
function resolveDashed (tree, dashed) {
  let node = tree
  const nodes = []
  const names = []
  let rest = dashed
  while (rest) {
    const children = node.commands || []
    const child = children
      .filter((c) => rest === c.name || rest.startsWith(`${c.name}-`))
      .sort((a, b) => b.name.length - a.name.length)[0]
    if (!child) break
    node = child
    nodes.push(child)
    names.push(child.name)
    rest = rest.slice(child.name.length).replace(/^-/, '')
  }
  return names.length && !rest ? { names, node, nodes } : undefined
}

// A flag mention in prose: `--flag`, `--flag value`, or a flag inside a
// backticked rpk span, or an rpkval: macro.
function flagMentions (line) {
  const mentions = []
  for (const span of shared.backtickSpans(line)) {
    const m = span.text.match(/^--([a-z][\w.-]*[a-z0-9])(?:[=\s]|$)/i)
    if (m) mentions.push({ name: m[1], start: span.start, end: span.end, span: true })
    else if (/^rpk\s/.test(span.text)) {
      const words = span.text.split(/\s+/)
      const commandWords = []
      for (const w of words.slice(1)) {
        if (isFlagToken(w)) break
        commandWords.push(w)
      }
      for (const fm of span.text.matchAll(/(?:^|\s)--([a-z][\w.-]*[a-z0-9])/gi)) {
        mentions.push({ name: fm[1], start: span.start, end: span.end, commandWords })
      }
    }
  }
  for (const m of line.matchAll(/rpkval:(-{0,2}[\w.-]+)\[([^\]]*)\]/g)) {
    const command = (m[2].match(/(?:^|,)\s*command=("[^"]*"|[^,\]]*)/) || [])[1]
    mentions.push({ name: m[1].replace(/^-+/, ''), start: m.index, end: m.index + m[0].length, macro: true, commandWords: command !== undefined ? rpkValues.commandTokens(command) : [] })
  }
  for (const m of macroCommandLines(line)) {
    if (!m.parsed.flag || m.parsed.extra.length) continue
    mentions.push({ name: m.parsed.flag.replace(/^-+/, ''), start: m.start, end: m.end, macro: true, commandWords: m.parsed.tokens })
  }
  return mentions.sort((a, b) => a.start - b.start)
}

// The command line of each rpkcmd:[...] and bracket-form rpkval:[...] or
// rpkval::[...] on a line, parsed as the macros parse it.
function macroCommandLines (line) {
  const out = []
  for (const m of line.matchAll(/\b(rpkcmd|rpkval)::?\[([^\]]*)\]/g)) {
    out.push({ macro: m[1], start: m.index, end: m.index + m[0].length, parsed: rpkValues.parseCommandLine(m[2].split(',')[0]) })
  }
  return out
}

/**
 * Default statements on a prose line and the flag mention each belongs to.
 */
function proseClaims (index, line, ctx) {
  const mentions = flagMentions(line)
  const { sentenceAt } = sentenceBounds(line)
  const claims = []
  const claimed = new Set()
  const subject = (() => {
    const lead = line.match(/^\s*(?:[*.-]+\s+|\d+\.\s+)/)
    if (!lead) return undefined
    return mentions.find((m) => m.start === lead[0].length)
  })()

  const ownerOf = (at) => {
    const before = mentions.filter((m) => m.end <= at)
    const mention = before[before.length - 1]
    const others = (m) => mentions.some((x) => x.start >= m.end && x.start < at && x.name !== m.name)
    if (mention && sentenceAt(at) === sentenceAt(mention.end) && at - mention.end <= ASSOCIATION_WINDOW && !others(mention)) {
      return { mention, association: 'same-sentence' }
    }
    if (subject && subject.end <= at && sentenceAt(at) > sentenceAt(subject.end)) return { mention: subject, association: 'list-subject' }
    if (mention && at - mention.end <= ASSOCIATION_WINDOW && !others(mention) && sentenceAt(at) - sentenceAt(mention.end) === 1) {
      return { mention, association: 'previous-sentence' }
    }
    // A statement in a sentence that names no flag, and a next sentence that
    // opens with one: "A listing prints at most 50 entries by default. Pass
    // `--limit 0` to return everything."
    const own = sentenceAt(at)
    if (!mentions.some((m) => sentenceAt(m.start) === own)) {
      const next = mentions.find((m) => sentenceAt(m.start) === own + 1)
      const sentenceStart = (() => {
        for (let k = at; k < line.length; k++) if (sentenceAt(k) === own + 1) return k
        return -1
      })()
      if (next && sentenceStart !== -1 && next.start - sentenceStart <= 40) return { mention: next, association: 'next-sentence' }
    }
    return undefined
  }

  const add = (owner, phrase, valueStart) => {
    if (!owner || claimed.has(valueStart)) return
    const { parsed, skip } = shared.parseAfterFiller(line.slice(valueStart))
    if (!parsed) return
    // A value macro is the macro already, not a hand-written value.
    if (MACRO_VALUE_RX.test(line.slice(valueStart + skip))) return
    // "defaults to `--other-flag`" is a reference, not a value.
    if (/^--/.test(parsed.string || '')) return
    claimed.add(valueStart)
    const sentence = sentenceBounds(line)
    const context = sentence.text(Math.min(sentenceAt(owner.mention.start), sentenceAt(valueStart)), Math.max(sentenceAt(owner.mention.start), sentenceAt(valueStart)))
    const ownSentence = sentence.text(sentenceAt(valueStart), sentenceAt(valueStart))
    const stripped = context.replace(/\brpkval::?[^[\s]*\[[^\]]*\]/g, 'rpkval:x[]')
    const qualifier = stripped.match(QUALIFIER_RX) || ownSentence.match(/^\s*(?:If|When|Unless|Suppose)\b/) || (ctx.qualifier ? [ctx.qualifier] : null)
    claims.push({
      mention: owner.mention,
      association: owner.association,
      phrase,
      parsed,
      start: valueStart + skip,
      end: valueStart + skip + parsed.length,
      soleTarget: new Set(mentions.map((m) => m.name)).size <= 1 && !shared.backtickSpans(line).some((s) => /^rpk\s/.test(s.text) && s.start !== owner.mention.start),
      ...(qualifier ? { qualifier: qualifier[0].trim() } : {}),
    })
  }

  for (const phrase of DEFAULT_PHRASES) {
    for (const p of line.matchAll(phrase.rx)) {
      const valueStart = p.index + p[0].length
      add(ownerOf(p.index), p[0].trim(), valueStart)
    }
  }
  for (const m of line.matchAll(DEFAULT_OF_RX)) {
    const name = m[1].replace(/^`--|`$/g, '')
    const mention = mentions.find((x) => x.name === name && x.start === m.index + m[0].indexOf(m[1]))
    if (mention) add({ mention, association: 'same-sentence' }, 'default of', m.index + m[0].length)
  }
  for (const m of line.matchAll(TRAILING_DEFAULT_RX)) {
    const valueStart = m.index + m[0].indexOf(m[1])
    add(ownerOf(valueStart), 'by default', valueStart)
  }
  return claims
}

/**
 * Claims in a table: a Default column states the default of the flags named
 * in the row's first cell, paired by position when a cell names several
 * (`--a`, `--b` | `1`, `2`); other cells are prose about the row's flag.
 */
function tableClaims (index, line, ctx) {
  const t = ctx.table
  if (t.start === undefined) t.start = index
  const cells = splitCells(line)
  const trimmed = line.trim()
  if (t.header === undefined && trimmed) {
    if (cells && cells.length > 1 && !flagMentions(line).length) {
      t.header = cells.map((c) => c.text.trim())
      t.cols = cells.length
      t.defaultCol = t.header.findIndex((h) => /^default(?:\s+value)?$/i.test(h))
      return []
    }
    t.header = null
  }
  const claims = []
  if (!cells) return proseClaims(index, line, ctx).map((c) => ({ ...c, association: c.association === 'same-sentence' ? 'same-sentence' : 'table-row' }))
  for (const c of cells) {
    t.cell++
    const col = t.cols ? t.cell % t.cols : -1
    if (col === 0) t.subject = undefined
    const mentions = flagMentions(c.text).filter((m) => m.span)
    if (col === 0 && mentions.length) {
      t.subject = mentions.map((m) => ({ ...m, start: m.start + c.start, end: m.end + c.start }))
      continue
    }
    if (col >= 0 && col === t.defaultCol && t.subject) {
      // Values separated by commas outside backticks.
      const parts = []
      let depth = false
      let from = 0
      for (let k = 0; k <= c.text.length; k++) {
        const ch = c.text[k]
        if (ch === '`') depth = !depth
        if (k === c.text.length || (ch === ',' && !depth)) {
          parts.push({ text: c.text.slice(from, k), start: from })
          from = k + 1
        }
      }
      const values = parts.map((p) => {
        const lead = p.text.match(/^\s*/)[0].length
        const parsed = shared.parseAfterFiller(p.text.slice(lead)).parsed
        return parsed && { parsed, start: c.start + p.start + lead }
      })
      if (values.length !== t.subject.length && values.length !== 1) continue
      t.subject.forEach((mention, k) => {
        const v = values.length === 1 ? (t.subject.length === 1 ? values[0] : undefined) : values[k]
        if (!v) return
        claims.push({ mention, association: 'table-default-column', phrase: 'Default column', parsed: v.parsed, start: v.start, end: v.start + v.parsed.length, soleTarget: t.subject.length === 1, ...(ctx.qualifier ? { qualifier: ctx.qualifier } : {}) })
      })
    }
  }
  // Prose in the other cells, as for a continuation line.
  if (!claims.length) {
    return proseClaims(index, line, ctx).map((c) => ({ ...c, association: c.association === 'same-sentence' ? 'same-sentence' : 'table-row' }))
  }
  return claims
}

/**
 * The command a flag mention belongs to: the span or macro it is in, else the
 * nearest command named earlier on the page, within the current section,
 * that defines the flag.
 */
function owningCommand (claim, { index, sightings, registry }) {
  const tree = registry.data.tree
  const name = claim.mention.name
  if (claim.mention.commandWords) {
    const words = claim.mention.commandWords
    const resolved = rpkValues.resolveCommand(tree, words, registry.data.deprecated_commands)
    if (resolved.ok) return { names: resolved.names, node: resolved.node, nodes: resolved.nodes, from: claim.mention.macro ? 'macro' : 'span' }
    return { error: resolved }
  }
  // The section the mention is in: back to the nearest level 1 or 2 heading,
  // at most 100 lines.
  const lineCol = (s) => [s.line, s.col]
  const candidates = sightings
    .filter((s) => s.line < index || (s.line === index && s.col < claim.mention.start))
    .filter((s) => index - s.line <= 100)
    .sort((a, b) => {
      const [al, ac] = lineCol(a)
      const [bl, bc] = lineCol(b)
      return bl - al || bc - ac
    })
  const sectionStart = claim.sectionStart
  for (const s of candidates) {
    if (sectionStart !== undefined && s.line < sectionStart) break
    if (rpkValues.flagOn(s.node, name)) return { names: s.names, node: s.node, nodes: s.nodes, from: s.line === index ? 'same-line' : 'section' }
  }
  if (rpkValues.flagOn({ flags: tree.global_flags || [] }, name)) return { names: [], node: tree, nodes: [], from: 'global' }
  return undefined
}

function classifyClaim (claim, { index, line, sightings, registry, allFlags, historical, tagged, cloudSurface, relative, table, ctx, sectionStart }) {
  const name = claim.mention.name
  claim.sectionStart = sectionStart
  const owner = owningCommand(claim, { index, sightings, registry, line })
  const base = {
    file: relative,
    line: index + 1,
    text: line.trim(),
    kind: 'rpk',
    flag: name,
    phrase: claim.phrase,
    written: claim.parsed.written,
    association: claim.association,
    autoSafe: false,
    start: claim.start,
    end: claim.end,
    ...(claim.qualifier ? { qualifier: claim.qualifier } : {}),
  }
  if (!owner || owner.error) {
    // An unknown flag name is a helm, kubectl or operator flag: not ours.
    if (!allFlags.has(name)) return undefined
    return { ...base, status: 'unverifiable', reason: 'no-command-context', note: owner && owner.error ? `the command in the span does not resolve (${owner.error.kind})` : 'no command on the page defines this flag nearby' }
  }
  const command = cmd(owner.names)
  base.command = command
  base.commandFrom = owner.from
  const globalOnly = !owner.names.length
  const result = rpkValues.resolveRpkValue({ registry, command: globalOnly ? undefined : command, flag: name, field: 'default' })
  // The bracket form, with the field it compared, so the written call
  // renders the value the finding resolved.
  base.target = `rpkval:[${globalOnly ? 'rpk' : command} --${name},default]`
  const flagEntry = (owner.node && rpkValues.flagOn(owner.node, name)) || rpkValues.flagOn({ flags: registry.data.tree.global_flags || [] }, name)
  const scraped = !globalOnly && flagEntry && rpkValues.isScraped(registry, owner.names, flagEntry)
  base.source = scraped ? 'help' : 'core'
  if (!result.ok) {
    if (['cloud-hidden', 'unavailable'].includes(result.kind)) return { ...base, status: 'unverifiable', reason: 'cloud-unavailable', note: result.message.replace(/^[^:]+: /, '') }
    if (['unknown-flag', 'unknown-command', 'deprecated-command'].includes(result.kind)) {
      return { ...base, status: 'unverifiable', reason: 'no-command-context', note: result.message.replace(/^[^:]+: /, '') }
    }
    return { ...base, status: 'unverifiable', reason: result.kind === 'missing-field' ? 'missing-field' : result.kind, note: result.message.replace(/^[^:]+: /, '') }
  }
  base.dataValue = result.text
  if (claim.qualifier) return { ...base, status: 'unverifiable', reason: 'qualified' }
  const status = shared.compareWritten(claim.parsed, result.text, {
    bool: flagEntry && flagEntry.type === 'bool',
    msUnit: /-ms$/.test(name),
    stringType: flagEntry && /^string/.test(flagEntry.type || ''),
  })
  // A bare word is a value only for a string flag ("defaults to the value of").
  if (claim.parsed.bareWord && !(flagEntry && /^string/.test(flagEntry.type || ''))) return undefined
  if (status === 'not-comparable') return { ...base, status: 'unverifiable', reason: 'not-comparable' }
  if (status === 'mismatch' && scraped) return { ...base, status: 'unverifiable', reason: 'plugin-help-default', note: `the ${owner.names[0]} plugin's --help says ${result.text}` }
  base.status = status
  if (status === 'unset') base.note = `the data default is ${result.text}; the prose states ${shared.norm(claim.parsed.written)}`
  if (status === 'exact' || status === 'equivalent') {
    const call = base.target
    base.proposed = claim.parsed.backticked ? `\`${call}\`` : call
  }
  if (status !== 'exact') return base
  // Auto-safe: exact, same sentence, sole target, not scraped, a value the
  // macro renders, plain prose, not historical, not single-sourced to Cloud.
  const why = (() => {
    if (claim.association !== 'same-sentence') return `tied to the flag by ${claim.association}: proposed only`
    if (!claim.soleTarget) return 'another flag or command is named on the line: proposed only'
    if (scraped) return 'a plugin flag scraped from --help: proposed only'
    if (['""', '[]', '{}'].includes(result.text)) return 'an empty default: proposed only'
    if (table) return 'in a table: proposed only'
    if (historical) return 'release or upgrade notes: proposed only'
    if (!cloudSurface && tagged && !ctx.cloudExcluded) {
      const gated = owner.nodes.some((n) => n.selfHostedOnly === true) || (flagEntry && flagEntry.selfHostedOnly === true) || owner.node.descriptionScope === 'self-hosted'
      if (gated) return 'page may be single-sourced; wrap in ifndef::env-cloud[] first'
    }
    return undefined
  })()
  if (why) base.note = why
  else base.autoSafe = true
  return base
}

/**
 * Counts of every status and the derived counts, for one kind.
 */
function countFindings (findings) {
  const counts = { exact: 0, equivalent: 0, mismatch: 0, unset: 0, unverifiable: 0, reference: 0, 'example-output': 0, referenceErrors: 0, referenceWarnings: 0, autoSafe: 0, exampleStale: 0 }
  for (const f of findings) {
    counts[f.status] = (counts[f.status] || 0) + 1
    if (f.status === 'reference' && f.severity === 'error') counts.referenceErrors++
    if (f.status === 'reference' && f.severity === 'warning') counts.referenceWarnings++
    if (f.autoSafe) counts.autoSafe++
    if (f.verdict === 'stale') counts.exampleStale++
  }
  return counts
}

module.exports = {
  scanRpk,
  nameFindings,
  shellTokens,
  invocationStarts,
  parseInvocation,
  resolveInvocationFlag,
  blockLanguage,
  commandSightings,
  resolveDashed,
  flagMentions,
  proseClaims,
  countFindings,
  linkCounts,
  xrefPage,
  labelCommand,
  linkFindings,
  PASS_THROUGH_COMMANDS,
  RPK_EXCLUDE,
}
