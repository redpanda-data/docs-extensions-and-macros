/**
 * Overrides Audit - rpk Adapter
 *
 * Reads docs-data/rpk-overrides.json (schema: docs-data/rpk-overrides.schema.json)
 * and the newest docs-data/rpk-v<version>.json snapshot, and classifies every
 * override unit:
 *
 * - command `description` and `flags.<flag>.description` are the prose
 *   fields (rpk cobra Long/Short and flag usage strings). They are compared
 *   against the snapshot's `raw_tree`, which is what the rpk binary printed
 *   BEFORE overrides were applied. Never compare against `tree`: that is the
 *   override-merged view, so every override would classify REDUNDANT.
 * - everything else (seeAlso, pageAliases, content, platform scoping,
 *   textTransformations, definitions, ...) is docs-site structure that stays
 *   in the override layer by design: KEEP.
 *
 * "Redundant" for rpk means: deleting the field changes nothing in the
 * generated page. Both sides are rendered through the generator's own
 * pipeline (mergeCommandOverrides, parseDescriptionSections,
 * formatDescription with the file's textTransformations, ensurePeriod,
 * formatExamples), imported from tools/rpk-docs/generate-rpk-docs.js rather
 * than reimplemented, so an override that only restates what the formatter
 * already does to the raw help (ALL-CAPS lines become sections, flags and
 * rpk commands get backticks, a trailing period is added) is REDUNDANT, and
 * an override that differs in substance is not.
 */

'use strict'

const classify = require('../classify')
const { loadJson } = require('./properties')
const generator = require('../../rpk-docs/generate-rpk-docs')

const { CLASSES } = classify

// Top-level keys of rpk-overrides.json that are not command entries.
const NON_COMMAND_KEYS = ['$schema', '_notes', 'textTransformations', 'definitions', 'commands']

// Per-command fields that stay in the override layer by design: page
// structure, scoping, versions, deprecation notices and curated content the
// rpk help text has no slot for.
const KEEP_BY_DESIGN_FIELDS = [
  'seeAlso',
  'pageAliases',
  'introducedInVersion',
  'platforms',
  'selfHostedOnly',
  'cloudOnly',
  'pageAttributes',
  '$refs',
  '_note',
  'content',
  'prerequisites',
  'descriptionScope',
  'appendToDescription',
  'exclude',
  'asPartial',
  'excludeFlags',
  'excludeExamples',
  'excludeAliases',
  'aliases',
  'deprecated',
  'deprecatedMessage',
  'deprecatedInVersion',
  'removedInVersion',
  'replacement',
  'minVersion'
]

// Fields the audit never classifies as override content.
const META_FIELDS = ['upstream_ref', '_comment']

// Inline AsciiDoc macros beyond classify.js's list that help text cannot
// carry: they resolve against the docs site, not the terminal.
const RPK_MACRO_PATTERNS = Object.freeze([
  { id: 'link', re: /\blink:[^\s[]+\[[^\]]*\]/ },
  { id: 'image', re: /\bimage::?[^\s[]+\[[^\]]*\]/ },
  { id: 'ui-macro', re: /\b(?:btn|menu|kbd):[^\s[]*\[[^\]]*\]/ },
  { id: 'footnote', re: /\bfootnote:[^\s[]*\[[^\]]*\]/ }
])

