/**
 * Overrides Audit - Metrics Adapter
 *
 * Reads docs-data/metric-overrides.json and a source inventory from
 * tools/metrics/extract_source.py, and classifies every override field.
 * Only `description` is text that can go upstream: it stands in for the help
 * string of the metric's registration in the Redpanda source. Classification
 * reuses classify.classifyDescription, with these rules for metrics:
 *
 * - The comparison uses the unprefixed paragraphs only. Paragraphs that start
 *   with cloud-only: or self-managed-only: are enrichment. They are never
 *   upstreamed and never retired.
 * - A help string takes no terminal period, so the candidate text has none,
 *   and an override that differs from source only by that period is
 *   REDUNDANT. Otherwise an override would never match the string it was
 *   upstreamed as.
 * - A family whose help is built at run time, or that has no help string in
 *   the Redpanda source, has no string to rewrite. It is REVIEW.
 * - One registration can export several families (redpanda_x and
 *   vectorized_x, or one family per group). They share one help string, so
 *   their overrides must agree, and only one row carries the candidate.
 */

'use strict'

const path = require('path')
const { spawnSync } = require('child_process')
const classify = require('../classify')
const { loadJson } = require('./properties')

const { CLASSES } = classify
const EXTRACTOR = path.join(__dirname, '..', '..', 'metrics', 'extract_source.py')

// Annotations on an override. They are not override content.
const META_FIELDS = ['upstream_ref', '_comment', 'retirement_pending', 'upstream_not_possible']
// Stopgaps the release run compares with the scrape and the tooling.
const RELEASE_RUN_FIELDS = ['unit', 'labels', 'requires']

/**
 * List the metric families a Redpanda checkout registers at a git ref.
 *
 * The extractor exits 3 when it cannot resolve a registration. It still
 * prints every family it resolved, so that is a warning here.
 *
 * @param {string} repoPath - Path to a streaming-enterprise checkout.
 * @param {string} [ref] - Git ref to read. Defaults to HEAD.
 * @param {Function} [log] - Receives progress and warnings.
 * @returns {Object} The inventory ({ ref, public, internal, unresolved }).
 */
function extractInventory (repoPath, ref = 'HEAD', log = () => {}) {
  let result = null
  for (const python of ['python3', 'python']) {
    result = spawnSync(python, ['-I', EXTRACTOR, '--repo', repoPath, '--ref', ref], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024
    })
    if (!result.error) break
  }
  if (result.error) {
    throw new Error(`Cannot run the metrics source extractor (python3 is needed): ${result.error.message}`)
  }
  if (result.status !== 0 && result.status !== 3) {
    throw new Error(`The metrics source extractor failed in ${repoPath} at ${ref}: ${(result.stderr || '').trim()}`)
  }
  let inventory
  try {
    inventory = JSON.parse(result.stdout)
  } catch (err) {
    throw new Error(`The metrics source extractor printed no valid JSON for ${repoPath} at ${ref}: ${err.message}`)
  }
  if (result.status === 3) {
    const count = Array.isArray(inventory.unresolved) ? inventory.unresolved.length : 0
    log(`Warning: the extractor could not resolve ${count} registration(s) at ${ref}. An override for one of those metrics is reported as not in the inventory.`)
  }
  return inventory
}

/**
 * Remove one terminal period. An ellipsis stays.
 *
 * @param {string} text - Candidate text.
 * @returns {string} Text without a terminal period.
 */
function stripTerminalPeriod (text) {
  return text.trim().replace(/(?<!\.)\.$/, '')
}

/**
 * Why a family has no help string to rewrite, or null when it has one.
 *
 * @param {Object} family - Inventory entry.
 * @returns {string|null} Reason for the row note.
 */
