'use strict'

/**
 * Build-time quality rules for the solutions component.
 *
 * Every function here is pure: it takes collected records (see collect.js) and
 * returns `{ errors, warnings }` as arrays of strings. The extension collects
 * all errors across all solutions and throws once, so an author sees the whole
 * list in one failed build instead of one error per attempt.
 */

const { parse } = require('node-html-parser')
const {
  RESERVED_IDS, LAYOUTS, ENUMS, SLUG_RX, VERSION_RX, stripVersion,
} = require('./collect')
const { normalizeCategories } = require('../../extension-utils/categories')

const DURATION_MIN = 5
const DURATION_MAX = 600
const DESCRIPTION_MAX = 200
const REQUIRED_OVERVIEW_H2 = ['architecture', 'prerequisites', 'production considerations']
// A related doc must be a fully qualified page ID: component:module:path.adoc
const FQ_RESOURCE_RX = /^(?:[^@:\s]+@)?[A-Za-z0-9_-]+:[A-Za-z0-9_-]*:[^\s]+\.adoc$/

/** Lower-case, collapse whitespace, drop trailing punctuation. */
function normalizeHeading (text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.:!?]+$/, '')
    .toLowerCase()
}

function parseHtml (contents) {
  const html = Buffer.isBuffer(contents) ? contents.toString('utf8') : String(contents || '')
  return parse(html, { blockTextElements: { code: true, pre: true } })
}

/** Normalized text of every heading at the given levels, in document order. */
function headingTexts (contents, levels = ['h2']) {
  const root = parseHtml(contents)
  return root.querySelectorAll(levels.join(',')).map((h) => normalizeHeading(h.text))
}

/** True when the page has an h2/h3 starting with "verify" or a `.solution-verify` block. */
function hasVerifySection (contents) {
  const root = parseHtml(contents)
  if (root.querySelector('.solution-verify')) return true
  return root.querySelectorAll('h2,h3').some((h) => normalizeHeading(h.text).startsWith('verify'))
}

/**
 * Attachment names linked from the page. `link:{attachmentsdir}/x.yml[]` renders
 * as an href ending in `/_attachments/x.yml`, so the name is whatever follows
 * the last `_attachments/` segment.
 */
function attachmentLinkTargets (contents) {
  const root = parseHtml(contents)
  const names = new Set()
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || ''
    const idx = href.lastIndexOf('_attachments/')
    if (idx === -1) return
    const raw = href.slice(idx + '_attachments/'.length).split(/[?#]/)[0]
    let name
    try { name = decodeURIComponent(raw) } catch { name = raw }
    if (name) names.add(name)
  })
  return [...names]
}

/**
 * Structural checks that run at contentClassified, before conversion.
 *
 * @param {ReturnType<import('./collect').collectSolutions>} collected
 * @param {Object} [options]
 * @param {Array<string>} [options.reservedIds]
 * @returns {Array<string>} errors
 */
function validateStructure (collected, { reservedIds = RESERVED_IDS } = {}) {
  const errors = []
  if (!collected) return errors
  if (!collected.landing) {
    errors.push('solutions: landing page ROOT/pages/index.adoc is missing')
  }
  const seen = new Set()
  for (const record of collected.solutions) {
    const id = record.id
    if (seen.has(id)) errors.push(`${id}: duplicate module name`)
    seen.add(id)
    if (reservedIds.includes(id)) errors.push(`${id}: module name is reserved (${reservedIds.join(', ')})`)
    if (!SLUG_RX.test(id)) errors.push(`${id}: module name must be a lower-case slug (letters, digits, hyphens)`)
    if (!record.overview) errors.push(`${id}: module has no pages/index.adoc overview`)
  }
  return errors
}

function isInteger (value) {
  return /^-?\d+$/.test(String(value).trim())
}

/**
 * Validate one collected solution record after conversion.
 *
 * Side effect by design: `record.categories` is replaced with the normalized
 * list (parents added) because scoring and the catalog both need it.
 *
 * @param {Object} record - from collect.js
 * @param {Object} ctx
 * @param {Object} [ctx.categoryMap] - from createCategoryMap
 * @param {(spec: string) => Object|null|undefined} [ctx.resolveDoc] - resolve a page ID to a page
 * @param {Set<string>} [ctx.solutionIds] - all module names in the component
 * @returns {{errors: Array<string>, warnings: Array<string>}}
 */
