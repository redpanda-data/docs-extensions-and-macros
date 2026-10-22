'use strict'

const { stripComments, matchBracket, lineAt } = require('../source')
const { makeFinding, PAGES } = require('../finding')

/**
 * Enum values that reach users through configuration or the feature table.
 *
 * The DOC-2600 class: streaming-enterprise PR 579 added a value to an enum
 * (license_required_feature, handled by the enterprise-gating detector) and
 * changed feature_manager behaviour, with no doc string anywhere. The
 * general form is a new value in an enum that a user can set or observe:
 *
 *   - the type argument of an `enum_property<T>` in configuration.h or
 *     node_config.h: its enumerators are the property's accepted values,
 *     which the property reference lists and pages quote;
 *   - `enum class feature` in src/v/features/feature_table.h: each value is
 *     a feature flag the Admin API's /v1/features reports and that upgrade
 *     docs name.
 *
 * Deliberately conservative. Only enums whose TYPE NAME (last `::` segment)
 * is referenced from one of those two places are read, so a new value in
 * an internal enum is never a finding. The enumerator identifier is what is
 * reported: the string a user types is produced by that enum's own
 * operator<< or parser elsewhere, and this detector does not follow it, so
 * a value whose spelling differs from its identifier is reported under the
 * identifier. Values are paired by name, so a value that moves is not a
 * change. An enum defined with a `using`/typedef alias, a C enum (no
 * `class`), or an enum spread over macros is not read.
 */

const ROUTES = [/^src\/v\/(?!(?:.*\/)?tests?\/)(?!(?:.*\/)?test\/).*\.h$/]
const CONFIG_HEADERS = ['src/v/config/configuration.h', 'src/v/config/node_config.h']
const FEATURE_TABLE = 'src/v/features/feature_table.h'

const ENUM_PROPERTY = /enum_property<\s*([A-Za-z_][A-Za-z0-9_:]*)\s*>/g
const ENUM_BLOCK = /\benum\s+class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[^{]+)?\{/g

/** Short type names (last :: segment) of every enum_property<T> in a header text. */
function configEnumTypes (headerText) {
  const out = new Set()
  if (!headerText) return out
  const text = stripComments(headerText)
  let m
  ENUM_PROPERTY.lastIndex = 0
  while ((m = ENUM_PROPERTY.exec(text)) !== null) out.add(m[1].split('::').pop())
  return out
}

/** enum name -> Map(enumerator -> line) for the given snippets. */
function parseEnums (snippets, wanted) {
  const enums = new Map()
  const unresolved = []
  for (const { startLine, text: raw, header } of snippets) {
    const text = stripComments(raw)
    let m
    // A hunk whose opener is above the window: git names the enclosing
    // declaration in the hunk header, so the lines up to the first `};`
    // are that enum's members.
    const fromHeader = header && /\benum\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(header)
    if (fromHeader && wanted.has(fromHeader[1]) && !new RegExp(`\\benum\\s+class\\s+${fromHeader[1]}\\b`).test(text)) {
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
      else enums.set(fromHeader[1], { values, line: startLine, lineEnd: lineAt(text, end, startLine), fromHeader: true })
    }
    ENUM_BLOCK.lastIndex = 0
    while ((m = ENUM_BLOCK.exec(text)) !== null) {
      const name = m[1]
      if (!wanted.has(name)) continue
      const open = m.index + m[0].length - 1
      const close = matchBracket(text, open)
      const line = lineAt(text, m.index, startLine)
      if (close === -1) { unresolved.push({ line, name }); continue }
      const body = text.slice(open + 1, close)
      const values = new Map()
      let offset = 0
      for (const entry of body.split(',')) {
        const v = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*[^,]*)?\s*$/.exec(entry)
        if (v) values.set(v[1], lineAt(body, offset, line))
        offset += entry.length + 1
      }
      enums.set(name, { values, line, lineEnd: lineAt(text, close, startLine) })
    }
  }
  return { enums, unresolved }
}

function detect ({ files, sides, excerpt, readHead, note }) {
  const findings = []
  // Enum types users can set: from the config headers at HEAD when a
  // checkout is available, else from whatever config header text the diff
  // carries.
  const wanted = new Set(['feature'])
  for (const header of CONFIG_HEADERS) {
    const text = readHead ? readHead(header) : null
    if (text) for (const t of configEnumTypes(text)) wanted.add(t)
    else {
      const f = files.find((x) => x.path === header)
      if (f) for (const snip of sides(f).head) for (const t of configEnumTypes(snip.text)) wanted.add(t)
    }
  }
  for (const file of files) {
    const { base, head, partial } = sides(file)
    const want = file.path === FEATURE_TABLE ? wanted : new Set([...wanted].filter((t) => t !== 'feature'))
    const b = parseEnums(base, want)
    const h = parseEnums(head, want)
    if (partial) {
      for (const u of [...b.unresolved, ...h.unresolved]) {
        note(`${file.path}:${u.line}: enum ${u.name} is cut by the hunk; run with --repo to read the whole file`, { file: file.path, line: u.line })
      }
    }
    const names = new Set([...b.enums.keys(), ...h.enums.keys()])
    for (const name of names) {
      const bv = b.enums.get(name)
      const hv = h.enums.get(name)
      if (!bv || !hv) continue // whole enum added or removed: the property or feature detector owns that
      const isFeature = file.path === FEATURE_TABLE && name === 'feature'
      const common = {
        detector: 'enums',
        surface: isFeature ? 'feature-flags' : 'properties',
        file: file.path,
        page: isFeature ? PAGES.api.admin : PAGES.clusterProperties
      }
      for (const [value, line] of hv.values) {
        if (bv.values.has(value)) continue
        findings.push(makeFinding({
          ...common, name: `${name}::${value}`, change_kind: 'behaviour', line, evidence: excerpt(file, 'head', line, line), detail: 'enum-value-added',
          summary: isFeature
            ? `New feature flag \`${value}\` in \`enum class feature\` (\`${file.path}\`). \`GET /v1/features\` reports it and the upgrade docs that list feature flags and their activation need it.`
            : `New value \`${value}\` in \`enum class ${name}\` (\`${file.path}\`), the type of an \`enum_property\`. The property reference and every page that lists the accepted values of that property need the new value and what it does. The identifier is reported; the string a user sets may be spelled differently by the enum's parser.`
        }))
      }
      for (const [value, line] of bv.values) {
        if (hv.values.has(value)) continue
        findings.push(makeFinding({
          ...common, name: `${name}::${value}`, change_kind: 'removed', line, evidence: excerpt(file, 'base', line, line), detail: 'enum-value-removed',
          summary: isFeature
            ? `Feature flag \`${value}\` left \`enum class feature\` (\`${file.path}\`). Upgrade docs that name it state a flag the broker no longer reports.`
            : `Value \`${value}\` was removed from \`enum class ${name}\` (\`${file.path}\`), the type of an \`enum_property\`. Pages that list it as an accepted value state one the broker now rejects.`
        }))
      }
    }
  }
  return findings
}

module.exports = { id: 'enums', surface: 'enums', routes: ROUTES, detect, parseEnums, configEnumTypes, CONFIG_HEADERS, FEATURE_TABLE }
