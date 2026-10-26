'use strict'

/**
 * prop: and propval:, checked with the code the build runs:
 *
 *   prop:      unknownPropertyMessage, unavailablePropertyMessage, isAvailable
 *              (macros/prop.js)
 *   propval:   resolvePropertyValue (macros/prop.js), which formats values with
 *              extension-utils/property-values.js
 *
 * The property data is the workspace's `properties` (see workspace.js), which
 * the generated-content and override features read too.
 */

const { unknownPropertyMessage, unavailablePropertyMessage, isAvailable, resolvePropertyValue, describeDataset } = require('../../macros/prop')
const propertyValues = require('../../extension-utils/property-values')
const { scanMacros, inertLines, range, contains, headerAttribute } = require('../lib/asciidoc')
const { COMPLETION_KIND, diagnostic, markdownHover } = require('../lib/lsp')

const MACROS = ['propval', 'prop']

/** Every prop: and propval: in the page, with its range and parsed attributes. */
function findMacros (text) {
  return scanMacros(text, MACROS)
}

function propertyEntry (registry, name) {
  return registry && Object.prototype.hasOwnProperty.call(registry.properties, name) ? registry.properties[name] : undefined
}

// ---------------------------------------------------------------- diagnostics

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

// ---------------------------------------------------------------- completion

/**
 * Property names after prop: or propval:, and fields inside
 * propval:<name>[ ].
 */
function macroCompletion (text, position, workspace) {
  const lines = String(text).split(/\r?\n/)
  const line = lines[position.line] || ''
  if (inertLines(lines).has(position.line)) return []
  const before = line.slice(0, position.character)

  const field = /(?<![\w-])propval:([^\s[\]]+)\[([^\]]*)$/.exec(before)
  if (field) return fieldCompletions(field[1], field[2], position, workspace)

  const name = /(?<![\w-])(propval|prop):([^\s[\]]*)$/.exec(before)
  if (name) return propertyCompletions(name[1], name[2], position, workspace)
  return []
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

// ---------------------------------------------------------------- hover

function hover (text, position, workspace) {
  const macro = findMacros(text).find((m) => contains(m.range, position))
  return macro ? macroHover(macro, workspace) : null
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

module.exports = {
  id: 'properties',
  languages: ['asciidoc'],
  triggerCharacters: [':', '[', ','],
  diagnostics: (doc, ws) => macroDiagnostics(doc.text, ws),
  completion: (doc, position, ws) => macroCompletion(doc.text, position, ws),
  hover: (doc, position, ws) => hover(doc.text, position, ws),

  // For other modules and tests.
  findMacros,
  propertyEntry,
  propertyMarkdown,
}
