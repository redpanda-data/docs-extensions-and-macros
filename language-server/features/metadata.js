'use strict'

/**
 * :page-categories: and :page-topic-type: values, checked with the code
 * `doc-tools check-metadata` runs: checkContent and fixCategoryValue
 * (tools/check-metadata). The taxonomy is the workspace's `taxonomy` (see
 * workspace.js), which other header features read too.
 */

const { CATEGORY_ATTRIBUTE, TOPIC_TYPE_ATTRIBUTE } = require('../../extension-utils/metadata-check')
const { checkContent, fixCategoryValue, CATEGORY_SCHEMES } = require('../../tools/check-metadata')
const { inertLines, range, isHeaderLine, valueRange } = require('../lib/asciidoc')
const { SOURCE, COMPLETION_KIND, diagnostic, markdownHover } = require('../lib/lsp')

// ---------------------------------------------------------------- diagnostics

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

// ---------------------------------------------------------------- code actions

/**
 * Quick fixes for the diagnostics in a range. A deprecated :page-categories:
 * value becomes what `doc-tools check-metadata --fix` would write: its
 * replacement's preferred label, or nothing when the replacement is a task.
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

/** Taxonomy labels on a :page-categories: header line. */
function completion (text, position, workspace) {
  const lines = String(text).split(/\r?\n/)
  const line = lines[position.line] || ''
  if (inertLines(lines).has(position.line)) return []
  const before = line.slice(0, position.character)
  const categories = /^:page-categories!?:(.*)$/.exec(before)
  if (categories && isHeaderLine(lines, position.line)) return categoryCompletions(line, categories[1], position, workspace)
  return []
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

module.exports = {
  id: 'metadata',
  languages: ['asciidoc'],
  triggerCharacters: [':', ',', ' '],
  codeActionKinds: ['quickfix'],
  diagnostics: (doc, ws) => metadataDiagnostics(doc.text, ws),
  completion: (doc, position, ws) => completion(doc.text, position, ws),
  hover: (doc, position, ws) => categoryHover(doc.text, position, ws),
  codeActions: (doc, diags, ws) => codeActions(doc.text, diags, ws, doc.uri),
}