// AsciiDoc block constructs. Help text carries its code samples as indented
// lines and its tables as aligned columns; formatDescription converts those
// to AsciiDoc on the way out. An override written directly in AsciiDoc block
// syntax has no help-text equivalent, so it cannot go upstream verbatim and
// cannot be auto-retired either: REVIEW.
const BLOCK_PATTERNS = Object.freeze([
  { id: 'block-attribute', re: /(?:^|\n)\s*\[(?:source|,|NOTE|TIP|IMPORTANT|WARNING|CAUTION|cols|%|\.|#)[^\]]*\]\s*(?:\n|$)/ },
  { id: 'block-delimiter', re: /(?:^|\n)\s*(?:-{4,}|={4,}|\.{4,}|\*{4,}|_{4,}|\+{4,}|\|={3,})\s*(?:\n|$)/ },
  { id: 'heading', re: /(?:^|\n)={2,6}\s+\S/ }
])

/**
 * Find a command node in an rpk command tree by its full name
 * (for example "rpk topic create").
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
 * Pick the raw (pre-override) tree out of a snapshot document.
 *
 * Refuses a snapshot that only carries the override-merged `tree`: auditing
 * against it would classify every override REDUNDANT and retire them all.
 *
 * @param {Object} snapshot - Parsed rpk-v<version>.json.
 * @param {string} snapshotPath - For the error message.
 * @returns {Object} The raw tree.
 */
function rawTreeOf (snapshot, snapshotPath) {
  if (snapshot && snapshot.raw_tree && typeof snapshot.raw_tree === 'object') return snapshot.raw_tree
  if (snapshot && snapshot.name === 'rpk' && Array.isArray(snapshot.commands)) {
    // A bare `rpk --print-tree` dump: raw by definition.
    return snapshot
  }
  throw new Error(
    `rpk snapshot ${snapshotPath} has no "raw_tree". The audit needs the pre-override tree the binary printed; ` +
    'the "tree" key is the override-merged view and would classify every override REDUNDANT. ' +
    'Pass the newest docs-data/rpk-v<version>.json written by `doc-tools generate rpk-docs`.'
  )
}

/**
 * Render a description the way the generator renders it onto the page:
 * main text and sections through formatDescription (EXAMPLES through the
 * examples pipeline), whitespace-normalized for comparison.
 *
 * @param {string} description - Merged or raw command description.
 * @param {Object} command - The (merged) command, for excludeExamples.
 * @param {Object|null} tt - textTransformations from the overrides file.
 * @returns {{main: string, sections: Object<string,string>}} Rendered parts.
 */
function renderDescription (description, command, tt) {
  const { mainDescription, sections } = generator.parseDescriptionSections(description || '')
  const rendered = {
    main: classify.normalizeText(generator.ensurePeriod(generator.formatDescription(mainDescription, tt))),
    sections: {}
  }
  for (const [name, content] of Object.entries(sections)) {
    if (name === 'EXAMPLES') {
      let examples = content
      if (command && Array.isArray(command.excludeExamples) && command.excludeExamples.length > 0) {
        examples = generator.filterExamples(examples, command.excludeExamples)
      }
      examples = generator.applyTextTransformationsToExamples(examples, tt)
      rendered.sections[name] = classify.normalizeText(generator.formatExamples(examples))
    } else {
      rendered.sections[name] = classify.normalizeText(generator.formatDescription(content, tt))
    }
  }
  return rendered
}

/**
 * Render a flag description the way the generator does.
 *
 * @param {string} description - Flag usage string.
 * @param {Object|null} tt - textTransformations.
 * @returns {string} Rendered, normalized text.
 */
function renderFlag (description, tt) {
  return classify.normalizeText(generator.ensurePeriod(generator.formatDescription(description || '', tt)))
}

/**
 * Everything the generator emits for one command that an override can change
 * through its prose fields, rendered and normalized.
 *
 * @param {Object} rawNode - Command node from raw_tree.
 * @param {Object} resolvedOverrides - Overrides with $refs resolved.
 * @param {string} commandPath - Full command name.
 * @param {Object|null} tt - textTransformations.
 * @returns {Object} { description, flags } rendered parts.
 */
function renderCommand (rawNode, resolvedOverrides, commandPath, tt) {
  const merged = generator.mergeCommandOverrides(rawNode, resolvedOverrides, commandPath)
  return {
    description: renderDescription(merged.description, merged, tt),
    flags: (merged.flags || []).map((flag) => [flag.name, renderFlag(flag.description, tt)])
  }
}

/**
 * A copy of the resolved overrides with one field removed from one command
 * entry (or one flag of it), so the generator's output with and without the
 * field can be compared.
 *
 * @param {Object} resolvedOverrides - Overrides with $refs resolved.
 * @param {string} commandPath - Command entry key.
 * @param {string} field - 'description' or 'flags'.
 * @param {string} [flagName] - Flag whose description to remove.
 * @returns {Object} New overrides object sharing every other entry.
 */
function withoutField (resolvedOverrides, commandPath, field, flagName) {
  const entry = { ...resolvedOverrides.commands[commandPath] }
  if (field === 'description') {
    delete entry.description
  } else {
    const flags = { ...(entry.flags || {}) }
    const flag = { ...(flags[flagName] || {}) }
    delete flag.description
    flags[flagName] = flag
    entry.flags = flags
  }
  return { ...resolvedOverrides, commands: { ...resolvedOverrides.commands, [commandPath]: entry } }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Which parts of two rendered descriptions differ: 'main' and/or
 * 'section:NAME' for each section present on either side with different
 * content (or present on one side only). Tells a reviewer whether an
 * override rewrites the lead paragraph or only touches, say, EXAMPLES.
 *
 * @param {Object} a - renderDescription() output.
 * @param {Object} b - renderDescription() output.
 * @returns {string[]} Differing parts, in page order.
 */
function describeDifference (a, b) {
  const parts = []
  if (a.main !== b.main) parts.push('main')
  const names = [...new Set([...Object.keys(a.sections), ...Object.keys(b.sections)])]
  for (const name of names) {
    if (a.sections[name] !== b.sections[name]) parts.push(`section:${name}`)
  }
  return parts
}

/**
 * Docs-only markup kinds in a piece of rpk override prose: classify.js's
 * detectors (xref, glossterm, include, conditionals, pass, <<anchor>>,
 * prop:/config_ref:, audience prefixes, {attr}) plus the inline macros above.
 *
 * @param {string} text - Override text.
 * @returns {string[]} Markup kind ids (empty when help text could carry it).
 */
function detectRpkDocsMarkup (text) {
  const kinds = classify.detectDocsMarkup(text)
  for (const { id, re } of RPK_MACRO_PATTERNS) {
    if (re.test(text)) kinds.push(id)
  }
  return kinds
}

/**
 * AsciiDoc block constructs in a piece of rpk override prose.
 *
 * @param {string} text - Override text.
 * @returns {string[]} Construct ids (empty when none).
 */
function detectBlockMarkup (text) {
  const kinds = []
  for (const { id, re } of BLOCK_PATTERNS) {
    if (re.test(text)) kinds.push(id)
  }
  return kinds
}

/**
 * Build one manifest row for a prose field.
 *
 * @param {Object} fields - Row fields.
 * @returns {Object} Row with stable key order.
 */
function proseRow (fields) {
  const row = { name: fields.name, field: fields.field, class: fields.class }
  for (const key of ['upstream_candidate_text', 'upstream_ref', 'content_hash', 'source_text', 'rendered_text', 'differs_in', 'note']) {
    if (fields[key] !== undefined) row[key] = fields[key]
  }
  return row
}

/**
 * Classify one prose override (a command description or a flag description)
 * given the generator's output with and without it.
 *
 * @param {Object} args
 * @param {string} args.name - Unit name.
 * @param {string} args.field - 'description' or 'flags.description'.
 * @param {string} args.overrideText - The override text as written.
 * @param {string|undefined} args.upstreamRef - upstream_ref from the override.
 * @param {boolean} args.equal - Whether the rendered output is unchanged without the override.
 * @param {string} args.sourceText - Rendered raw text (what the page shows without the override).
 * @param {string} args.renderedText - Rendered override text.
 * @param {string|undefined} args.scope - descriptionScope on the command entry.
 * @param {string[]} [args.differsIn] - Which rendered parts differ ('main', 'section:NAME').
 * @returns {Object} Manifest row.
 */
function classifyProse ({ name, field, overrideText, upstreamRef, equal, sourceText, renderedText, scope, differsIn }) {
  const common = {
    name,
    field,
    content_hash: classify.contentHash(name, overrideText),
    source_text: sourceText,
    rendered_text: renderedText
  }
  if (upstreamRef !== undefined) common.upstream_ref = upstreamRef
  if (!equal && Array.isArray(differsIn) && differsIn.length > 0) common.differs_in = differsIn

  if (equal) {
    return proseRow({
      ...common,
      class: CLASSES.REDUNDANT,
      note: 'Generated output is identical without this override (raw help text renders the same after the generator\'s formatting). Safe to delete.'
    })
  }

  if (scope && scope !== 'both') {
    return proseRow({
      ...common,
      class: CLASSES.KEEP,
      note: `Audience-scoped description (descriptionScope: ${scope}); rpk help text has one audience, so this stays docs-only.`
    })
  }

  const markup = detectRpkDocsMarkup(overrideText)
  if (markup.length > 0) {
    return proseRow({
      ...common,
      class: CLASSES.KEEP,
      note: `Contains docs-only markup (${markup.join(', ')}) that rpk help text cannot carry; docs-layer enrichment by design.`
    })
  }

  const blocks = detectBlockMarkup(overrideText)
  if (blocks.length > 0) {
    return proseRow({
      ...common,
      class: CLASSES.REVIEW,
      note: `Written in AsciiDoc block syntax (${blocks.join(', ')}); help text carries code and tables as indented lines, so this cannot go upstream verbatim. Rewrite in help-text form or keep deliberately.`
    })
  }

  return proseRow({
    ...common,
    class: CLASSES.UPSTREAMABLE,
    upstream_candidate_text: overrideText,
    note: 'Override prose differs from the raw help text and is free of docs-only markup; it can replace the Long/Short or flag usage string in src/go/rpk verbatim.'
  })
}

/**
 * Classify every unit of one command entry.
 *
 * @param {string} commandName - Command entry key.
 * @param {Object} entry - The override entry, as written (unresolved).
 * @param {Object} ctx - { rawTree, resolvedOverrides, tt }.
 * @returns {Object[]} Manifest rows.
 */
function classifyCommandEntry (commandName, entry, ctx) {
  const rows = []
  const node = findCommandNode(ctx.rawTree, commandName)
  const scope = typeof entry.descriptionScope === 'string' ? entry.descriptionScope : undefined

  // Rendered once per command: with every override, and with one field
  // removed at a time. Both sides go through the same generator functions.
  const withAll = node ? renderCommand(node, ctx.resolvedOverrides, commandName, ctx.tt) : null

  for (const [field, value] of Object.entries(entry)) {
    if (META_FIELDS.includes(field)) continue

    if (field === 'description') {
      if (typeof value !== 'string') {
        rows.push(proseRow({ name: commandName, field, class: CLASSES.REVIEW, note: `description is not a string (${typeof value}); malformed.` }))
        continue
      }
      if (!node) {
        rows.push(proseRow({
          name: commandName,
          field,
          class: CLASSES.REVIEW,
          content_hash: classify.contentHash(commandName, value),
          upstream_ref: entry.upstream_ref,
          note: 'Command not found in the snapshot\'s raw_tree; the override may be stale, or the command belongs to a plugin missing from this snapshot.'
        }))
        continue
      }
      const without = renderCommand(node, withoutField(ctx.resolvedOverrides, commandName, 'description'), commandName, ctx.tt)
      rows.push(classifyProse({
        name: commandName,
        field,
        overrideText: value,
        upstreamRef: entry.upstream_ref,
        equal: same(withAll.description, without.description),
        sourceText: without.description.main,
        renderedText: withAll.description.main,
        scope,
        differsIn: describeDifference(withAll.description, without.description)
      }))
      continue
    }

    if (field === 'flags') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        rows.push(proseRow({ name: commandName, field, class: CLASSES.REVIEW, note: 'flags is not an object; malformed.' }))
        continue
      }
      for (const [flagName, flagEntry] of Object.entries(value)) {
        if (!flagEntry || typeof flagEntry !== 'object') continue
        const unitName = `${commandName} --${flagName}`
        for (const [flagField, flagValue] of Object.entries(flagEntry)) {
          if (META_FIELDS.includes(flagField)) continue
          if (flagField !== 'description') {
            rows.push({
              name: unitName,
              field: `flags.${flagField}`,
              class: CLASSES.KEEP,
              note: 'Flag metadata the help text has no slot for; stays in the override file by design.'
            })
            continue
          }
          if (typeof flagValue !== 'string') {
            rows.push(proseRow({ name: unitName, field: 'flags.description', class: CLASSES.REVIEW, note: 'flag description is not a string; malformed.' }))
            continue
          }
          const base = { name: unitName, field: 'flags.description', content_hash: classify.contentHash(unitName, flagValue), upstream_ref: flagEntry.upstream_ref }
          if (!node) {
            rows.push(proseRow({ ...base, class: CLASSES.REVIEW, note: 'Command not found in the snapshot\'s raw_tree; the override may be stale.' }))
            continue
          }
          const rawFlag = (node.flags || []).find((f) => f && f.name === flagName)
          if (!rawFlag) {
            rows.push(proseRow({
              ...base,
              class: CLASSES.REVIEW,
              note: `Flag --${flagName} is not on this command in raw_tree, so the generator never applies this override (it may be a global -X flag, renamed, or removed). Delete or move it.`
            }))
            continue
          }
          const without = renderCommand(node, withoutField(ctx.resolvedOverrides, commandName, 'flags', flagName), commandName, ctx.tt)
          const pick = (rendered) => (rendered.flags.find(([n]) => n === flagName) || [])[1] || ''
          rows.push(classifyProse({
            name: unitName,
            field: 'flags.description',
            overrideText: flagValue,
            upstreamRef: flagEntry.upstream_ref,
            equal: pick(withAll) === pick(without),
            sourceText: pick(without),
            renderedText: pick(withAll)
          }))
        }
      }
      continue
    }

    if (KEEP_BY_DESIGN_FIELDS.includes(field)) {
      rows.push({
        name: commandName,
        field,
        class: CLASSES.KEEP,
        note: 'Docs-site structure; stays in the rpk override file by design.'
      })
      continue
    }

    rows.push({
      name: commandName,
      field,
      class: CLASSES.KEEP,
      note: `Unrecognized rpk override field '${field}'; kept, verify it against docs-data/rpk-overrides.schema.json.`
    })
  }
  return rows
}

/**
 * Retirement safety check: delete every REDUNDANT prose field from a copy of
 * the overrides, re-render every command in the raw tree with the full and
 * the pruned overrides, and report any command whose output differs. The
 * classifier's definition of REDUNDANT is exactly "output unchanged", so
 * `violations` is expected to be empty; a non-empty list is a classifier bug
 * (for example two fields that are each redundant alone but not together).
 *
 * @param {Object} rawTree - The raw command tree.
 * @param {Object} overridesDoc - Overrides as written.
 * @param {Object[]} manifest - Classified rows.
 * @returns {Object} { redundant_fields_removed, commands_compared, violations }.
 */
function crossCheck (rawTree, overridesDoc, manifest) {
  const pruned = JSON.parse(JSON.stringify(overridesDoc))
  let removed = 0
  for (const row of manifest) {
    if (row.class !== CLASSES.REDUNDANT) continue
    if (row.field === 'description') {
      if (pruned.commands[row.name]) {
        delete pruned.commands[row.name].description
        removed++
      }
    } else if (row.field === 'flags.description') {
      const at = row.name.lastIndexOf(' --')
      const commandName = row.name.slice(0, at)
      const flagName = row.name.slice(at + 3)
      const flags = pruned.commands[commandName] && pruned.commands[commandName].flags
      if (flags && flags[flagName]) {
        delete flags[flagName].description
        removed++
      }
    }
  }

  const full = generator.resolveReferences(overridesDoc, overridesDoc)
  const prunedResolved = generator.resolveReferences(pruned, pruned)
  const tt = full.textTransformations || null
  const violations = []
  const commands = generator.flattenCommands(rawTree)
  for (const { path: commandPath, command } of commands) {
    const a = renderCommand(command, full, commandPath, tt)
    const b = renderCommand(command, prunedResolved, commandPath, tt)
    if (!same(a, b)) violations.push(commandPath)
  }
  return { redundant_fields_removed: removed, commands_compared: commands.length, violations }
}

/**
 * Run the audit for the rpk surface.
 *
 * @param {Object} args - { overridesPath, extractedPath }.
 * @returns {Object} { surface, manifest, summary, cross_check }.
 */
function audit ({ overridesPath, extractedPath }) {
  const overridesDoc = loadJson(overridesPath, 'rpk overrides')
  const commands = overridesDoc.commands
  if (!commands || typeof commands !== 'object') {
    throw new Error(`rpk overrides file ${overridesPath} has no top-level "commands" object`)
  }
  if (!extractedPath) {
    throw new Error('The rpk surface needs --extracted <path>: the newest docs-data/rpk-v<version>.json snapshot (its raw_tree is the pre-override help text)')
  }
  const snapshot = loadJson(extractedPath, 'rpk snapshot')
  const rawTree = rawTreeOf(snapshot, extractedPath)

  // The generator resolves $refs once per run and wraps known multi-word
  // command paths as a unit when formatting; do the same so both sides of
  // every comparison are formatted exactly as the page would be.
  const resolvedOverrides = generator.resolveReferences(overridesDoc, overridesDoc)
  const tt = resolvedOverrides.textTransformations || null
  generator.registerKnownCommandPaths(generator.flattenCommands(rawTree).map((c) => c.path))

  const ctx = { rawTree, resolvedOverrides, tt }
  const manifest = []

  for (const [commandName, entry] of Object.entries(commands)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      manifest.push({ name: commandName, field: '(entry)', class: CLASSES.REVIEW, note: `Override entry is not an object (${typeof entry}); malformed.` })
      continue
    }
    manifest.push(...classifyCommandEntry(commandName, entry, ctx))
  }

  // Shared flag definitions, merged into commands through $refs. Their text
  // applies to every referencing command at once and the generator only
  // honors it where the flag actually exists on the command, so they are
  // docs-layer structure here: retire a shared description per command once
  // every referencing command's row says REDUNDANT.
  const definitions = overridesDoc.definitions
  if (definitions && typeof definitions === 'object') {
    for (const [defName, flags] of Object.entries(definitions)) {
      if (!flags || typeof flags !== 'object') continue
      const refs = Object.entries(commands)
        .filter(([, entry]) => entry && Array.isArray(entry.$refs) && entry.$refs.includes(`#/definitions/${defName}`))
        .map(([name]) => name)
      for (const [flagName, flagEntry] of Object.entries(flags)) {
        if (!flagEntry || typeof flagEntry !== 'object') continue
        for (const [flagField, flagValue] of Object.entries(flagEntry)) {
          if (META_FIELDS.includes(flagField)) continue
          const row = {
            name: `definitions/${defName} --${flagName}`,
            field: `flags.${flagField}`,
            class: CLASSES.KEEP
          }
          if (flagField === 'description' && typeof flagValue === 'string') {
            row.content_hash = classify.contentHash(row.name, flagValue)
            if (flagEntry.upstream_ref !== undefined) row.upstream_ref = flagEntry.upstream_ref
          }
          row.note = `Shared flag definition referenced by ${refs.length} command(s) via $refs; applied per command, so it is docs-layer structure here.`
          manifest.push(row)
        }
      }
    }
  }

  // Global text transformations: docs-only by construction (they rewrite
  // every description on the way to AsciiDoc).
  const tts = overridesDoc.textTransformations
  if (tts && typeof tts === 'object') {
    for (const key of ['replacements', 'inlineCode']) {
      if (!Array.isArray(tts[key])) continue
      manifest.push({
        name: 'textTransformations',
        field: key,
        class: CLASSES.KEEP,
        note: `${tts[key].length} global ${key} rule(s) applied to every description during generation; docs-layer by design.`
      })
    }
  }

  return {
    surface: 'rpk',
    overrides_file: overridesPath,
    extracted_file: extractedPath,
    snapshot_version: snapshot.rpk_version || null,
    manifest,
    summary: classify.summarize(manifest),
    cross_check: crossCheck(rawTree, overridesDoc, manifest)
  }
}

module.exports = {
  audit,
  findCommandNode,
  rawTreeOf,
  renderDescription,
  renderFlag,
  detectRpkDocsMarkup,
  detectBlockMarkup,
  classifyProse,
  describeDifference,
  crossCheck,
  NON_COMMAND_KEYS,
  KEEP_BY_DESIGN_FIELDS
}
