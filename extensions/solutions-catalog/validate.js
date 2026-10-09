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
  RESERVED_IDS, LAYOUTS, ENUMS, SLUG_RX, VERSION_RX, VERIFICATION_FILE, COMPONENT, stripVersion, pageKey,
} = require('./collect')
const { normalizeCategories, isLeafCategory } = require('../../extension-utils/categories')
const yaml = require('js-yaml')

const DURATION_MIN = 5
const DURATION_MAX = 600
// The landing card shows the description in three clamped lines; 140
// characters is what fits them.
const DESCRIPTION_MAX = 140
// page-solution-technologies names what a reader needs beyond Redpanda
// itself: other systems, languages, formats, and separately deployed Redpanda
// products. Tools every solution uses say nothing about any one of them, and
// a value that is also a category belongs in page-categories.
const TECHNOLOGY_DENY_LIST = ['rpk', 'curl', 'docker', 'docker compose', 'redpanda', 'redpanda console']
// Separately deployed Redpanda products are technologies of a solution even
// where the category taxonomy also names them (Redpanda Connect is a top-level
// category). Matches tools/check-metadata.sh in the solutions repository.
const PRODUCT_TECHNOLOGIES = ['redpanda connect', 'redpanda migrator', 'redpanda operator']
const REQUIRED_OVERVIEW_H2 = ['architecture', 'prerequisites']
// The complete production section lives at the end of the last step, once the
// reader has the whole stack running, with one h3 per topic.
const PRODUCTION_H2 = 'production considerations'
const PRODUCTION_MIN_TOPICS = 5
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
 * The h3 topics under the "Production considerations" h2 of a page, or null
 * when the page has no such h2. Asciidoctor wraps the section in a .sect1, so
 * its h3s are the topics; without the wrapper (hand-built HTML) the h3s up to
 * the next h2 count.
 */
function productionTopics (contents) {
  const root = parseHtml(contents)
  const h2 = root.querySelectorAll('h2').find((h) => normalizeHeading(h.text) === PRODUCTION_H2)
  if (!h2) return null
  const parent = h2.parentNode
  if (parent && /(^|\s)sect1(\s|$)/.test(parent.getAttribute ? parent.getAttribute('class') || '' : '')) {
    return parent.querySelectorAll('h3').map((h) => normalizeHeading(h.text))
  }
  const topics = []
  let node = h2.nextElementSibling
  while (node && node.tagName !== 'H2') {
    if (node.tagName === 'H3') topics.push(normalizeHeading(node.text))
    else topics.push(...node.querySelectorAll('h3').map((h) => normalizeHeading(h.text)))
    node = node.nextElementSibling
  }
  return topics
}

/** Number of `.production-note` blocks on a page that contain no link. */
function unlinkedProductionNotes (contents) {
  const root = parseHtml(contents)
  return root.querySelectorAll('.production-note').filter((note) => !note.querySelector('a[href]')).length
}

/**
 * Attachment prefix for a solution module: the overview URL directory plus
 * `_attachments/`, which is where Antora publishes the module's attachments.
 */
function attachmentPrefixOf (overviewUrl) {
  const dir = String(overviewUrl || '').replace(/[^/]*$/, '')
  return `${dir}_attachments/`
}

/**
 * Names of THIS module's attachments linked from a page. Every href is resolved
 * against the page's own URL first (a step at /solutions/x/step/ links its files
 * as ../_attachments/f), and only hrefs that land under `attachmentPrefix` count.
 * Links to another module's or component's attachments are someone else's to
 * validate and pass through untouched.
 */
function attachmentLinkTargets (contents, { pageUrl = '/', attachmentPrefix } = {}) {
  if (!attachmentPrefix) return []
  const root = parseHtml(contents)
  const base = new URL(pageUrl, 'https://site.invalid')
  const names = new Set()
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || ''
    let resolved
    try { resolved = new URL(href, base) } catch { return }
    if (resolved.origin !== base.origin) return
    if (!resolved.pathname.startsWith(attachmentPrefix)) return
    const raw = resolved.pathname.slice(attachmentPrefix.length)
    let name
    try { name = decodeURIComponent(raw) } catch { name = raw }
    if (name) names.add(name)
  })
  return [...names]
}

