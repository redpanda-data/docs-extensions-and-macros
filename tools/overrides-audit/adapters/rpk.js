/**
 * Overrides Audit - rpk Adapter
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
 * Quality logic for prose fields, once an extracted `rpk --print-tree`
 * snapshot is available (--extracted/--repo), mirrors classify.js's
 * classifyDescription for the properties surface:
 * - Compare the override text to the SOURCE text after it has been through
 *   the same rendering pipeline production uses (see classifyProse below),
 *   not the raw cobra string -- a raw Long/Short string and its rendered
 *   AsciiDoc form routinely differ (backticking, list conversion, ...), and
 *   comparing raw-to-override misclassified nearly everything as different.
 * - Equal after classify.js's normalizeText -> REDUNDANT.
 * - Different and markup-free -> UPSTREAMABLE.
 * - Different and markup-laden -> strip the markup and compare again: KEEP
 *   when the stripped prose then matches, KEEP_UNTIL_UPSTREAMED (SPLIT) when
 *   it still doesn't.
 * - Command or flag missing from the tree (rename/removal upstream), or no
 *   tree at all (the extraction step is a separate CI change), both stay
 *   REVIEW: never guess at a comparison the audit cannot actually make.
 *
 * The extracted tree itself is a raw, PRE-override `rpk --print-tree` JSON
 * snapshot -- never one of the versioned rpk-v<ver>.json files in the docs
 * repos, which are POST-override (rpk-docs generation applies
 * rpk-overrides.json before writing them) and would classify every override
 * REDUNDANT by construction. Building that extraction step is a separate,
 * CI-side change; this module only consumes whatever tree JSON it is given.
 */

'use strict'

const classify = require('../classify')
const { loadJson } = require('./properties')
const {
  formatDescription,
  parseDescriptionSections,
  ensurePeriod
} = require('../../rpk-docs/generate-rpk-docs')

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

// Shared note for every prose row emitted when the audit was run without
// --extracted/--repo at all: there is no source text to compare against.
const NO_TREE_NOTE = 'TODO: rpk source comparison not implemented yet (needs a raw pre-override --print-tree snapshot and the formatDescription() pipeline).'

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
 * Find a flag node in a command node's `flags` array by name.
 *
 * The extracted tree stores a command's flags as an array of
 * {name, description, ...} objects (`c.LocalFlags()` in --print-tree), not
 * the keyed object rpk-overrides.json itself uses (`{"partitions": {...}}`),
 * so this always searches by `.name` rather than indexing.
 *
 * @param {Object|null} node - Command node.
 * @param {string} flagName - Flag name, with or without a leading `-`/`--`.
 * @returns {Object|null} The flag node, or null when absent.
 */
function findFlagNode (node, flagName) {
  if (!node || !Array.isArray(node.flags)) return null
  const bare = flagName.replace(/^-+/, '')
  return node.flags.find((flag) => flag && flag.name === bare) || null
}

/**
 * Build a REVIEW row for a case the audit cannot rule on: no tree given,
 * command/flag not found in the tree, or a genuinely ambiguous comparison
 * (empty override, or no comparable source text at all). Never guessed into
 * REDUNDANT/UPSTREAMABLE.
 *
 * @param {string} name - Unit name.
 * @param {string} field - Manifest field label.
 * @param {string} text - Override description text.
 * @param {Object|undefined} upstreamRef - upstream_ref carried from the override.
 * @param {string} note - Explanation shown to a reviewer.
 * @returns {Object} Manifest row.
 */
function reviewRow (name, field, text, upstreamRef, note) {
  const row = {
    name,
    field,
    class: classify.CLASSES.REVIEW,
    content_hash: classify.contentHash(name, text),
    note
  }
  if (upstreamRef !== undefined) row.upstream_ref = upstreamRef
  return row
}

/**
 * Classify override prose against the already-formatted source text it
 * would replace, mirroring classify.js's classifyDescription: equal after
 * normalizeText -> REDUNDANT; different and markup-free -> UPSTREAMABLE;
 * different and markup-laden -> strip the markup and compare again (KEEP
 * when it then matches, KEEP_UNTIL_UPSTREAMED/SPLIT when it still doesn't).
 *
 * @param {string} name - Unit name ("rpk topic create" or "rpk topic create --partitions").
 * @param {string} field - Manifest field label.
 * @param {string} overrideText - Override description text (hand-authored, final AsciiDoc prose).
 * @param {string} formattedSource - Source text through the same
 *   parseDescriptionSections/formatDescription/ensurePeriod pipeline
 *   generate-rpk-docs.js uses, or '' when there is no comparable source text.
 * @param {Object|undefined} upstreamRef - upstream_ref carried from the override.
 * @param {string} ambiguousSourceNote - Note used when formattedSource is empty.
 * @returns {Object} Manifest row.
 */
