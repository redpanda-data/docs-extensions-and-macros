'use strict'

/**
 * Shapes the solutions catalog publishes: the `page-solution` record and its
 * companions on solution pages, assets/data/solutions.json, and
 * assets/data/solutions-graph.json. Pure functions over validated records.
 */

const { plainTitle } = require('./collect')

const CATALOG_STATUSES = ['published', 'deprecated']

/** Ordered step list following page-solution-steps. */
function buildSteps (record) {
  const byId = new Map(record.steps.map((s) => [s.id, s.page]))
  const steps = []
  record.stepIds.forEach((id) => {
    const page = byId.get(id)
    if (!page) return
    const attrs = (page.asciidoc && page.asciidoc.attributes) || {}
    const duration = attrs['page-solution-step-duration']
    steps.push({
      id,
      title: plainTitle(page.asciidoc && page.asciidoc.doctitle) || page.title || id,
      url: page.pub && page.pub.url,
      order: steps.length + 1,
      duration: duration === undefined || duration === '' ? null : Number(duration),
    })
  })
  return steps
}

/**
 * The public record for one solution. Same object feeds `page-solution` and
 * solutions.json.
 *
 * `repo` (owner/name) is included only with `publicRepo`. The solutions
 * repository is private, so advertising it sends readers and agents to a 404;
 * the download endpoint and the public attachments are the way in, and the
 * download function takes the repository from its own configuration. The
 * internal record keeps `repo` for the release check either way.
 */
function buildPublicRecord (record, { steps, relatedDocs = [], relatedSolutions = [], publicRepo = false } = {}) {
  const publicRecord = {
    id: record.id,
    title: record.title,
    description: record.description,
    url: record.url,
    version: record.version,
    tag: record.tag,
    asset: record.asset,
    status: record.status,
    draft: record.status === 'draft',
    featured: Boolean(record.featured),
    difficulty: record.difficulty,
    duration: Number(record.duration),
    download: record.download,
    platforms: record.platforms,
    technologies: record.technologies,
    categories: record.categories,
    useCases: record.useCases,
    industries: record.industries,
    // The download endpoint's allowlist: exactly the snippets these pages render.
    files: record.files || [],
    personas: record.personas,
    steps: steps || buildSteps(record),
    relatedDocs,
    relatedSolutions,
    attachments: record.attachments,
    supersededBy: record.supersededBy || null,
    lastModified: record.lastModified || null,
  }
  if (publicRepo && record.repo) publicRecord.repo = record.repo
  // Evidence, not a default: no manifest means no key at all.
  if (record.verified) publicRecord.verified = record.verified
  // Only when the companion was generated for this build.
  if (record.agentCompanion) publicRecord.agentCompanion = record.agentCompanion
  return publicRecord
}

/** Sidebar model: solutions home, overview, ordered steps. */
function buildNav (publicRecord, { homeUrl } = {}) {
  return {
    home: { title: 'Solutions', url: homeUrl || null },
    overview: { title: publicRecord.title, url: publicRecord.url },
    steps: publicRecord.steps.map(({ id, title, url, order, duration }) => ({ id, title, url, order, duration })),
  }
}

const SCALAR_MIRRORS = [
  ['page-solution-id', 'id'],
  ['page-solution-title', 'title'],
  ['page-solution-url', 'url'],
  ['page-solution-description', 'description'],
  ['page-solution-version', 'version'],
  ['page-solution-tag', 'tag'],
  ['page-solution-asset', 'asset'],
  ['page-solution-repo', 'repo'],
  ['page-solution-status', 'status'],
  ['page-solution-difficulty', 'difficulty'],
  ['page-solution-download', 'download'],
]

/**
 * Write the derived attributes onto the overview and every step page.
 *
 * Complex values are JSON strings (the UI reads them with parse-json); scalars
 * are plain strings so Handlebars can compare them directly.
 */
function applyPageAttributes (record, publicRecord, nav) {
  const solutionJson = JSON.stringify(publicRecord)
  const navJson = JSON.stringify(nav)
  const count = publicRecord.steps.length
  const pages = [record.overview, ...record.steps.map((s) => s.page)]

  for (const page of pages) {
    if (!page || !page.asciidoc) continue
    const attrs = page.asciidoc.attributes
    attrs['page-solution'] = solutionJson
    attrs['page-solution-nav'] = navJson
    attrs['page-solution-step-count'] = String(count)
    for (const [attr, key] of SCALAR_MIRRORS) {
      const value = publicRecord[key]
      if (value === undefined || value === null || value === '') continue
      attrs[attr] = String(value)
    }
    attrs['page-solution-duration'] = String(publicRecord.duration)
    // Present only when true, so templates can test the attribute's existence.
    if (publicRecord.featured) attrs['page-solution-featured'] = 'true'
    else delete attrs['page-solution-featured']
    attrs['page-solution-platforms'] = publicRecord.platforms.join(', ')
    attrs['page-solution-technologies'] = publicRecord.technologies.join(', ')
    // Step pages show when the solution was last verified without parsing JSON.
    if (publicRecord.verified) {
      const { runAt, redpandaVersion } = publicRecord.verified
      if (runAt) attrs['page-solution-verified-at'] = String(runAt)
      if (redpandaVersion) attrs['page-solution-verified-version'] = String(redpandaVersion)
    }
    if (publicRecord.categories.length) attrs['page-categories'] = publicRecord.categories.join(', ')
  }

  // Overview: first step is "next"
  const overviewAttrs = record.overview.asciidoc.attributes
  overviewAttrs['page-solution-step-index'] = '0'
  if (publicRecord.steps[0]) {
    overviewAttrs['page-solution-next-url'] = publicRecord.steps[0].url
    overviewAttrs['page-solution-next-title'] = publicRecord.steps[0].title
  }

  // Steps: index, prev/next (prev of the first step is the overview)
  const stepPageById = new Map(record.steps.map((s) => [s.id, s.page]))
  publicRecord.steps.forEach((step, i) => {
    const page = stepPageById.get(step.id)
    if (!page || !page.asciidoc) return
    const attrs = page.asciidoc.attributes
    attrs['page-solution-step-id'] = step.id
    attrs['page-solution-step-index'] = String(i + 1)
    const prev = i === 0 ? { url: publicRecord.url, title: publicRecord.title } : publicRecord.steps[i - 1]
    attrs['page-solution-prev-url'] = prev.url
    attrs['page-solution-prev-title'] = prev.title
    const next = publicRecord.steps[i + 1]
    if (next) {
      attrs['page-solution-next-url'] = next.url
      attrs['page-solution-next-title'] = next.title
    }
  })
}