function noHelpReason (family) {
  if (family.help_runtime) {
    return `The help string is built at run time (${family.defined_in}), so there is no single string to rewrite. The override stays until a person changes how the source builds it.`
  }
  if (typeof family.help !== 'string') {
    if (family.origin && family.origin !== 'src/v') {
      return `The help string comes from Seastar (${family.defined_in}), not from the Redpanda source, so there is nothing to rewrite there.`
    }
    return `The registration has no help string (${family.defined_in}), so there is nothing to rewrite. Decide whether the source should gain one.`
  }
  return null
}

/**
 * Classify the description of one override.
 *
 * @param {string} name - Metric family name.
 * @param {Object} override - Override entry.
 * @param {Object|null} family - Inventory entry, or null.
 * @returns {Object} Manifest row.
 */
function classifyMetricDescription (name, override, family) {
  const { prose, scoped, scopedParagraphs } = classify.unconditionalProse(override.description)
  const base = {
    name,
    field: 'description',
    content_hash: classify.contentHash(name, prose),
    source_file: family ? family.defined_in : undefined,
    source_line: family ? family.line : undefined
  }
  if (override.upstream_ref !== undefined) base.upstream_ref = override.upstream_ref
  if (scoped > 0) base.audience_scoped_text = scopedParagraphs

  if (override.retirement_pending !== undefined) {
    return classify.row({
      ...base,
      class: CLASSES.KEEP,
      note: 'Marked retirement_pending. The next release run deletes the text, so it is not a candidate.'
    })
  }
  if (!family) {
    return classify.row({
      ...base,
      class: CLASSES.REVIEW,
      note: 'Metric not present in the source inventory. It was renamed or removed, or the extractor could not resolve its registration.'
    })
  }
  if (prose.length === 0 && scoped > 0) {
    return classify.row({
      ...base,
      class: CLASSES.KEEP,
      note: `Only audience paragraphs (${scoped}). They are enrichment, so there is nothing to upstream.`
    })
  }
  const reason = noHelpReason(family)
  const marked = typeof override.upstream_not_possible === 'string' && override.upstream_not_possible.trim()
  if (reason && marked) {
    // A person has recorded that this text cannot go upstream, so it is kept
    // and not listed for review again.
    return classify.row({ ...base, class: CLASSES.KEEP, note: `${reason} Marked upstream_not_possible: ${marked}` })
  }
  if (reason) {
    return classify.row({
      ...base,
      class: CLASSES.REVIEW,
      note: `${reason} If the override should stay, set upstream_not_possible on it with the reason, and it is not listed again.`
    })
  }

  // The shared classifier, on the unprefixed text only.
  const result = classify.classifyDescription(
    name,
    { ...override, description: prose },
    { description: family.help, defined_in: family.defined_in, line_start: family.line }
  )
  if (scoped > 0) result.audience_scoped_text = scopedParagraphs
  const audienceNote = scoped > 0 ? ` ${scoped} audience paragraph(s) stay in the override.` : ''

  if (result.upstream_candidate_text !== undefined) {
    const candidate = stripTerminalPeriod(result.upstream_candidate_text)
    if (classify.normalizeText(candidate) === stripTerminalPeriod(result.source_text)) {
      // The release run (tools/metrics/metrics.py) makes the same comparison.
      const markupFree = result.class === CLASSES.UPSTREAMABLE
      delete result.upstream_candidate_text
      result.class = markupFree ? CLASSES.REDUNDANT : CLASSES.KEEP
      result.note = markupFree
        ? 'Differs from the help string only by a terminal period, which a help string does not take. The release run retires it.'
        : 'Differs from the help string only by docs markup. Nothing to upstream.'
    } else {
      result.upstream_candidate_text = candidate
      if (result.class === CLASSES.UPSTREAMABLE) {
        result.note = 'Override prose differs from the help string and is markup-free. The candidate has no terminal period.'
      }
    }
  }
  result.note += audienceNote
  if (marked) {
    // The marker is out of date: there is a plain help string to rewrite now.
    result.note += ' Marked upstream_not_possible, but the source has a plain help string for this metric now, so the marker no longer holds.'
  }
  if (family.call_sites > 1 && result.upstream_candidate_text !== undefined) {
    result.note += ` The source registers this family at ${family.call_sites} call sites. The location is the first one.`
  }
  return result
}

