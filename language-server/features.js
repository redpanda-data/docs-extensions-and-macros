'use strict'

/**
 * The docs language server's features, as pure functions of a page's text and
 * the loaded workspace (see workspace.js). Every check delegates to the code
 * the build or `doc-tools check-metadata` runs, so the editor reports what
 * the build would, in the same words:
 *
 *   prop:      unknownPropertyMessage, unavailablePropertyMessage, isAvailable
 *              (macros/prop.js)
 *   propval:   resolvePropertyValue (macros/prop.js), which formats values with
 *              extension-utils/property-values.js
 *   categories checkContent and fixCategoryValue (tools/check-metadata)
 *
 * Positions are LSP positions: zero-based line and UTF-16 character, which is
 * how JavaScript indexes strings.
 */

const { unknownPropertyMessage, unavailablePropertyMessage, isAvailable, resolvePropertyValue, describeDataset } = require('../macros/prop')
const propertyValues = require('../extension-utils/property-values')
const { CATEGORY_ATTRIBUTE, TOPIC_TYPE_ATTRIBUTE } = require('../extension-utils/metadata-check')
const { parseHeader, checkContent, fixCategoryValue, CATEGORY_SCHEMES } = require('../tools/check-metadata')

// LSP enum values, kept here so this module has no protocol dependency.
const SEVERITY = { error: 1, warning: 2, information: 3 }
const COMPLETION_KIND = { property: 10, value: 12, enumMember: 20, field: 5 }
const SOURCE = 'redpanda-docs'

// Asciidoctor's inline macro shape for these two names: name:target[attrlist].
// The target has no whitespace or '['; the attrlist ends at the first ']'.
const MACRO_RX = /(?<![\w-])(propval|prop):([^\s[\]]+)\[([^\]]*)\]/g

/**
 * Lines whose text is not converted: line comments, comment blocks, and
 * listing or literal blocks. Macros there never render, so they are not
 * checked or completed.
 *
 * @returns {Set<number>} zero-based line numbers
 */
function inertLines (lines) {
  const inert = new Set()
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const delimiter = /^(\/{4,}|-{4,}|\.{4,})\s*$/.exec(line)
    if (fence) {
      inert.add(i)
      if (delimiter && delimiter[1] === fence) fence = null
      continue
    }
    if (delimiter) {
      fence = delimiter[1]
      inert.add(i)
      continue
    }
    if (/^\/\/(?!\/)/.test(line)) inert.add(i)
  }
  return inert
}

/** Every prop: and propval: in the page, with its range and parsed attributes. */
function findMacros (text) {
  const lines = String(text).split(/\r?\n/)
  const inert = inertLines(lines)
  const out = []
  lines.forEach((line, lineNo) => {
    if (inert.has(lineNo)) return
    MACRO_RX.lastIndex = 0
    let m
    while ((m = MACRO_RX.exec(line))) {
      const [whole, macro, name, attrlist] = m
      const nameStart = m.index + macro.length + 1
      out.push({
        macro,
        name,
        attrlist,
        attributes: parseAttrlist(attrlist),
        line: lineNo,
        range: range(lineNo, m.index, m.index + whole.length),
        nameRange: range(lineNo, nameStart, nameStart + name.length),
      })
    }
  })
  return out
}

/** Positional and named attributes, the way the macros read them. */
function parseAttrlist (attrlist) {
  const attributes = {}
  let position = 1
  for (const part of String(attrlist).split(',').map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf('=')
    if (eq > 0) attributes[part.slice(0, eq).trim()] = part.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    else attributes[position++] = part
  }
  return attributes
}

function range (line, start, end) {
  return { start: { line, character: start }, end: { line, character: end } }
}

const contains = (r, pos) =>
  pos.line === r.start.line && pos.character >= r.start.character && pos.character <= r.end.character

/** A document attribute set in the page header, such as property-validate. */
function headerAttribute (text, name) {
  const entry = parseHeader(text).filter((e) => e.name === name).pop()
  return entry ? entry.value : undefined
}

function propertyEntry (registry, name) {
  return registry && Object.prototype.hasOwnProperty.call(registry.properties, name) ? registry.properties[name] : undefined
}

// ---------------------------------------------------------------- diagnostics

/**
 * The problems the build would log for this page.
 *
 * @param {string} text
 * @param {Object} workspace - from loadWorkspace
 * @returns {Array<Object>} LSP Diagnostic objects
 */
function diagnostics (text, workspace) {
  return [...macroDiagnostics(text, workspace), ...metadataDiagnostics(text, workspace)]
}