/**
 * Keep only the facet values that actually narrow the catalogue.
 *
 * A value carried by every solution filters nothing: ticking "Runs on: Cloud"
 * when all of them run on Cloud returns the same list, so it is noise in the
 * sidebar rather than a filter. Everything else stays, including a value held
 * by a single solution: that is a narrowing from many to one, which is the
 * whole point of a facet, and it is how a small catalogue grows into a large
 * one without the UI needing to change.
 *
 * A group left with no values renders nothing (every template gates on
 * `.length`), which is also what a one-solution catalogue gets: with nothing
 * to narrow, every value is on every solution.
 *
 * @param {Array<{value: string, count: number}>} values
 * @param {number} total number of solutions in the catalogue
 * @returns {Array<{value: string, count: number}>} the values that discriminate
 */
function discriminating (values, total) {
  return values.filter((v) => v.count < total)
}

function countValues (records, pick) {
  const counts = new Map()
  for (const r of records) {
    // pick() can return undefined for a facet whose attribute the solution
    // never set, so the fallback is the point rather than defensiveness: an
    // optional axis such as industries is absent on most records.
    for (const v of pick(r) || []) {
      if (v === undefined || v === null || v === '') continue
      counts.set(v, (counts.get(v) || 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, count }))
}

/**
 * assets/data/solutions.json: published and deprecated solutions plus facets.
 * Drafts only reach this function when include_drafts admitted them, and then
 * they are listed with status 'draft' and draft: true.
 *
 * `categoryLeaves` maps a solution id to its authored leaf categories (see
 * validateSolution). The Category facet counts those, not `categories`, which
 * also holds the parents normalizeCategories adds: a parent says only "same
 * product area" and would repeat what the Technology facet already shows.
 * Every leaf is also in `categories`, so filtering records on a facet value
 * still works. A solution missing from the map falls back to `categories`.
 */
function buildCatalog (publicRecords, { siteUrl = '', generatedAt = new Date().toISOString(), categoryLeaves } = {}) {
  const solutions = publicRecords
    .filter((r) => CATALOG_STATUSES.includes(r.status) || r.draft === true)
    .sort((a, b) => a.id.localeCompare(b.id))
  const facetCategories = (r) => (categoryLeaves && categoryLeaves.has(r.id) ? categoryLeaves.get(r.id) : r.categories)
  return {
    generatedAt,
    siteUrl,
    solutions,
    // A facet only earns a place when it discriminates. discriminating()
    // drops values that match every solution, because they filter nothing, so
    // the UI needs no change as the catalogue grows from five to fifty. A
    // group left with no values is still published, as an empty list.
    facets: {
      industries: discriminating(countValues(solutions, (r) => r.industries), solutions.length),
      useCases: discriminating(countValues(solutions, (r) => r.useCases), solutions.length),
      categories: discriminating(countValues(solutions, facetCategories), solutions.length),
      technologies: discriminating(countValues(solutions, (r) => r.technologies), solutions.length),
      difficulty: discriminating(countValues(solutions, (r) => [r.difficulty]), solutions.length),
      platforms: discriminating(countValues(solutions, (r) => r.platforms), solutions.length),
    },
  }
}

/** assets/data/solutions-graph.json: every edge with any signal. */
function buildGraph (edges, { siteUrl = '', generatedAt = new Date().toISOString(), maxRelated, minScore, coverage } = {}) {
  const graph = {
    generatedAt,
    siteUrl,
    settings: { maxRelated, minScore },
    edges,
  }
  if (coverage) graph.coverage = coverage
  return graph
}

function toJsonBuffer (value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8')
}

module.exports = {
  CATALOG_STATUSES,
  SCALAR_MIRRORS,
  buildSteps,
  buildPublicRecord,
  buildNav,
  applyPageAttributes,
  buildCatalog,
  buildGraph,
  toJsonBuffer,
  discriminating,
}
