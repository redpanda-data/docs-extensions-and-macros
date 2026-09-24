'use strict'

/**
 * Reduce a docs-published properties attachment
 * (modules/reference/attachments/redpanda-properties-<tag>.json) to the
 * __tests__/docs-data/property-snapshot.json mirror.
 *
 * One derivation, shared by the refresh recipe in
 * tools/property-extractor/README.adoc and by property-corpus-drift.sh, so
 * the two can never disagree about what the mirror should hold.
 *
 * Descriptions are left out, because the corpus test drives prose from the
 * overrides file and a full copy would be 695 KB of text that rots. The one
 * exception is a property whose override declares links but carries no prose
 * of its own (no description, example or admonition text): its links apply to
 * the source description, so the test needs that description to check them
 * against. Which properties that is follows from the overrides file, so
 * there is no list to maintain.
 *
 * Usage: node derive-property-snapshot.js <attachment.json> <overrides.json>
 * prints the properties object as JSON.
 */

const KEEP = ['name', 'config_scope', 'type', 'cloud_supported', 'cloud_editable',
  'cloud_readonly', 'cloud_byoc_only', 'is_deprecated', 'nullable']

function linksOnly (override) {
  if (!override || !override.links) return false
  if (typeof override.description === 'string') return false
  if (typeof override.example === 'string' || Array.isArray(override.example)) return false
  if (Array.isArray(override.admonitions) && override.admonitions.some((a) => typeof (a && a.text) === 'string')) return false
  return true
}

function deriveSnapshot (attachment, overrides) {
  const overrideProps = (overrides && overrides.properties) || {}
  const properties = {}
  for (const [name, prop] of Object.entries((attachment && attachment.properties) || {})) {
    const fields = linksOnly(overrideProps[name]) ? [...KEEP, 'description'] : KEEP
    properties[name] = Object.fromEntries(fields.filter((f) => f in prop).map((f) => [f, prop[f]]))
  }
  return properties
}

module.exports = { deriveSnapshot, linksOnly, KEEP }

if (require.main === module) {
  const fs = require('fs')
  const [attachmentPath, overridesPath] = process.argv.slice(2)
  const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
  process.stdout.write(JSON.stringify(deriveSnapshot(read(attachmentPath), read(overridesPath))))
}