function classifyProse (name, field, overrideText, formattedSource, upstreamRef, ambiguousSourceNote) {
  if (typeof overrideText !== 'string' || overrideText.trim() === '') {
    return reviewRow(name, field, overrideText, upstreamRef,
      'The override sets an empty description. Decide whether it should be removed or given prose.')
  }
  if (!formattedSource || formattedSource.trim() === '') {
    return reviewRow(name, field, overrideText, upstreamRef, ambiguousSourceNote)
  }

  const sourceNorm = classify.normalizeText(formattedSource)
  const overrideNorm = classify.normalizeText(overrideText)
  const common = { name, field, content_hash: classify.contentHash(name, overrideText) }
  if (upstreamRef !== undefined) common.upstream_ref = upstreamRef

  if (overrideNorm === sourceNorm) {
    return {
      ...common,
      class: classify.CLASSES.REDUNDANT,
      note: 'Source description already matches the override after normalization (formatted through the same rpk-docs rendering pipeline the generator uses).'
    }
  }

  const markupKinds = classify.detectDocsMarkup(overrideText)
  if (markupKinds.length === 0) {
    return {
      ...common,
      class: classify.CLASSES.UPSTREAMABLE,
      upstream_candidate_text: overrideText,
      source_text: formattedSource,
      note: 'Override prose differs from the formatted source text and is markup-free; send upstream verbatim.'
    }
  }

  const stripped = classify.stripDocsMarkup(overrideText)
  if (stripped.trim().length === 0) {
    return reviewRow(name, field, overrideText, upstreamRef,
      `Stripping docs-only markup (${markupKinds.join(', ')}) leaves no prose at all, so there is nothing to upstream. Decide whether the source needs a real description written for it.`)
  }
  if (classify.normalizeText(stripped) === sourceNorm) {
    return {
      ...common,
      class: classify.CLASSES.KEEP,
      note: `Markup-only enrichment (${markupKinds.join(', ')}): the prose already matches the formatted source, only docs-site markup is added. Nothing to upstream.`
    }
  }

  return {
    ...common,
    class: classify.CLASSES.KEEP_UNTIL_UPSTREAMED,
    upstream_candidate_text: stripped,
    source_text: formattedSource,
    note: `SPLIT: contains docs-only markup (${markupKinds.join(', ')}). Stripped prose is the upstream candidate; keep the override until it ships.`
  }
}

/**
 * Build the manifest row for a command's own `description` field.
 *
 * The comparable source text is `parseDescriptionSections(node.description)
 * .mainDescription`: rpk help text often embeds ALL-CAPS section headers
 * (FIELDS, USAGE, ...) inline, and only the leading portion before the first
 * one is the page's main description -- the override's `description` field
 * replaces only that portion (see rpk-overrides.schema.json).
 *
 * @param {string} commandName - Full command path ("rpk topic create").
 * @param {string} text - Override description text.
 * @param {Object|undefined} upstreamRef - upstream_ref carried from the override.
 * @param {Object|null} tree - Extracted tree root, or null when none was given.
 * @param {Object|null} node - This command's tree node, or null when not found.
 * @param {Object|null} textTransformations - rpk-overrides.json's top-level textTransformations.
 * @returns {Object} Manifest row.
 */
function commandDescriptionRow (commandName, text, upstreamRef, tree, node, textTransformations) {
  if (!tree) return reviewRow(commandName, 'description', text, upstreamRef, NO_TREE_NOTE)
  if (!node) {
    return reviewRow(commandName, 'description', text, upstreamRef,
      'Command not found in the extracted rpk tree; the override may be stale.')
  }

  const rawLong = typeof node.description === 'string' ? node.description : ''
  if (!rawLong.trim()) {
    return classifyProse(commandName, 'description', text, '', upstreamRef,
      `Source has no Long or Short help text at all for '${commandName}'; nothing to compare the override against.`)
  }

  const mainDescription = parseDescriptionSections(rawLong).mainDescription
  const formattedSource = mainDescription.trim()
    ? ensurePeriod(formatDescription(mainDescription, textTransformations))
    : ''
  return classifyProse(commandName, 'description', text, formattedSource, upstreamRef,
    `Source's main description for '${commandName}' is empty once section headers (FIELDS, USAGE, ...) are parsed out; nothing to compare the override against.`)
}