/**
 * Links on a page that carry a `#fragment`, resolved against the page URL.
 * Off-site links and bare `#` links are dropped.
 *
 * @returns {Array<{href: string, pathname: string, fragment: string}>}
 */
function fragmentLinks (contents, { pageUrl = '/' } = {}) {
  const root = parseHtml(contents)
  const base = new URL(pageUrl, 'https://site.invalid')
  const links = []
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || ''
    if (!href.includes('#')) return
    let resolved
    try { resolved = new URL(href, base) } catch { return }
    if (resolved.origin !== base.origin) return
    let fragment = resolved.hash.slice(1)
    try { fragment = decodeURIComponent(fragment) } catch {}
    if (!fragment) return
    links.push({ href, pathname: resolved.pathname, fragment })
  })
  return links
}

// Parsed element ids per page, keyed by the page object and invalidated when
// its contents change, so a target linked from many steps is parsed once.
const idCache = new WeakMap()

/** Every element id in a page's converted HTML (sections, anchors, blocks). */
function elementIds (page) {
  if (!page || !page.contents) return null
  const cached = idCache.get(page)
  if (cached && cached.contents === page.contents) return cached.ids
  const ids = new Set(parseHtml(page.contents).querySelectorAll('[id]').map((el) => el.getAttribute('id')))
  idCache.set(page, { contents: page.contents, ids })
  return ids
}

/**
 * The id Asciidoctor generates for a heading on this site (idprefix '' and
 * idseparator '-'), from a fragment written for the defaults ('_' and '_'):
 * `_production_considerations` -> `production-considerations`.
 */
function siteStyleId (fragment) {
  return String(fragment).replace(/^_+/, '').replace(/_/g, '-')
}

/**
 * Fragments on a page's links that match no id in the page they point at.
 * A link whose target is not a page in this build (an attachment, another
 * site) is not checked here.
 *
 * @param {Object} page - converted page with `contents` and `pub.url`
 * @param {(pathname: string) => Object|null|undefined} pageByUrl
 * @returns {Array<{href: string, fragment: string, target: string, suggestion: string|null}>}
 */
function brokenFragments (page, pageByUrl) {
  if (!page || !page.contents || typeof pageByUrl !== 'function') return []
  const ownUrl = (page.pub && page.pub.url) || '/'
  const broken = []
  for (const link of fragmentLinks(page.contents, { pageUrl: ownUrl })) {
    const target = link.pathname === ownUrl ? page : pageByUrl(link.pathname)
    const ids = elementIds(target)
    if (!ids || ids.has(link.fragment)) continue
    const candidate = siteStyleId(link.fragment)
    broken.push({
      href: link.href,
      fragment: link.fragment,
      target: (target.pub && target.pub.url) || link.pathname,
      suggestion: candidate !== link.fragment && ids.has(candidate) ? candidate : null,
    })
  }
  return broken
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
  for (const record of collected.solutions) {
    const id = record.id
    if (reservedIds.includes(id)) errors.push(`${id}: module name is reserved (${reservedIds.join(', ')})`)
    if (!SLUG_RX.test(id)) errors.push(`${id}: module name must be a lower-case slug (letters, digits, hyphens)`)
    if (!record.overview) errors.push(`${id}: module has no pages/index.adoc overview`)
  }
  return errors
}

function isInteger (value) {
  return /^-?\d+$/.test(String(value).trim())
}

/** ISO 8601 instant, as the verification manifest is expected to carry. */
function isIsoTimestamp (value) {
  if (typeof value !== 'string') return false
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.trim())) return false
  return !Number.isNaN(Date.parse(value.trim()))
}

/** Latest page-git-modified-date across a solution's overview and steps. */
function contentModifiedDate (record) {
  const dates = [record.overview, ...(record.steps || []).map((s) => s.page)]
    .map((p) => p && p.asciidoc && p.asciidoc.attributes && p.asciidoc.attributes['page-git-modified-date'])
    .filter((d) => typeof d === 'string' && !Number.isNaN(Date.parse(d)))
  if (record.lastModified && !Number.isNaN(Date.parse(record.lastModified))) dates.push(String(record.lastModified))
  return dates.sort().pop() || null
}

const HEX_RX = /^[0-9a-f]+$/i

