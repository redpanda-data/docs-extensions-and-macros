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
 * overrides file and a full copy would be 695 KB of text that rots. Two
 * exceptions, both overrides that act on the source description rather than
 * replacing it:
 *
 * - links with no prose of its own (no description, example or admonition
 *   text): the links apply to the source description, so the test needs it
 *   to check them against.
 * - includes with no description of its own: the generator appends each
 *   include:: directive to the source description, so without it there is
 *   nothing to append to.
 *
 * Which properties those are follows from the overrides file, so there is no
 * list to maintain.
 *
 * Usage: node derive-property-snapshot.js <attachment.json> <overrides.json>
 * prints the properties object as JSON.
 */

const path = require('path')
const { normalizeIncludes } = require(path.join(__dirname, '../../tools/property-extractor/helpers/applyPropertyLinks.js'))

const KEEP = ['name', 'config_scope', 'type', 'cloud_supported', 'cloud_editable',
  'cloud_readonly', 'cloud_byoc_only', 'is_deprecated', 'nullable']

function linksOnly (override) {
  if (!override || !override.links) return false
  if (typeof override.description === 'string' || Array.isArray(override.description)) return false
  if (typeof override.example === 'string' || Array.isArray(override.example)) return false
  if (Array.isArray(override.admonitions) && override.admonitions.some((a) => typeof (a && a.text) === 'string')) return false
  return true
}

function includesOnly (override) {
  if (!override || override.includes === undefined) return false
  return override.description === undefined
}

function needsSourceDescription (override) {
  return linksOnly(override) || includesOnly(override)
}

// The published attachment is not the extractor's output: the generator
// appends each declared include:: directive to the attachment's description
// (generate-handlebars-docs.js, so the tooltip still renders it). Keeping that
// text as the source description would emit every include twice, once from
// the description and once from `includes`, so strip the appended copies.
function stripAppendedIncludes (description, includes) {
  if (typeof description !== 'string') return description
  let text = description
  // Normalized by the generator's own helper, so a scoped or bare entry
  // resolves to exactly the directive the generator appended.
  // Last appended, first stripped.
  for (const item of normalizeIncludes('', includes, []).reverse()) {
    const directive = `include::${item.target}`
    const tail = item.cloud_only
      ? `\n\nifdef::env-cloud[]\n${directive}\nendif::[]`
      : item.self_managed_only
        ? `\n\nifndef::env-cloud[]\n${directive}\nendif::[]`
        : `\n\n${directive}`
    if (text.endsWith(tail)) text = text.slice(0, -tail.length)
  }
  return text
}

function deriveSnapshot (attachment, overrides) {
  const overrideProps = (overrides && overrides.properties) || {}
  const properties = {}
  for (const [name, prop] of Object.entries((attachment && attachment.properties) || {})) {
    const override = overrideProps[name]
    const fields = needsSourceDescription(override) ? [...KEEP, 'description'] : KEEP
    properties[name] = Object.fromEntries(fields.filter((f) => f in prop).map((f) => [f, prop[f]]))
    if (includesOnly(override) && 'description' in properties[name]) {
      properties[name].description = stripAppendedIncludes(properties[name].description, override.includes)
    }
  }
  return properties
}

module.exports = { deriveSnapshot, linksOnly, includesOnly, needsSourceDescription, stripAppendedIncludes, KEEP }

if (require.main === module) {
  const fs = require('fs')
  const [attachmentPath, overridesPath] = process.argv.slice(2)
  const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
  process.stdout.write(JSON.stringify(deriveSnapshot(read(attachmentPath), read(overridesPath))))
}