function macroDiagnostics (text, { properties: registry, component }) {
  if (!registry) return []
  const mode = headerAttribute(text, 'property-validate') || 'warn'
  const out = []
  for (const m of findMacros(text)) {
    const name = m.name.trim()
    if (m.macro === 'prop') {
      if (mode === 'off') continue
      const entry = propertyEntry(registry, name)
      if (!entry) {
        out.push(diagnostic(m.nameRange, unknownPropertyMessage({ name, registry }), mode === 'error' ? 'error' : 'warning', 'unknown-property'))
      } else if (!isAvailable(registry, entry)) {
        out.push(diagnostic(m.nameRange, unavailablePropertyMessage({ name, component: component.name, registry }), 'warning', 'unavailable-property'))
      }
      continue
    }
    const requested = String(m.attributes.field || m.attributes[1] || 'default').trim()
    const result = resolvePropertyValue({ registry, name, field: requested, format: m.attributes.format, component: component.name })
    if (result.ok) continue
    const fatal = mode === 'error' && ['unknown-property', 'missing-field', 'unsupported-field'].includes(result.kind)
    const where = result.kind === 'unknown-property' || result.kind === 'unavailable' ? m.nameRange : m.range
    out.push(diagnostic(where, result.message, fatal ? 'error' : 'warning', result.kind))
  }
  return out
}

function metadataDiagnostics (text, { taxonomy, isLegacyCategory }) {
  if (!taxonomy) return []
  const lines = String(text).split(/\r?\n/)
  const { findings } = checkContent(text, { taxonomy, isLegacyCategory })
  return findings.map((f) => {
    const lineNo = f.line - 1
    const at = valueRange(lines[lineNo] || '', lineNo, f.attribute, f.value)
    return {
      ...diagnostic(at, f.message, f.severity, f.rule),
      data: { attribute: f.attribute, value: f.value, rule: f.rule },
    }
  })
}

/** Where one value sits on an attribute entry line; the whole line if not found. */
function valueRange (line, lineNo, attribute, value) {
  const prefix = new RegExp(`^:${attribute}!?:`).exec(line)
  const from = prefix ? prefix[0].length : 0
  const rx = new RegExp(`(^|,)\\s*(${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s*(?=,|$)`)
  const m = rx.exec(line.slice(from))
  if (!m) return range(lineNo, 0, line.length)
  const start = from + m.index + m[0].indexOf(m[2])
  return range(lineNo, start, start + value.length)
}

function diagnostic (r, message, severity, code) {
  return { range: r, message, severity: SEVERITY[severity] || SEVERITY.warning, source: SOURCE, code }
}

// ---------------------------------------------------------------- code actions

/**
 * Quick fixes for the diagnostics in a range. A deprecated :page-categories:
 * value becomes what `doc-tools check-metadata --fix` would write: its
 * replacement's preferred label, or nothing when the replacement is a task.
 *
 * @param {string} text
 * @param {Array<Object>} diags - the diagnostics the client sent
 * @param {Object} workspace
 * @param {string} uri
 */
function codeActions (text, diags, { taxonomy }, uri) {
  if (!taxonomy) return []
  const lines = String(text).split(/\r?\n/)
  const actions = []
  for (const d of diags || []) {
    if (d.source !== SOURCE || d.code !== 'deprecated-value' || !d.data || d.data.attribute !== CATEGORY_ATTRIBUTE) continue
    const fix = fixCategoryValue(d.data.value, taxonomy)
    if (fix.action !== 'replace' && fix.action !== 'drop') continue
    const lineNo = d.range.start.line
    const line = lines[lineNo] || ''
    const prefix = /^:page-categories!?:/.exec(line)
    if (!prefix) continue
    const values = line.slice(prefix[0].length).split(',').map((v) => v.trim()).filter(Boolean)
    const rewritten = []
    for (const v of values) {
      for (const out of v === d.data.value ? fix.values : [v]) if (!rewritten.includes(out)) rewritten.push(out)
    }
    const title = fix.action === 'replace'
      ? `Replace '${d.data.value}' with ${fix.values.map((v) => `'${v}'`).join(', ')}`
      : `Remove '${d.data.value}' (its replacement is derived from the module)`
    actions.push({
      title,
      kind: 'quickfix',
      diagnostics: [d],
      isPreferred: true,
      edit: { changes: { [uri]: [{ range: range(lineNo, 0, line.length), newText: rewritten.length ? `${prefix[0]} ${rewritten.join(', ')}` : prefix[0] }] } },
    })
  }
  return actions
}