/**
 * Warnings about the verification manifest itself. Never fatal: the manifest
 * is evidence the monorepo writes, and a stale or partial one should be
 * visible in the build log without stopping the docs from publishing.
 */
function verificationWarnings (record) {
  const warnings = []
  const v = record.verified || {}
  const runAt = v.runAt
  if (runAt === undefined) warnings.push(`${VERIFICATION_FILE} has no run_at`)
  else if (!isIsoTimestamp(runAt)) warnings.push(`${VERIFICATION_FILE} run_at "${runAt}" is not an ISO 8601 timestamp`)
  else {
    // Day granularity: page-git-modified-date carries no time, so a commit
    // on the same day as the run cannot be ordered against it.
    const modified = contentModifiedDate(record)
    if (modified && String(runAt).slice(0, 10) < String(modified).slice(0, 10)) {
      warnings.push(`${VERIFICATION_FILE} run_at ${runAt} is older than the solution's pages (last modified ${modified}); rerun the verification so the evidence matches what readers see`)
    }
  }
  if (v.platforms !== undefined) {
    const list = Array.isArray(v.platforms) ? v.platforms : null
    const unknown = list ? list.filter((p) => !ENUMS.platforms.includes(p)) : []
    if (!list) warnings.push(`${VERIFICATION_FILE} platforms must be an array of ${ENUMS.platforms.join(', ')}`)
    else if (unknown.length) warnings.push(`${VERIFICATION_FILE} platforms contains unknown values: ${unknown.join(', ')}`)
    else {
      const missing = (record.platforms || []).filter((p) => !list.includes(p))
      if (missing.length) warnings.push(`page-solution-platforms includes ${missing.join(', ')} but ${VERIFICATION_FILE} verified only ${list.join(', ') || 'nothing'}`)
    }
  }
  if (v.contentRev !== undefined) {
    const rev = v.contentRev
    const ok = rev && typeof rev === 'object' && !Array.isArray(rev) &&
      ['solution', 'docs'].every((k) => typeof rev[k] === 'string' && HEX_RX.test(rev[k]))
    if (!ok) warnings.push(`${VERIFICATION_FILE} content_rev must be {"solution": <git tree hash>, "docs": <git tree hash>}`)
  }
  if (v.stackSha256 !== undefined && !(typeof v.stackSha256 === 'string' && /^[0-9a-f]{64}$/i.test(v.stackSha256))) {
    warnings.push(`${VERIFICATION_FILE} stack_sha256 must be a 64-character hex SHA-256 digest`)
  }
  return warnings
}

/**
 * Validate one collected solution record after conversion.
 *
 * Side effect by design: `record.categories` is replaced with the normalized
 * list (parents added) because scoring and the catalog both need it, and
 * `record.categoryLeaves` is set to the authored leaf categories, which is
 * what the catalog's Category facet counts.
 *
 * @param {Object} record - from collect.js
 * @param {Object} ctx
 * @param {Object} [ctx.categoryMap] - from createCategoryMap
 * @param {Object} [ctx.facetVocab] - {industries: string[], useCases: string[]} from
 *   ROOT/partials/solution-facets.yml; when absent the two facet axes are not validated
 * @param {(spec: string) => Object|null|undefined} [ctx.resolveDoc] - resolve a page ID to a page
 * @param {Set<string>} [ctx.solutionIds] - all module names in the component
 * @param {(pathname: string) => Object|null|undefined} [ctx.pageByUrl] - a published URL
 *   path to its page; when absent, link fragments are not checked
 * @param {Array<string>} [ctx.umbrellaLayouts] - layouts that never show recommendations
 * @param {(page: Object) => boolean} [ctx.isCloudPage] - when absent, Cloud reach is not checked
 * @param {(key: string) => Array<string>} [ctx.cloudTwinsOf] - Cloud pages that single-source a doc
 * @returns {{errors: Array<string>, warnings: Array<string>}}
 */
