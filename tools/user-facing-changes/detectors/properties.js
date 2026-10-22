'use strict'

const path = require('path')
const { stripComments, matchBracket, splitArgs, literalValue, lineAt, normalize } = require('../source')
const { changedLines } = require('../diff')
const { makeFinding, PAGES } = require('../finding')
const { sameValue } = require('../values')

/**
 * Cluster and broker configuration properties (src/v/config/*.cc, *.h).
 *
 * A property is declared twice: a member in the header
 * (`property<bool> enable_rack_awareness;`, `deprecated_property x;`) and an
 * initializer in the source:
 *
 *     , rpc_server_max_conns(
 *         *this,
 *         "rpc_server_max_conns",
 *         "The maximum number of connections ...",
 *         {.needs_restart = needs_restart::no, .visibility = visibility::user},
 *         128,
 *         {.min = 8})
 *
 * The lint already reviews the description. What it cannot see is every
 * other argument: the default, the visibility, the restart requirement,
 * the name literal, and the header type that marks a property deprecated.
 * Both sides of each changed file are parsed into initializers keyed by
 * member name and compared, so a change anywhere in the initializer is
 * attributed to its property even when the hunk never shows the name.
 * Defaults are compared by value where values.js can normalize both sides,
 * and as whitespace-collapsed text otherwise.
 */

const ROUTES = [/^src\/v\/config\/(?!(?:.*\/)?tests?\/)[^/]+\.(?:cc|h)$/]