// ---------------------------------------------------------------- completion

/**
 * Completion items at a position: property names after prop: or propval:,
 * fields inside propval:<name>[ ], and taxonomy labels on a
 * :page-categories: header line.
 */
function completion (text, position, workspace) {
  const lines = String(text).split(/\r?\n/)
  const line = lines[position.line] || ''
  if (inertLines(lines).has(position.line)) return []
  const before = line.slice(0, position.character)

  const field = /(?<![\w-])propval:([^\s[\]]+)\[([^\]]*)$/.exec(before)
  if (field) return fieldCompletions(field[1], field[2], position, workspace)

  const name = /(?<![\w-])(propval|prop):([^\s[\]]*)$/.exec(before)
  if (name) return propertyCompletions(name[1], name[2], position, workspace)

  const categories = /^:page-categories!?:(.*)$/.exec(before)
  if (categories && isHeaderLine(lines, position.line)) return categoryCompletions(line, categories[1], position, workspace)
  return []
}

function isHeaderLine (lines, lineNo) {
  return parseHeader(lines.join('\n')).some((e) => lineNo + 1 >= e.start && lineNo + 1 <= e.line)
}

function propertyCompletions (macro, typed, position, { properties: registry }) {
  if (!registry) return []
  const editRange = range(position.line, position.character - typed.length, position.character)
  const items = []
  for (const [name, entry] of Object.entries(registry.properties)) {
    if (!entry || typeof entry !== 'object' || !isAvailable(registry, entry)) continue
    items.push({
      label: name,
      kind: COMPLETION_KIND.property,
      detail: [entry.config_scope, entry.type].filter(Boolean).join(' property, '),
      documentation: { kind: 'markdown', value: propertyMarkdown(name, entry, registry) },
      textEdit: { range: editRange, newText: macro === 'prop' ? `${name}[]` : `${name}[default]` },
      filterText: name,
      // Deprecated properties sort last but stay available for existing pages.
      sortText: `${entry.is_deprecated ? '1' : '0'}${name}`,
      tags: entry.is_deprecated ? [1] : undefined,
    })
  }
  return items
}

function fieldCompletions (name, typed, position, { properties: registry, component }) {
  const parts = typed.split(',')
  const current = parts[parts.length - 1].trimStart()
  const editRange = range(position.line, position.character - current.length, position.character)
  if (parts.length > 1) {
    return [propertyValues.FORMAT_RAW, propertyValues.FORMAT_HUMAN].map((format) => ({
      label: `format=${format}`,
      kind: COMPLETION_KIND.value,
      detail: format === propertyValues.FORMAT_RAW ? 'the exact value from the property data' : 'the human-readable value (default)',
      textEdit: { range: editRange, newText: `format=${format}` },
    }))
  }
  return Object.keys(propertyValues.FIELDS).map((f) => {
    const resolved = registry ? resolvePropertyValue({ registry, name: name.trim(), field: f, component: component.name }) : null
    return {
      label: f,
      kind: COMPLETION_KIND.field,
      detail: resolved ? (resolved.ok ? resolved.text : `<unknown ${f}>`) : undefined,
      textEdit: { range: editRange, newText: f },
      // Fields with a value for this property first.
      sortText: `${resolved && resolved.ok ? '0' : '1'}${f}`,
    }
  })
}

function categoryCompletions (line, typedValues, position, { taxonomy }) {
  if (!taxonomy) return []
  const parts = typedValues.split(',')
  const current = parts[parts.length - 1].replace(/^\s+/, '')
  const taken = new Set(line.replace(/^:page-categories!?:/, '').split(',').map((v) => v.trim()).filter(Boolean))
  const editRange = range(position.line, position.character - current.length, position.character)
  const items = []
  for (const scheme of CATEGORY_SCHEMES) {
    for (const id of taxonomy.conceptIds(scheme)) {
      const concept = taxonomy.get(id)
      if (taken.has(concept.prefLabel)) continue
      items.push({
        label: concept.prefLabel,
        kind: COMPLETION_KIND.enumMember,
        detail: `${scheme}${concept.broader ? ` under ${taxonomy.label(concept.broader)}` : ''}`,
        documentation: concept.definition || undefined,
        textEdit: { range: editRange, newText: concept.prefLabel },
        filterText: [concept.prefLabel, ...concept.altLabels].join(' '),
      })
    }
  }
  return items
}