/**
 * Make overrides that target one source string agree.
 *
 * Rows are grouped by source location. When the candidates are the same text,
 * the first row keeps it and lists the others in shared_with. When they
 * differ, every row in the group becomes REVIEW, so no rewrite is produced.
 *
 * @param {Object[]} manifest - Manifest rows, changed in place.
 */
function mergeSharedSourceStrings (manifest) {
  const groups = new Map()
  for (const row of manifest) {
    if (row.field !== 'description' || row.upstream_candidate_text === undefined) continue
    const key = `${row.source_file}:${row.source_line}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue
    const texts = new Set(rows.map((row) => classify.normalizeText(row.upstream_candidate_text)))
    if (texts.size > 1) {
      const names = rows.map((row) => row.name).join(', ')
      for (const row of rows) {
        delete row.upstream_candidate_text
        row.class = CLASSES.REVIEW
        row.note = `These overrides give different text for the one help string at ${key}: ${names}. Make them agree before any of them can go upstream.`
      }
      continue
    }
    const [first, ...rest] = rows
    first.shared_with = rest.map((row) => row.name)
    first.note += ` Also the text of ${first.shared_with.join(', ')}, which the same registration exports.`
    for (const row of rest) {
      delete row.upstream_candidate_text
      row.class = CLASSES.KEEP_UNTIL_UPSTREAMED
      row.same_source_as = first.name
      row.note = `Same help string and same text as ${first.name}, whose row carries the candidate. Keep until it ships.`
    }
  }
}

/**
 * Run the audit for the metrics surface.
 *
 * @param {Object} args - { overridesPath, extractedPath }.
 * @returns {Object} { surface, overrides_file, extracted_file, source_ref, manifest, summary }.
 */
function audit ({ overridesPath, extractedPath }) {
  const overridesDoc = loadJson(overridesPath, 'overrides')
  const inventory = loadJson(extractedPath, 'source inventory')

  if (!overridesDoc.metrics || typeof overridesDoc.metrics !== 'object' || Array.isArray(overridesDoc.metrics)) {
    throw new Error(`Overrides file ${overridesPath} has no top-level "metrics" object`)
  }
  for (const endpoint of ['public', 'internal']) {
    if (!inventory[endpoint] || typeof inventory[endpoint] !== 'object') {
      throw new Error(`Extracted file ${extractedPath} has no "${endpoint}" object; pass the output of tools/metrics/extract_source.py`)
    }
  }

  const manifest = []
  for (const [name, override] of Object.entries(overridesDoc.metrics)) {
    if (typeof override !== 'object' || override === null || Array.isArray(override)) {
      manifest.push(classify.row({
        name,
        field: '(entry)',
        class: CLASSES.REVIEW,
        note: `Override entry is not an object (${typeof override}); malformed.`
      }))
      continue
    }
    const family = inventory.public[name] || inventory.internal[name] || null
    for (const field of Object.keys(override)) {
      if (META_FIELDS.includes(field)) continue
      if (field === 'description') {
        manifest.push(classifyMetricDescription(name, override, family))
        continue
      }
      manifest.push(classify.row({
        name,
        field,
        class: CLASSES.KEEP,
        note: RELEASE_RUN_FIELDS.includes(field)
          ? 'A stopgap the release run compares with the scrape and retires. The help string cannot carry it.'
          : 'Docs-layer enrichment; stays in the override file by design.'
      }))
    }
  }
  mergeSharedSourceStrings(manifest)
  // The shared triage prompt and report choose their wording by this.
  for (const row of manifest) row.surface = 'metrics'

  return {
    surface: 'metrics',
    overrides_file: overridesPath,
    extracted_file: extractedPath,
    source_ref: inventory.ref,
    manifest,
    summary: classify.summarize(manifest)
  }
}

module.exports = { audit, extractInventory, stripTerminalPeriod }
