'use strict'

const { stripComments, matchBracket, lineAt } = require('../source')
const { makeFinding, PAGES } = require('../finding')

/**
 * Enum values that reach users through configuration.
 *
 * The DOC-2600 class: streaming-enterprise PR 579 added a value to an enum
 * (license_required_feature, handled by the enterprise-gating detector)
 * with no doc string anywhere. The general form is a new value in the type
 * argument of an `enum_property<T>` (or `enum_property<std::optional<T>>`)
 * in configuration.h or node_config.h: its enumerators are the property's
 * accepted values, which the property reference lists and pages quote.
 *
 * Deliberately conservative. Only enums named by one of those
 * enum_property declarations are read, matched by namespace as well as
 * name (`fips_mode_flag` in node_config.h is config::fips_mode_flag, not
 * the model:: enum of the same name), so a new value in an internal enum
 * is never a finding. Findings are named after the property
 * (`fips_mode=permissive`), and the enumerator identifier is what is
 * reported: the string a user types is produced by that enum's own
 * operator<< or parser elsewhere, and this detector does not follow it.
 * Values are paired by name, so a value that moves is not a change. An
 * enum defined with a `using`/typedef alias, a C enum (no `class`), or an
 * enum spread over macros is not read.
 *
 * Feature flags (`enum class feature` in features/feature_table.h) are not
 * read: the docs do not list them, and the table changes in most releases.
 */

const ROUTES = [/^src\/v\/(?!(?:.*\/)?tests?\/)(?!(?:.*\/)?test\/).*\.h$/]
const CONFIG_HEADERS = ['src/v/config/configuration.h', 'src/v/config/node_config.h']

const ENUM_PROPERTY = /enum_property<\s*(?:std::optional<\s*)?([A-Za-z_][A-Za-z0-9_:]*)\s*>?\s*>\s*>?\s*([a-z_][a-z0-9_]*)?/g
const ENUM_BLOCK = /\benum\s+class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[^{]+)?\{/g
const NAMESPACE = /\bnamespace\s+([A-Za-z_][\w:]*)\s*\{/g

/**
 * The enum types of every enum_property in a config header: short name ->
 * [{ ns, properties }]. An unqualified type is in namespace config, where
 * the header declares it.
 */
function configEnums (headerText) {
  const out = new Map()
  if (!headerText) return out
  const text = stripComments(headerText).replace(/\s+/g, ' ')
  let m
  ENUM_PROPERTY.lastIndex = 0
  while ((m = ENUM_PROPERTY.exec(text)) !== null) {
    const parts = m[1].split('::')
    const short = parts.pop()
    const ns = parts.length ? parts.join('::') : 'config'
    if (!out.has(short)) out.set(short, [])
    let entry = out.get(short).find((e) => e.ns === ns)
    if (!entry) { entry = { ns, properties: [] }; out.get(short).push(entry) }
    if (m[2] && !entry.properties.includes(m[2])) entry.properties.push(m[2])
  }
  return out
}

/** Short type names (last :: segment) of every enum_property<T> in a header text. */
function configEnumTypes (headerText) {
  return new Set(configEnums(headerText).keys())
}

/** The namespace that encloses offset `at`, from `namespace a::b {` blocks in `text`. */
function namespaceAt (text, at) {
  const parts = []
  NAMESPACE.lastIndex = 0
  let m
  while ((m = NAMESPACE.exec(text)) !== null) {
    if (m.index > at) break
    const open = m.index + m[0].length - 1
    const close = matchBracket(text, open)
    if (close === -1 || close > at) parts.push(m[1])
  }
  return parts.join('::')
}

/**
 * The wanted entry an enum named `name` in `file` is, or null. With the
 * enclosing namespace known, it must end with the wanted one; without it
 * (a hunk), the file's directories must name the namespace.
 */
function matchWanted (wanted, name, ns, file) {
  const entries = wanted.get(name)
  if (!entries) return null
  if (ns !== null && ns !== '') return entries.find((e) => ns === e.ns || ns.endsWith(`::${e.ns}`)) || null
  return entries.find((e) => e.ns.split('::').every((seg) => file.split('/').includes(seg))) || null
}

/** enum name -> { values: Map(enumerator -> line), entry } for the given snippets. */
function parseEnums (snippets, wanted, file = '') {
  // Older callers pass a Set of short names: accept any namespace.
  if (wanted instanceof Set) wanted = new Map([...wanted].map((n) => [n, [{ ns: '', properties: [] }]]))
  const accepts = (name, ns) => {
    const entries = wanted.get(name)
    if (!entries) return null
    if (entries.some((e) => e.ns === '')) return entries[0]
    return matchWanted(wanted, name, ns, file)
  }
  const enums = new Map()
  const unresolved = []
  for (const { startLine, text: raw, header } of snippets) {
    const text = stripComments(raw)
    let m
    // A hunk whose opener is above the window: git names the enclosing
    // declaration in the hunk header, so the lines up to the first `};`
    // are that enum's members.
    const fromHeader = header && /\benum\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(header)
    const headerEntry = fromHeader && accepts(fromHeader[1], null)
    if (headerEntry && !new RegExp(`\\benum\\s+class\\s+${fromHeader[1]}\\b`).test(text)) {
      const end = text.search(/^\s*\};/m)
      const body = end === -1 ? text : text.slice(0, end)
      const values = new Map()
      let offset = 0
      for (const entry of body.split(',')) {
        const v = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*[^,]*)?\s*$/.exec(entry)
        if (v) values.set(v[1], lineAt(body, offset, startLine))
        offset += entry.length + 1
      }
      if (end === -1) unresolved.push({ line: startLine, name: fromHeader[1] })
      else enums.set(fromHeader[1], { values, line: startLine, lineEnd: lineAt(text, end, startLine), fromHeader: true, entry: headerEntry })
    }
    ENUM_BLOCK.lastIndex = 0
    while ((m = ENUM_BLOCK.exec(text)) !== null) {
      const name = m[1]
      // A whole file knows its namespaces; a hunk snippet usually does not.
      const ns = /\bnamespace\s/.test(text) ? namespaceAt(text, m.index) : null
      const entry = accepts(name, ns)
      if (!entry) continue
      const open = m.index + m[0].length - 1
      const close = matchBracket(text, open)
      const line = lineAt(text, m.index, startLine)
      if (close === -1) { unresolved.push({ line, name }); continue }
      const body = text.slice(open + 1, close)
      const values = new Map()
      let offset = 0
      for (const e of body.split(',')) {
        const v = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*[^,]*)?\s*$/.exec(e)
        if (v) values.set(v[1], lineAt(body, offset, line))
        offset += e.length + 1
      }
      enums.set(name, { values, line, lineEnd: lineAt(text, close, startLine), entry })
    }
  }
  return { enums, unresolved }
}