function validateSolution (record, { categoryMap, resolveDoc, solutionIds } = {}) {
  const errors = []
  const warnings = []
  const id = record.id
  const err = (m) => errors.push(`${id}: ${m}`)
  const warn = (m) => warnings.push(`${id}: ${m}`)

  if (!record.overview) {
    err('module has no pages/index.adoc overview')
    return { errors, warnings }
  }

  // Layout must match file position
  if (record.layout !== LAYOUTS.overview) err(`pages/index.adoc must set :page-layout: ${LAYOUTS.overview} (found "${record.layout || ''}")`)
  for (const step of record.steps) {
    const attrs = (step.page.asciidoc && step.page.asciidoc.attributes) || {}
    if (attrs['page-layout'] !== LAYOUTS.step) err(`step ${step.id} must set :page-layout: ${LAYOUTS.step} (found "${attrs['page-layout'] || ''}")`)
    const stepDuration = attrs['page-solution-step-duration']
    if (stepDuration !== undefined && stepDuration !== '' && !isInteger(stepDuration)) {
      err(`step ${step.id}: page-solution-step-duration must be an integer number of minutes (found "${stepDuration}")`)
    }
  }

  // Required scalars and enums
  if (!record.description) err('description is required')
  else if (record.description.length > DESCRIPTION_MAX) warn(`description is ${record.description.length} characters; keep it under ${DESCRIPTION_MAX}`)

  if (!record.version) err('page-solution-version is required (vX.Y.Z)')
  else if (!VERSION_RX.test(record.version)) err(`page-solution-version "${record.version}" must match vX.Y.Z`)

  if (!ENUMS.difficulty.includes(record.difficulty)) err(`page-solution-difficulty must be one of ${ENUMS.difficulty.join(', ')} (found "${record.difficulty}")`)

  if (record.duration === undefined || record.duration === null || record.duration === '') {
    err(`page-solution-duration is required (${DURATION_MIN}..${DURATION_MAX} minutes)`)
  } else if (!isInteger(record.duration) || Number(record.duration) < DURATION_MIN || Number(record.duration) > DURATION_MAX) {
    err(`page-solution-duration must be an integer between ${DURATION_MIN} and ${DURATION_MAX} (found "${record.duration}")`)
  }

  if (!ENUMS.status.includes(record.status)) err(`page-solution-status must be one of ${ENUMS.status.join(', ')} (found "${record.status}")`)
  if (!ENUMS.download.includes(record.download)) err(`page-solution-download must be one of ${ENUMS.download.join(', ')} (found "${record.download}")`)

  const badPlatforms = record.platforms.filter((p) => !ENUMS.platforms.includes(p))
  if (badPlatforms.length) err(`page-solution-platforms contains unknown values: ${badPlatforms.join(', ')} (allowed: ${ENUMS.platforms.join(', ')})`)

  if (!record.technologies.length) err('page-solution-technologies is required')

  if (record.status === 'deprecated' && !record.supersededBy) err('page-solution-superseded-by is required when status is deprecated')
  if (record.supersededBy && solutionIds && !solutionIds.has(record.supersededBy)) {
    warn(`page-solution-superseded-by "${record.supersededBy}" is not a solution in this build`)
  }

  // Categories: fatal if any value is unknown; parents are added
  if (!record.categoriesRaw.length) err('page-categories is required')
  else if (categoryMap) {
    const { categories, invalid } = normalizeCategories(record.categoriesRaw, categoryMap)
    if (invalid.length) err(`page-categories contains unknown values: ${invalid.join(', ')}. See shared/modules/ROOT/partials/valid-categories.yml`)
    record.categories = categories
  }

  // Steps: bijection between page-solution-steps and non-index pages
  if (!record.stepIds.length) err('page-solution-steps is required')
  const listed = new Set()
  for (const stepId of record.stepIds) {
    if (listed.has(stepId)) err(`page-solution-steps lists "${stepId}" more than once`)
    listed.add(stepId)
    if (stepId === 'index') err('page-solution-steps must not list index')
  }
  const present = new Set(record.steps.map((s) => s.id))
  for (const stepId of listed) {
    if (stepId !== 'index' && !present.has(stepId)) err(`page-solution-steps lists "${stepId}" but pages/${stepId}.adoc does not exist`)
  }
  for (const stepId of present) {
    if (!listed.has(stepId)) err(`pages/${stepId}.adoc exists but is not listed in page-solution-steps`)
  }

  // Related docs: warn when absent, fatal when malformed or unresolved
  if (!record.relatedDocRefs.length) warn('page-solution-related-docs is empty; readers get no explicit Product Docs links')
  for (const ref of record.relatedDocRefs) {
    if (!FQ_RESOURCE_RX.test(ref)) {
      err(`page-solution-related-docs entry "${ref}" must be a fully qualified page ID (component:module:path.adoc)`)
      continue
    }
    if (resolveDoc && !resolveDoc(stripVersion(ref))) err(`page-solution-related-docs entry "${ref}" does not resolve to a page in this build`)
  }
  for (const other of record.relatedSolutionIds) {
    if (other === id) err('page-solution-related-solutions must not list the solution itself')
    else if (solutionIds && !solutionIds.has(other)) err(`page-solution-related-solutions entry "${other}" is not a solution in this build`)
  }

  // Section checks on converted HTML, published solutions only
  if (record.status === 'published') {
    const h2s = headingTexts(record.overview.contents, ['h2'])
    for (const required of REQUIRED_OVERVIEW_H2) {
      if (!h2s.includes(required)) err(`published overview is missing an h2 "${titleCase(required)}"`)
    }
    for (const step of record.steps) {
      if (!hasVerifySection(step.page.contents)) {
        err(`published step ${step.id} needs an h2/h3 starting with "Verify" or a [.solution-verify] block`)
      }
    }
  }

  // Attachment links must point at files in this module
  const attachmentNames = new Set(record.attachments.map((a) => a.name))
  const pagesToScan = [{ id: 'index', page: record.overview }, ...record.steps]
  for (const { id: pageId, page } of pagesToScan) {
    for (const name of attachmentLinkTargets(page.contents)) {
      if (!attachmentNames.has(name)) err(`${pageId}.adoc links to attachment "${name}" which does not exist in the module`)
    }
  }

  return { errors, warnings }
}