const INITIALIZER = /(^|\n)[ \t]*[,:][ \t]*([a-z_][a-z0-9_]*)[ \t]*\(/g
const META_FIELD = /\.(needs_restart|visibility|example|aliases|secret|required|doc_overrides|hidden)\s*=/

/**
 * Parse member initializers out of snippets of a config .cc file.
 * @returns {{ decls: Map<string, object>, unresolved: Array<{line: number, member: string}> }}
 */
function parseInitializers (snippets) {
  const decls = new Map()
  const unresolved = []
  for (const { startLine, text: raw } of snippets) {
    const text = stripComments(raw)
    INITIALIZER.lastIndex = 0
    let m
    while ((m = INITIALIZER.exec(text)) !== null) {
      const member = m[2]
      const open = m.index + m[0].length - 1
      const line = lineAt(text, open, startLine)
      const close = matchBracket(text, open)
      if (close === -1) {
        unresolved.push({ line, member })
        continue
      }
      const args = splitArgs(text.slice(open + 1, close))
      if (normalize(args[0]) !== '*this') continue
      const literals = args.map(literalValue)
      let nameIdx = literals.findIndex((v, i) => i > 0 && v === member)
      if (nameIdx === -1) nameIdx = literals.findIndex((v, i) => i > 0 && v !== null)
      if (nameIdx === -1) continue
      const name = literals[nameIdx]
      const descIdx = literals.findIndex((v, i) => i > nameIdx && v !== null)
      const rest = descIdx === -1 ? [] : args.slice(descIdx + 1)
      let meta = null
      if (rest.length > 0 && /^(?:meta\s*)?\{/.test(rest[0]) && (META_FIELD.test(rest[0]) || (/^(?:meta\s*)?\{\s*\}$/.test(rest[0]) && rest.length > 1))) {
        meta = rest.shift()
      }
      const defaultText = rest.length > 0 ? normalize(rest[0]) : null
      const metaFields = {}
      if (meta) {
        const re = /\.(needs_restart|visibility)\s*=\s*([A-Za-z_:]+)/g
        let f
        while ((f = re.exec(meta)) !== null) metaFields[f[1]] = f[2].replace(/^(?:needs_restart|visibility)::/, '')
      }
      decls.set(member, {
        member,
        name,
        line,
        lineEnd: lineAt(text, close, startLine),
        defaultText,
        visibility: metaFields.visibility || null,
        needsRestart: metaFields.needs_restart || null,
        hasDescription: descIdx !== -1
      })
    }
  }
  return { decls, unresolved }
}

const MEMBER_DECL = /^(?:config::)?([a-z_][a-z0-9_]*(?:<.*>)?)\s+([a-z_][a-z0-9_]*)\s*;$/

/**
 * Member types from snippets of a config header: member name -> type text.
 * Statements are joined across lines the same way the enterprise gating
 * detector does, since clang-format wraps long template argument lists.
 */
function parseHeaderTypes (snippets) {
  const types = new Map()
  for (const { text: raw } of snippets) {
    const text = stripComments(raw)
    let buf = []
    for (const line of text.split('\n')) {
      const body = line.replace(/\[\[[^\]]*\]\]/g, ' ').trim()
      if (!body) continue
      if (/^#/.test(body) || /^(public|private|protected)\s*:$/.test(body)) { buf = []; continue }
      buf.push(body)
      if (/[;{}]$/.test(body)) {
        const statement = buf.join(' ')
        buf = []
        const m = MEMBER_DECL.exec(statement)
        if (m && /property\b|property</.test(m[1])) types.set(m[2], m[1])
      }
    }
  }
  return types
}

function pageFor (file) {
  return /node_config/.test(path.basename(file)) ? PAGES.brokerProperties : PAGES.clusterProperties
}

function isDeprecatedType (type) {
  return typeof type === 'string' && /^(?:config::)?deprecated_property\b/.test(type)
}

function detect ({ files, sides, excerpt, note }) {
  const findings = []
  const byPath = new Map(files.map((f) => [f.path, f]))
  const sources = files.filter((f) => f.path.endsWith('.cc'))
  const headerFor = (ccFile) => byPath.get(ccFile.path.replace(/\.cc$/, '.h'))
  const seenHeaders = new Set()

  for (const file of sources) {
    const { base, head, partial } = sides(file)
    const baseParsed = parseInitializers(base)
    const headParsed = parseInitializers(head)
    if (partial) {
      for (const u of [...baseParsed.unresolved, ...headParsed.unresolved]) {
        note(`${file.path}:${u.line}: initializer of ${u.member} is cut by the hunk; run with --repo to read the whole file`, { file: file.path, line: u.line })
      }
      // A changed line that no initializer visible in the window covers
      // belongs to one that starts above it (PR 203: the default is three
      // lines below the name, outside -U3 context). Say so rather than
      // let the change pass unmentioned.
      const covered = (parsed, line) => [...parsed.decls.values()].some((d) => line >= d.line && line <= d.lineEnd) ||
        parsed.unresolved.some((u) => line >= u.line)
      const stray = [...changedLines(file, 'head')].filter((l) => !covered(headParsed, l))
      const strayBase = [...changedLines(file, 'base')].filter((l) => !covered(baseParsed, l))
      if (stray.length || strayBase.length) {
        const example = stray[0] != null ? `line ${stray[0]}` : `old line ${strayBase[0]}`
        note(`${file.path}: ${stray.length + strayBase.length} changed line(s) fall outside every initializer the hunks show (for example ${example}); run with --repo to attribute them to a property`, { file: file.path, line: stray[0] ?? strayBase[0] })
      }
    }
    const header = headerFor(file)
    let baseTypes = new Map()
    let headTypes = new Map()
    if (header) {
      seenHeaders.add(header.path)
      const hs = sides(header)
      baseTypes = parseHeaderTypes(hs.base)
      headTypes = parseHeaderTypes(hs.head)
    }
    const page = pageFor(file.path)
    const members = new Set([...baseParsed.decls.keys(), ...headParsed.decls.keys()])
    for (const member of [...members].sort()) {
      const b = baseParsed.decls.get(member)
      const h = headParsed.decls.get(member)
      const common = { detector: 'properties', surface: 'properties', file: file.path, page }
      if (h && !b) {
        // Hunk-only mode: the base side of this initializer was cut by the
        // window, so its absence there says nothing. The note covers it.
        if (partial && baseParsed.unresolved.some((u) => u.member === member)) continue
        findings.push(makeFinding({
          ...common,
          name: h.name,
          change_kind: isDeprecatedType(headTypes.get(member)) ? 'deprecated' : 'added',
          line: h.line,
          evidence: excerpt(file, 'head', h.line, h.lineEnd),
          summary: isDeprecatedType(headTypes.get(member))
            ? `\`${h.name}\` is declared as a deprecated property in \`${file.path}\`. The property reference lists it as deprecated from the first release that contains this change.`
            : `\`${h.name}\` is a new configuration property in \`${file.path}\`${h.defaultText != null ? ` (default \`${h.defaultText}\`)` : ''}. The property reference picks it up on regeneration; any page that should mention the new setting (what it tunes, when to change it) needs writing.`
        }))
        continue
      }
      if (b && !h) {
        findings.push(makeFinding({
          ...common,
          name: b.name,
          change_kind: 'removed',
          line: b.line,
          evidence: excerpt(file, 'base', b.line, b.lineEnd),
          summary: `\`${b.name}\` was removed from \`${file.path}\`. The property reference and any page that names it state a setting that no longer exists.`
        }))
        continue
      }
      // Present on both sides: compare the arguments.
      if (isDeprecatedType(headTypes.get(member)) && !isDeprecatedType(baseTypes.get(member))) {
        findings.push(makeFinding({
          ...common,
          name: h.name,
          change_kind: 'deprecated',
          line: h.line,
          evidence: excerpt(file, 'head', h.line, h.lineEnd),
          summary: `\`${h.name}\` became a \`deprecated_property\` in \`${header ? header.path : file.path.replace(/\.cc$/, '.h')}\`. Pages that recommend setting it now recommend a deprecated setting; the property reference needs the deprecation and its replacement.`
        }))
        continue
      }
      if (b.name !== h.name) {
        findings.push(makeFinding({
          ...common,
          name: h.name,
          change_kind: 'renamed',
          line: h.line,
          evidence: excerpt(file, 'head', h.line, h.lineEnd),
          summary: `Property \`${b.name}\` was renamed to \`${h.name}\` in \`${file.path}\` (member \`${member}\`). Every page that uses the old name states a name the broker no longer documents; check whether the old name is kept as an alias.`
        }))
        continue
      }
      if (h.visibility === 'deprecated' && b.visibility !== 'deprecated') {
        findings.push(makeFinding({
          ...common,
          name: h.name,
          change_kind: 'deprecated',
          line: h.line,
          evidence: excerpt(file, 'head', h.line, h.lineEnd),
          summary: `\`${h.name}\` is now \`visibility::deprecated\` in \`${file.path}\`. The property reference needs the deprecation and its replacement.`
        }))
        continue
      }
      // Compared by value where both sides normalize (values.js), so a
      // rewrite that keeps the value (`std::chrono::milliseconds(150)` to
      // `150ms`, `128_MiB` to `134217728`) is not a changed default.
      if (b.defaultText !== null && h.defaultText !== null && !sameValue(b.defaultText, h.defaultText, 'cpp')) {
        findings.push(makeFinding({
          ...common,
          name: h.name,
          change_kind: 'default-changed',
          line: h.line,
          evidence: excerpt(file, 'head', h.line, h.lineEnd),
          summary: `The default of \`${h.name}\` changed from \`${b.defaultText}\` to \`${h.defaultText}\` in \`${file.path}\`. The property reference regenerates its Default row, but any page that quotes the old default in prose, or sizes guidance on it, now states the wrong value.`
        }))
      }
      if (b.visibility && h.visibility && b.visibility !== h.visibility) {
        findings.push(makeFinding({
          ...common,
          name: h.name,
          change_kind: 'behaviour',
          line: h.line,
          evidence: excerpt(file, 'head', h.line, h.lineEnd),
          detail: 'visibility-changed',
          summary: `The visibility of \`${h.name}\` changed from \`${b.visibility}\` to \`${h.visibility}\` in \`${file.path}\`. A tunable is listed differently from a user property in the reference and in \`rpk cluster config\` output.`
        }))
      }
      if (b.needsRestart && h.needsRestart && b.needsRestart !== h.needsRestart) {
        findings.push(makeFinding({
          ...common,
          name: h.name,
          change_kind: 'behaviour',
          line: h.line,
          evidence: excerpt(file, 'head', h.line, h.lineEnd),
          detail: 'restart-requirement-changed',
          summary: `\`${h.name}\` ${h.needsRestart === 'yes' ? 'now requires' : 'no longer requires'} a restart to take effect (\`needs_restart::${b.needsRestart}\` to \`needs_restart::${h.needsRestart}\`) in \`${file.path}\`. The property reference shows the restart requirement, and any procedure that sets this property needs the restart step ${h.needsRestart === 'yes' ? 'added' : 'removed'}.`
        }))
      }
    }
  }

  // A header that changed with no matching .cc change in the diff: a type
  // flipped to deprecated_property with the initializer untouched.
  for (const header of files.filter((f) => f.path.endsWith('.h') && !seenHeaders.has(f.path))) {
    const hs = sides(header)
    const baseTypes = parseHeaderTypes(hs.base)
    const headTypes = parseHeaderTypes(hs.head)
    for (const [member, type] of headTypes) {
      if (isDeprecatedType(type) && baseTypes.has(member) && !isDeprecatedType(baseTypes.get(member))) {
        const line = findLine(hs.head, new RegExp(`\\b${member}\\s*;`))
        findings.push(makeFinding({
          detector: 'properties',
          surface: 'properties',
          file: header.path,
          page: pageFor(header.path),
          name: member,
          change_kind: 'deprecated',
          line,
          evidence: excerpt(header, 'head', line || 1, line || 1),
          summary: `\`${member}\` became a \`deprecated_property\` in \`${header.path}\`. Pages that recommend setting it now recommend a deprecated setting; the property reference needs the deprecation and its replacement.`
        }))
      }
    }
  }
  return findings
}

function findLine (snippets, re) {
  for (const { startLine, text } of snippets) {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return startLine + i
  }
  return null
}

module.exports = {
  id: 'properties',
  surface: 'properties',
  routes: ROUTES,
  detect,
  parseInitializers,
  parseHeaderTypes
}