// ---------------------------------------------------------------- hover

/**
 * Hover text for a prop:, a propval:, or a :page-categories: value.
 *
 * @returns {Object|null} an LSP Hover
 */
function hover (text, position, workspace) {
  const macro = findMacros(text).find((m) => contains(m.range, position))
  if (macro) return macroHover(macro, workspace)
  return categoryHover(text, position, workspace)
}

function macroHover (m, { properties: registry, component }) {
  const name = m.name.trim()
  if (!registry) {
    return markdownHover(`\`${name}\`: no property data for ${component.name}@${component.version || 'unversioned'}, so the build does not check this reference.`, m.range)
  }
  const entry = propertyEntry(registry, name)
  if (!entry) return markdownHover(unknownPropertyMessage({ name, registry }), m.nameRange)
  if (m.macro === 'propval') {
    const requested = String(m.attributes.field || m.attributes[1] || 'default').trim()
    const result = resolvePropertyValue({ registry, name, field: requested, format: m.attributes.format, component: component.name })
    const head = result.ok
      ? `**Renders as:** ${result.text}`
      : `**Renders as:** \`<unknown ${result.field}>\`\n\n${result.message}`
    return markdownHover(`${head}\n\n---\n\n${propertyMarkdown(name, entry, registry)}`, m.range)
  }
  return markdownHover(propertyMarkdown(name, entry, registry), m.range)
}

/** A property's reference summary, with values formatted as the tables print them. */
function propertyMarkdown (name, entry, registry) {
  const rows = []
  for (const field of ['type', 'default', 'unit', 'min', 'max', 'values', 'restart', 'scope', 'introduced']) {
    const value = propertyValues.fieldValue(entry, field)
    if (value.ok) rows.push(`| ${field} | ${value.text.replace(/\|/g, '\\|')} |`)
  }
  const parts = [`**${name}**`]
  if (entry.description) parts.push(String(entry.description).split(/\n\s*\n/)[0])
  if (rows.length) parts.push(['| Field | Value |', '| --- | --- |', ...rows].join('\n'))
  if (entry.is_enterprise) {
    const values = Array.isArray(entry.enterprise_value) && entry.enterprise_value.length ? ` when set to ${entry.enterprise_value.map((v) => `\`${v}\``).join(', ')}` : ''
    parts.push(`Enterprise: requires an Enterprise Edition license${values}.`)
  }
  if (entry.is_deprecated) parts.push('Deprecated.')
  if (!isAvailable(registry, entry)) parts.push('Not available on Cloud (cloud_supported: false).')
  parts.push(`_From ${describeDataset(registry)}._`)
  return parts.join('\n\n')
}

function categoryHover (text, position, { taxonomy }) {
  if (!taxonomy) return null
  const lines = String(text).split(/\r?\n/)
  const line = lines[position.line] || ''
  const prefix = /^:(page-categories|page-topic-type)!?:/.exec(line)
  if (!prefix || !isHeaderLine(lines, position.line)) return null
  // The comma-separated value under the cursor.
  let start = line.lastIndexOf(',', position.character - 1) + 1
  if (start < prefix[0].length) start = prefix[0].length
  let end = line.indexOf(',', position.character)
  if (end === -1) end = line.length
  const value = line.slice(start, end).trim()
  if (!value) return null
  const options = prefix[1] === TOPIC_TYPE_ATTRIBUTE ? { schemes: ['content-type'], prefer: 'id' } : undefined
  const hit = taxonomy.resolve(value, options)
  if (!hit) return markdownHover(`'${value}' is not in the taxonomy.`, null)
  const { concept } = hit
  const parts = [`**${concept.prefLabel}** (${concept.scheme}${concept.broader ? `, under ${taxonomy.label(concept.broader)}` : ''})`]
  if (concept.definition) parts.push(concept.definition)
  if (concept.deprecated) {
    parts.push(hit.ids.length ? `Deprecated: use ${hit.ids.map((id) => `'${taxonomy.label(id)}'`).join(', ')}.` : 'Deprecated, with no single replacement.')
  }
  if (concept.altLabels.length) parts.push(`Also matches: ${concept.altLabels.join(', ')}`)
  return markdownHover(parts.join('\n\n'), null)
}

function markdownHover (value, r) {
  const out = { contents: { kind: 'markdown', value } }
  if (r) out.range = r
  return out
}

module.exports = {
  SOURCE,
  findMacros,
  parseAttrlist,
  inertLines,
  diagnostics,
  codeActions,
  completion,
  hover,
}
