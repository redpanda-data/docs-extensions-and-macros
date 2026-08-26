/**
 * Overrides Audit - Redpanda Connect Adapter (structural)
 *
 * Reads the rp-connect-docs docs-data/overrides.json:
 * - top-level `definitions`: shared field descriptions referenced with
 *   `{"$ref": "#/definitions/<name>"}`
 * - component sections (`inputs`, `outputs`, `processors`, `caches`,
 *   `tracers`, `scanners`, `rate-limits`): ARRAYS of connector entries
 *   `{ name, summary?, description?, config?: { children: [...] },
 *      examples?, version?, ... }` where config children nest recursively
 *   (`{ name, description?, children? , $ref? }`).
 *
 * The prose fields (summary, description, config field descriptions) map to
 * ConfigSpec strings in connect Go source (`.Summary()`, `.Description()`,
 * `NewXField(n).Description(...)`).
 *
 * TODO(quality logic): source comparison for connect is deferred. The
 * extracted side is the connect plugin JSON (rpk connect list --format json
 * or the cached connect-v<ver>.json in rp-connect-docs docs-data), and the
 * comparison must resolve $refs before classifying, then apply the same
 * markup rules as the properties surface (connect descriptions are AsciiDoc
 * inside Go strings, so xref:/glossterm: usage is docs-only there too).
 * Until then, prose fields classify REVIEW with an explicit note and
 * everything else classifies KEEP, so the manifest shape is stable.
 */

'use strict'

const classify = require('../classify')
const { loadJson } = require('./properties')

const COMPONENT_SECTIONS = [
  'inputs',
  'outputs',
  'processors',
  'caches',
  'tracers',
  'scanners',
  'rate-limits',
  'buffers',
  'metrics'
]

const TODO_NOTE = 'TODO: connect source comparison not implemented yet (needs the connect plugin JSON and $ref resolution).'

/**
 * Build a REVIEW row for a connect prose field.
 *
 * @param {string} name - Unit name (for example "inputs/amqp_0_9/urls").
 * @param {string} field - Manifest field label.
 * @param {string} text - Override text.
 * @returns {Object} Manifest row.
 */
function proseRow (name, field, text) {
  return {
    name,
    field,
    class: classify.CLASSES.REVIEW,
    content_hash: classify.contentHash(name, text),
    note: TODO_NOTE
  }
}

/**
 * Walk a config children tree, emitting one row per field description.
 *
 * @param {string} prefix - Name prefix ("inputs/amqp_0_9").
 * @param {Object[]} children - Config children array.
 * @param {Object[]} manifest - Output rows (mutated).
 */
function walkConfigChildren (prefix, children, manifest) {
  if (!Array.isArray(children)) return
  for (const child of children) {
    if (!child || typeof child !== 'object') continue
    const childName = `${prefix}/${child.name || '(unnamed)'}`
    if (typeof child.description === 'string') {
      manifest.push(proseRow(childName, 'config.description', child.description))
    }
    if (child.$ref) {
      manifest.push({
        name: childName,
        field: 'config.$ref',
        class: classify.CLASSES.KEEP,
        note: `Shared definition reference (${child.$ref}); audit the referenced definition instead.`
      })
    }
    if (child.children) walkConfigChildren(childName, child.children, manifest)
  }
}

/**
 * Run the audit for the connect surface (structural pass).
 *
 * @param {Object} args - { overridesPath, extractedPath }.
 * @returns {Object} { surface, manifest, summary }.
 */
function audit ({ overridesPath, extractedPath }) {
  const overridesDoc = loadJson(overridesPath, 'connect overrides')

  const manifest = []

  const definitions = overridesDoc.definitions
  if (definitions && typeof definitions === 'object') {
    for (const [defName, def] of Object.entries(definitions)) {
      if (def && typeof def.description === 'string') {
        manifest.push(proseRow(`definitions/${defName}`, 'description', def.description))
      }
    }
  }

  for (const section of COMPONENT_SECTIONS) {
    const entries = overridesDoc[section]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      const entryName = `${section}/${entry.name || '(unnamed)'}`
      for (const [field, value] of Object.entries(entry)) {
        if (field === 'name') continue
        if (field === 'summary' || field === 'description') {
          manifest.push(proseRow(entryName, field, value))
        } else if (field === 'config' && value && typeof value === 'object') {
          walkConfigChildren(entryName, value.children, manifest)
        } else {
          manifest.push({
            name: entryName,
            field,
            class: classify.CLASSES.KEEP,
            note: 'Docs-side connector metadata; stays in the override file by design.'
          })
        }
      }
    }
  }

  return {
    surface: 'connect',
    overrides_file: overridesPath,
    extracted_file: extractedPath || null,
    manifest,
    summary: classify.summarize(manifest)
  }
}

module.exports = { audit, COMPONENT_SECTIONS }