function detect ({ files, sides, excerpt, readHead, note }) {
  const findings = []
  // Enum types users can set: from the config headers at HEAD when a
  // checkout is available, else from whatever config header text the diff
  // carries.
  const wanted = new Map()
  const pageOf = new Map()
  const addAll = (text, header) => {
    for (const [short, entries] of configEnums(text)) {
      if (!wanted.has(short)) wanted.set(short, [])
      for (const e of entries) {
        const have = wanted.get(short).find((x) => x.ns === e.ns)
        if (have) { for (const p of e.properties) if (!have.properties.includes(p)) have.properties.push(p) } else wanted.get(short).push({ ...e, properties: [...e.properties] })
        for (const p of e.properties) pageOf.set(p, /node_config/.test(header) ? PAGES.brokerProperties : PAGES.clusterProperties)
      }
    }
  }
  for (const header of CONFIG_HEADERS) {
    const text = readHead ? readHead(header) : null
    if (text) addAll(text, header)
    else {
      const f = files.find((x) => x.path === header)
      if (f) for (const snip of sides(f).head) addAll(snip.text, header)
    }
  }
  if (wanted.size === 0) return findings
  for (const file of files) {
    const { base, head, partial } = sides(file)
    const b = parseEnums(base, wanted, file.path)
    const h = parseEnums(head, wanted, file.path)
    if (partial) {
      for (const u of [...b.unresolved, ...h.unresolved]) {
        note(`${file.path}:${u.line}: enum ${u.name} is cut by the hunk; run with --repo to read the whole file`, { file: file.path, line: u.line })
      }
    }
    const names = new Set([...b.enums.keys(), ...h.enums.keys()])
    for (const name of names) {
      const bv = b.enums.get(name)
      const hv = h.enums.get(name)
      if (!bv || !hv) continue // whole enum added or removed: the property detector owns that
      const props = (hv.entry && hv.entry.properties.length) ? hv.entry.properties : [name]
      const prop = props[0]
      const others = props.length > 1 ? ` (also the type of ${props.slice(1).map((p) => `\`${p}\``).join(', ')})` : ''
      const common = {
        detector: 'enums',
        surface: 'properties',
        file: file.path,
        page: pageOf.get(prop) || PAGES.clusterProperties
      }
      for (const [value, line] of hv.values) {
        if (bv.values.has(value)) continue
        findings.push(makeFinding({
          ...common, name: `${prop}=${value}`, change_kind: 'behaviour', line, evidence: excerpt(file, 'head', line, line), detail: 'enum-value-added',
          summary: `New value \`${value}\` in \`enum class ${name}\` (\`${file.path}\`), the type of \`${prop}\`${others}. The property reference and every page that lists the accepted values of that property need the new value and what it does. The identifier is reported; the string a user sets may be spelled differently by the enum's parser.`
        }))
      }
      for (const [value, line] of bv.values) {
        if (hv.values.has(value)) continue
        findings.push(makeFinding({
          ...common, name: `${prop}=${value}`, change_kind: 'removed', line, evidence: excerpt(file, 'base', line, line), detail: 'enum-value-removed',
          summary: `Value \`${value}\` was removed from \`enum class ${name}\` (\`${file.path}\`), the type of \`${prop}\`${others}. Pages that list it as an accepted value state one the broker now rejects.`
        }))
      }
    }
  }
  return findings
}

module.exports = { id: 'enums', surface: 'enums', routes: ROUTES, detect, parseEnums, configEnums, configEnumTypes, namespaceAt, CONFIG_HEADERS }