function titleCase (s) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Validate the parsed relationships.yml document.
 *
 * @param {*} data - parsed YAML
 * @param {Object} ctx
 * @param {Function} [ctx.validate] - compiled ajv validator
 * @param {Set<string>} [ctx.solutionIds]
 * @param {(spec: string) => Object|null|undefined} [ctx.resolveDoc]
 * @param {(page: Object) => string} ctx.keyOf - page -> doc key
 * @returns {{errors: Array<string>, warnings: Array<string>, entries: Array<Object>, pendingCount: number}}
 */
function validateRelationships (data, { validate, solutionIds, resolveDoc, keyOf }) {
  const errors = []
  const warnings = []
  const entries = []
  let pendingCount = 0

  if (validate && !validate(data)) {
    for (const e of validate.errors || []) {
      errors.push(`relationships.yml${e.instancePath || ''} ${e.message}`)
    }
    return { errors, warnings, entries, pendingCount }
  }

  const list = (data && Array.isArray(data.relationships)) ? data.relationships : []
  const seenPairs = new Set()
  list.forEach((entry, i) => {
    const pair = `${entry.solution} ${stripVersion(entry.doc)}`
    if (seenPairs.has(pair)) {
      errors.push(`relationships.yml entry ${i}: duplicate pair ${entry.solution} <-> ${entry.doc}`)
      return
    }
    seenPairs.add(pair)

    if (entry.status === 'pending') {
      pendingCount++
      return
    }
    if (solutionIds && !solutionIds.has(entry.solution)) {
      warnings.push(`relationships.yml entry ${i}: orphaned, solution "${entry.solution}" is not in this build`)
      return
    }
    const page = resolveDoc ? resolveDoc(stripVersion(entry.doc)) : null
    if (!page) {
      warnings.push(`relationships.yml entry ${i}: orphaned, doc "${entry.doc}" does not resolve to a page in this build`)
      return
    }
    entries.push({
      solutionId: entry.solution,
      docKey: keyOf(page),
      docUrl: page.pub && page.pub.url,
      status: entry.status,
      source: entry.source || 'editor',
      confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
      reason: entry.reason || '',
    })
  })

  return { errors, warnings, entries, pendingCount }
}

/** One message listing every error, for the single throw. */
function formatErrors (errors) {
  return `solutions-catalog: ${errors.length} error${errors.length === 1 ? '' : 's'} in the solutions component:\n  - ${errors.join('\n  - ')}`
}

module.exports = {
  DURATION_MIN,
  DURATION_MAX,
  DESCRIPTION_MAX,
  REQUIRED_OVERVIEW_H2,
  normalizeHeading,
  headingTexts,
  hasVerifySection,
  attachmentLinkTargets,
  validateStructure,
  validateSolution,
  validateRelationships,
  formatErrors,
}