function validateSolution (record, { categoryMap, facetVocab, resolveDoc, solutionIds, pageByUrl, umbrellaLayouts, isCloudPage, cloudTwinsOf } = {}) {
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
  else if (record.description.length > DESCRIPTION_MAX) err(`description is ${record.description.length} characters; the landing card fits ${DESCRIPTION_MAX}`)

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
  const denied = record.technologies.filter((t) => TECHNOLOGY_DENY_LIST.includes(t.toLowerCase()))
  if (denied.length) {
    err(`page-solution-technologies must not list ${denied.join(', ')}: it names what a reader needs beyond Redpanda and its everyday tools (other systems, languages, formats, and separately deployed products such as Redpanda Connect)`)
  }
  if (categoryMap) {
    const categoryNames = new Map([...categoryMap.categories, ...categoryMap.subcategories].map((c) => [c.toLowerCase(), c]))
    const asCategory = record.technologies.filter((t) => categoryNames.has(t.toLowerCase()) && !denied.includes(t) && !PRODUCT_TECHNOLOGIES.includes(t.toLowerCase()))
    if (asCategory.length) {
      err(`page-solution-technologies lists ${asCategory.join(', ')}, which ${asCategory.length === 1 ? 'is a category' : 'are categories'}; put ${asCategory.length === 1 ? 'it' : 'them'} in page-categories instead`)
    }
  }

  // Verification manifest: the build-side twin of the monorepo's check-metadata.
  // Nothing is inferred when it is absent or unreadable, so say so instead.
  if (record.verifiedError) {
    warn(`${VERIFICATION_FILE} could not be read (${record.verifiedError}); no verification is published for this solution`)
  } else if (record.status === 'published' && !record.verified) {
    warn(`no ${VERIFICATION_FILE} attachment; readers get no verification evidence`)
  }
  if (record.verified) {
    for (const w of verificationWarnings(record)) warn(w)
  }

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
  // The landing page's Category facet: what the author wrote, at leaf level.
  // Parents that normalizeCategories adds (and broad parents written by hand)
  // say only "same product area", so they stay out of the facet.
  record.categoryLeaves = record.categoriesRaw
    .filter((c) => !categoryMap || categoryMap.categories.has(c) || categoryMap.subcategories.has(c))
    .filter((c) => isLeafCategory(c, categoryMap))

  // Industries and use cases: fatal on an unknown value, for the same reason
  // categories are. These two drive facets, and a facet built from free text
  // becomes a list of near-duplicates ("CDC", "Change data capture") as soon
  // as more than one author writes one. The vocabulary is a reviewed file, so
  // adding a value is a deliberate act rather than a typo.
  if (facetVocab) {
    for (const [attr, values] of [
      ['page-solution-use-cases', record.useCases],
      ['page-solution-industries', record.industries],
    ]) {
      const allowed = facetVocab[attr === 'page-solution-use-cases' ? 'useCases' : 'industries'] || []
      const invalid = values.filter((v) => !allowed.includes(v))
      if (invalid.length) {
        err(`${attr} contains unknown values: ${invalid.join(', ')}. Add them to ROOT/partials/solution-facets.yml first, or use an existing value`)
      }
    }
    if (record.status === 'published' && !record.useCases.length) {
      warn('page-solution-use-cases is empty; the solution will not appear under any use case on the landing page')
    }
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

  // Duration: when every step is timed, the steps are the whole story.
  const stepMinutes = record.stepIds.map((sid) => {
    const step = record.steps.find((s) => s.id === sid)
    const value = step && step.page.asciidoc && step.page.asciidoc.attributes && step.page.asciidoc.attributes['page-solution-step-duration']
    return value !== undefined && value !== '' && isInteger(value) ? Number(value) : null
  })
  if (stepMinutes.length && stepMinutes.every((m) => m !== null) && isInteger(record.duration)) {
    const total = stepMinutes.reduce((a, b) => a + b, 0)
    if (total !== Number(record.duration)) {
      warn(`page-solution-duration is ${record.duration} but the steps' page-solution-step-duration values add up to ${total}`)
    }
  }

  // Related docs: warn when absent, fatal when malformed or unresolved
  if (!record.relatedDocRefs.length) warn('page-solution-related-docs is empty; readers get no explicit Product Docs links')
  const relatedKeys = new Map()
  let cloudReach = false
  for (const ref of record.relatedDocRefs) {
    if (!FQ_RESOURCE_RX.test(ref)) {
      err(`page-solution-related-docs entry "${ref}" must be a fully qualified page ID (component:module:path.adoc)`)
      continue
    }
    const page = resolveDoc ? resolveDoc(stripVersion(ref)) : null
    if (resolveDoc && !page) {
      err(`page-solution-related-docs entry "${ref}" does not resolve to a page in this build`)
      continue
    }
    if (!page) continue
    const key = pageKey(page)
    relatedKeys.set(key, ref)
    const attrs = (page.asciidoc && page.asciidoc.attributes) || {}
    if (umbrellaLayouts && (umbrellaLayouts.includes(attrs['page-layout']) || umbrellaLayouts.includes(attrs['page-role']))) {
      warn(`page-solution-related-docs entry "${ref}" is a landing or index page (layout ${attrs['page-layout'] || attrs['page-role']}), which never shows recommendations; link the article it summarizes`)
    }
    if (isCloudPage && (isCloudPage(page) || (cloudTwinsOf && cloudTwinsOf(key).length))) cloudReach = true
  }
  if (isCloudPage && record.platforms.includes('cloud') && record.relatedDocRefs.length && !cloudReach) {
    warn('page-solution-platforms includes cloud but no page-solution-related-docs entry is a Cloud page or has a single-sourced Cloud twin; Cloud readers get no explicit recommendation')
  }

  // The overview's Related docs list and the attribute say the same thing
  // twice: the list is what readers of the overview see, the attribute is
  // what makes the doc page recommend the solution back. A doc in the list
  // but not the attribute is a one-way link (fatal once published); a doc in
  // the attribute with no sentence in the list leaves the recommendation on
  // that page with no reason to give.
  if (Array.isArray(record.relatedDocLines)) {
    const report = record.status === 'published' ? err : warn
    const authored = new Set()
    for (const line of record.relatedDocLines) {
      if (!line.key || line.component === COMPONENT) continue
      authored.add(line.key)
      if (!relatedKeys.has(line.key)) {
        report(`== Related docs links ${line.key} but page-solution-related-docs does not list it, so that page does not recommend this solution; add it to the attribute`)
      }
    }
    for (const [key, ref] of relatedKeys) {
      if (!authored.has(key)) warn(`page-solution-related-docs entry "${ref}" has no item in == Related docs; the recommendation on that page has no reason to show`)
    }
  }

  if (!record.relatedSolutionIds.length) warn('page-solution-related-solutions is empty; the overview points readers at no other solution')
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

  // Production considerations: the complete section is the last step's, and
  // every in-context note on a step links to its topic there. Fatal once
  // published, a warning while a draft.
  {
    const report = record.status === 'published' ? err : warn
    const present = new Map(record.steps.map((s) => [s.id, s.page]))
    const lastId = [...record.stepIds].reverse().find((sid) => present.has(sid))
    if (lastId) {
      const topics = productionTopics(present.get(lastId).contents)
      if (topics === null) {
        report(`last step ${lastId} needs an h2 "Production considerations" (include::partial$production/_all.adoc[])`)
      } else if (topics.length < PRODUCTION_MIN_TOPICS) {
        report(`last step ${lastId}: "Production considerations" has ${topics.length} topic${topics.length === 1 ? '' : 's'} (h3); it needs at least ${PRODUCTION_MIN_TOPICS}`)
      }
    }
    if (productionTopics(record.overview.contents) !== null) {
      warn(`the overview has an h2 "Production considerations"; it belongs at the end of the last step${lastId ? ` (${lastId})` : ''}, with a pointer under Prerequisites`)
    }
    for (const step of record.steps) {
      if (step.id !== lastId && productionTopics(step.page.contents) !== null) {
        warn(`step ${step.id} has an h2 "Production considerations"; only the last step${lastId ? ` (${lastId})` : ''} carries the complete section`)
      }
    }
    for (const { id: pageId, page } of [{ id: 'index', page: record.overview }, ...record.steps]) {
      const unlinked = unlinkedProductionNotes(page.contents)
      if (unlinked) report(`${pageId}.adoc has ${unlinked} [.production-note] block${unlinked === 1 ? '' : 's'} with no link to the topic under Production considerations`)
    }
  }

  // Links into this module's attachments must point at files that exist
  const attachmentNames = new Set(record.attachments.map((a) => a.name))
  const attachmentPrefix = attachmentPrefixOf(record.overview.pub && record.overview.pub.url)
  const pagesToScan = [{ id: 'index', page: record.overview }, ...record.steps]
  for (const { id: pageId, page } of pagesToScan) {
    const pageUrl = (page.pub && page.pub.url) || attachmentPrefix
    for (const name of attachmentLinkTargets(page.contents, { pageUrl, attachmentPrefix })) {
      if (!attachmentNames.has(name)) err(`${pageId}.adoc links to attachment "${name}" which does not exist in the module`)
    }
  }

  // Link fragments: a #fragment must name an id in the page it points at.
  // The link checker only sees that the page returns 200, so a fragment
  // written for Asciidoctor's default ids (`#_production_considerations`)
  // silently lands at the top of the page on this site, whose ids have no
  // prefix and use hyphens. Fatal once published, a warning while a draft.
  if (pageByUrl) {
    const report = record.status === 'draft' ? warn : err
    for (const { id: pageId, page } of pagesToScan) {
      for (const b of brokenFragments(page, pageByUrl)) {
        const hint = b.suggestion ? `; use #${b.suggestion}` : ''
        report(`${pageId}.adoc links to ${b.target}#${b.fragment}, but that page has no id "${b.fragment}"${hint}`)
      }
    }
  }

  return { errors, warnings }
}

/**
 * Checks across solutions: the related-solutions graph should be symmetric,
 * and two solutions that point at each other should share a use case, or the
 * landing page's Use case filter separates what the overviews join.
 *
 * @param {Array<Object>} records - collected records
 * @returns {Array<string>} warnings
 */
function validateCatalog (records) {
  const warnings = []
  const byId = new Map((records || []).map((r) => [r.id, r]))
  const reportedPairs = new Set()
  for (const record of records || []) {
    for (const otherId of record.relatedSolutionIds || []) {
      const other = byId.get(otherId)
      if (!other || other === record) continue
      if (!(other.relatedSolutionIds || []).includes(record.id)) {
        warnings.push(`${otherId}: ${record.id} lists it in page-solution-related-solutions but ${otherId} does not list ${record.id} back`)
      }
      const pair = [record.id, otherId].sort().join(' ')
      const shared = (record.useCases || []).filter((u) => (other.useCases || []).includes(u))
      if ((record.useCases || []).length && (other.useCases || []).length && !shared.length && !reportedPairs.has(pair)) {
        reportedPairs.add(pair)
        warnings.push(`${record.id}: page-solution-related-solutions lists ${otherId}, but the two share no page-solution-use-cases value`)
      }
    }
  }
  return warnings
}

/**
 * Parse ROOT/partials/solution-facets.yml into the allowed values per axis.
 *
 * Shape:
 *   industries: [Gaming, Financial services]
 *   use_cases:  [Change data capture, Data lakehouse]
 *
 * Returns null when the file is missing or unparseable, which makes the two
 * axes unvalidated rather than failing every build: the same posture the
 * category check takes when page-valid-categories is unavailable.
 *
 * @param {string|Buffer} contents
 * @returns {null | {industries: string[], useCases: string[]}}
 */
function parseFacetVocab (contents) {
  if (!contents) return null
  let data
  try {
    data = yaml.load(String(contents))
  } catch (err) {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [])
  const industries = list(data.industries)
  const useCases = list(data.use_cases !== undefined ? data.use_cases : data.useCases)
  if (!industries.length && !useCases.length) return null
  return { industries, useCases }
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
  isIsoTimestamp,
  verificationWarnings,
  contentModifiedDate,
  DURATION_MIN,
  DURATION_MAX,
  DESCRIPTION_MAX,
  REQUIRED_OVERVIEW_H2,
  PRODUCTION_MIN_TOPICS,
  productionTopics,
  unlinkedProductionNotes,
  normalizeHeading,
  headingTexts,
  hasVerifySection,
  attachmentPrefixOf,
  attachmentLinkTargets,
  fragmentLinks,
  brokenFragments,
  siteStyleId,
  validateStructure,
  validateSolution,
  validateRelationships,
  validateCatalog,
  TECHNOLOGY_DENY_LIST,
  formatErrors,
  parseFacetVocab,
}
