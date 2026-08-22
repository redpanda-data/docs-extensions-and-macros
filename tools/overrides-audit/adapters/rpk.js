/**
 * Overrides Audit - rpk Adapter (structural)
 *
 * Reads docs-data/rpk-overrides.json (schema: docs-data/rpk-overrides.schema.json)
 * and enumerates every override unit per command:
 * - command `description` and `flags.<flag>.description` are the
 *   upstreamable prose fields (rpk cobra Short/Long and flag usage strings)
 * - everything else (seeAlso, pageAliases, introducedInVersion, platforms,
 *   selfHostedOnly, pageAttributes, $refs, _note, content, prerequisites,
 *   descriptionScope, appendToDescription, exclude, asPartial) is docs-site
 *   structure that stays in the override layer by design.
 *
 * TODO(quality logic): source comparison for rpk descriptions is deferred.
 * Two blockers, both known:
 * 1. The versioned rpk-v<ver>.json files in docs repos are POST-override
 *    snapshots (rpk-docs generation applies rpk-overrides.json before
 *    writing them), so auditing against them classifies every override
 *    REDUNDANT. The audit needs a raw `rpk --print-tree` snapshot instead.
 * 2. Generated docs pass source strings through formatDescription()
 *    (tools/rpk-docs/generate-rpk-docs.js) — ~40 regex passes (md->adoc,
 *    auto-backticking, ensurePeriod, ...). Equality must be computed on
 *    formatDescription(source) vs the override, not on the raw cobra string,
 *    or near-identical strings will misclassify as UPSTREAMABLE.
 * Until then, prose fields classify REVIEW with an explicit note, and
 * docs-structure fields classify KEEP, so the manifest shape is already
 * stable for the retirement workflow.
 */

'use strict'

const classify = require('../classify')
const { loadJson } = require('./properties')

// Top-level keys of rpk-overrides.json that are not command entries.
const NON_COMMAND_KEYS = ['$schema', '_notes', 'textTransformations', 'definitions']

// Per-command fields that stay in the override layer by design.
const KEEP_BY_DESIGN_FIELDS = [
  'seeAlso',
  'pageAliases',
  'introducedInVersion',
  'platforms',
  'selfHostedOnly',
  'pageAttributes',
  '$refs',
  '_note',
  'content',
  'prerequisites',
  'descriptionScope',
  'appendToDescription',
  'exclude',
  'asPartial'
]

/**
 * Find a command node in an extracted `rpk --print-tree` JSON by its full
 * name (for example "rpk topic create").
 *
 * @param {Object} tree - Root tree node ({ name, commands: [...] }).
 * @param {string} fullName - Space-separated command path.
 * @returns {Object|null} The command node, or null when absent.
 */
function findCommandNode (tree, fullName) {
  if (!tree || typeof tree !== 'object') return null
  const parts = fullName.trim().split(/\s+/)
  if (parts[0] !== tree.name) return null
  let node = tree
  for (const part of parts.slice(1)) {
    const children = Array.isArray(node.commands) ? node.commands : []
    node = children.find((child) => child && child.name === part) || null
    if (!node) return null
  }
  return node
}

/**
 * Build the manifest row for an rpk prose field (deferred quality logic).
 *
 * @param {string} name - Unit name ("rpk topic create" or "rpk topic create --partitions").
 * @param {string} field - Manifest field label.
 * @param {string} text - Override description text.
 * @param {Object|undefined} upstreamRef - upstream_ref carried from the override.
 * @param {boolean|null} foundInTree - Whether the command exists in the extracted tree (null when no tree given).
 * @returns {Object} Manifest row.
 */
function proseRow (name, field, text, upstreamRef, foundInTree) {
  const row = {
    name,
    field,
    class: classify.CLASSES.REVIEW,
    content_hash: classify.contentHash(name, text)
  }
  if (upstreamRef !== undefined) row.upstream_ref = upstreamRef
  if (foundInTree === false) {
    row.note = 'Command not found in the extracted rpk tree; the override may be stale. TODO: rpk source comparison not implemented yet.'
  } else {
    row.note = 'TODO: rpk source comparison not implemented yet (needs a raw pre-override --print-tree snapshot and the formatDescription() pipeline).'
  }
  return row
}

/**
 * Run the audit for the rpk surface (structural pass).
 *
 * @param {Object} args - { overridesPath, extractedPath }.
 * @returns {Object} { surface, manifest, summary }.
 */
function audit ({ overridesPath, extractedPath }) {
  const overridesDoc = loadJson(overridesPath, 'rpk overrides')
  const commands = overridesDoc.commands
  if (!commands || typeof commands !== 'object') {
    throw new Error(`rpk overrides file ${overridesPath} has no top-level "commands" object`)
  }

  let tree = null
  if (extractedPath) {
    const extractedDoc = loadJson(extractedPath, 'extracted rpk tree')
    tree = extractedDoc.raw_tree || extractedDoc.tree || null
  }

  const manifest = []
  for (const [commandName, entry] of Object.entries(commands)) {
    if (typeof entry !== 'object' || entry === null) continue

    const node = tree ? findCommandNode(tree, commandName) : null
    const foundInTree = tree ? node !== null : null

    for (const [field, value] of Object.entries(entry)) {
      if (field === 'description') {
        manifest.push(proseRow(commandName, 'description', value, entry.upstream_ref, foundInTree))
      } else if (field === 'flags' && value && typeof value === 'object') {
        for (const [flagName, flagEntry] of Object.entries(value)) {
          if (flagEntry && typeof flagEntry.description === 'string') {
            manifest.push(proseRow(
              `${commandName} --${flagName}`,
              'flags.description',
              flagEntry.description,
              flagEntry.upstream_ref,
              foundInTree
            ))
          }
        }
      } else if (field === 'upstream_ref' || field === '_comment') {
        // Meta fields; upstream_ref is carried onto the prose rows above.
      } else if (KEEP_BY_DESIGN_FIELDS.includes(field)) {
        manifest.push({
          name: commandName,
          field,
          class: classify.CLASSES.KEEP,
          note: 'Docs-site structure; stays in the rpk override file by design.'
        })
      } else {
        manifest.push({
          name: commandName,
          field,
          class: classify.CLASSES.KEEP,
          note: `Unrecognized rpk override field '${field}'; kept, verify it against docs-data/rpk-overrides.schema.json.`
        })
      }
    }
  }

  // Shared flag definitions referenced via $refs also carry descriptions.
  // Shape: definitions.<def-name>.<flag-name>.description
  const definitions = overridesDoc.definitions
  if (definitions && typeof definitions === 'object') {
    for (const [defName, flags] of Object.entries(definitions)) {
      if (!flags || typeof flags !== 'object') continue
      for (const [flagName, flagEntry] of Object.entries(flags)) {
        if (flagEntry && typeof flagEntry.description === 'string') {
          manifest.push(proseRow(
            `definitions/${defName} --${flagName}`,
            'flags.description',
            flagEntry.description,
            flagEntry.upstream_ref,
            null
          ))
        }
      }
    }
  }

  return {
    surface: 'rpk',
    overrides_file: overridesPath,
    extracted_file: extractedPath || null,
    manifest,
    summary: classify.summarize(manifest)
  }
}

module.exports = { audit, findCommandNode, NON_COMMAND_KEYS }