/**
 * Build the manifest row for one flag's `description` field.
 *
 * Simpler than the command case: flag usage strings are one-liners, so
 * there is no section parsing, only formatDescription + ensurePeriod.
 *
 * @param {string} fullName - "rpk topic create --partitions".
 * @param {string} flagName - Flag key as it appears in rpk-overrides.json ("partitions").
 * @param {string} text - Override description text.
 * @param {Object|undefined} upstreamRef - upstream_ref carried from the override.
 * @param {Object|null} tree - Extracted tree root, or null when none was given.
 * @param {Object|null} commandNode - This flag's owning command node, or null when not found.
 * @param {Object|null} textTransformations - rpk-overrides.json's top-level textTransformations.
 * @returns {Object} Manifest row.
 */
function flagDescriptionRow (fullName, flagName, text, upstreamRef, tree, commandNode, textTransformations) {
  if (!tree) return reviewRow(fullName, 'flags.description', text, upstreamRef, NO_TREE_NOTE)
  if (!commandNode) {
    return reviewRow(fullName, 'flags.description', text, upstreamRef,
      'Command not found in the extracted rpk tree; the override may be stale.')
  }

  const flagNode = findFlagNode(commandNode, flagName)
  if (!flagNode) {
    return reviewRow(fullName, 'flags.description', text, upstreamRef,
      "Flag not found among this command's flags in the extracted rpk tree; the override may be stale or the flag renamed.")
  }

  const rawDesc = typeof flagNode.description === 'string' ? flagNode.description : ''
  const formattedSource = rawDesc.trim()
    ? ensurePeriod(formatDescription(rawDesc, textTransformations))
    : ''
  return classifyProse(fullName, 'flags.description', text, formattedSource, upstreamRef,
    `Source flag has no description text for '${fullName}'; nothing to compare the override against.`)
}

/**
 * Run the audit for the rpk surface.
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
  // Applied to every formatDescription() call below, matching production,
  // which applies the same global transformations to every command.
  const textTransformations = overridesDoc.textTransformations || null

  let tree = null
  if (extractedPath) {
    const extractedDoc = loadJson(extractedPath, 'extracted rpk tree')
    tree = extractedDoc.raw_tree || extractedDoc.tree || null
  }

  const manifest = []
  for (const [commandName, entry] of Object.entries(commands)) {
    if (typeof entry !== 'object' || entry === null) continue

    const node = tree ? findCommandNode(tree, commandName) : null

    for (const [field, value] of Object.entries(entry)) {
      if (field === 'description') {
        manifest.push(commandDescriptionRow(commandName, value, entry.upstream_ref, tree, node, textTransformations))
      } else if (field === 'flags' && value && typeof value === 'object') {
        for (const [flagName, flagEntry] of Object.entries(value)) {
          if (flagEntry && typeof flagEntry.description === 'string') {
            manifest.push(flagDescriptionRow(
              `${commandName} --${flagName}`,
              flagName,
              flagEntry.description,
              flagEntry.upstream_ref,
              tree,
              node,
              textTransformations
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
  //
  // These are not tied to any single command's tree node -- a definition is
  // reused across many commands via $ref, so there is no one flag node to
  // compare against -- and stay REVIEW/TODO regardless of whether a tree was
  // given, same as the no-tree case above.
  const definitions = overridesDoc.definitions
  if (definitions && typeof definitions === 'object') {
    for (const [defName, flags] of Object.entries(definitions)) {
      if (!flags || typeof flags !== 'object') continue
      for (const [flagName, flagEntry] of Object.entries(flags)) {
        if (flagEntry && typeof flagEntry.description === 'string') {
          manifest.push(reviewRow(
            `definitions/${defName} --${flagName}`,
            'flags.description',
            flagEntry.description,
            flagEntry.upstream_ref,
            NO_TREE_NOTE
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

module.exports = { audit, findCommandNode, findFlagNode, NON_COMMAND_KEYS }
