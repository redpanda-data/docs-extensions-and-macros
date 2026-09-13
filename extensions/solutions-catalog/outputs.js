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
 * solutions.json. `repo` is carried for the download function; the UI never
 * renders it.
 */
function buildPublicRecord (record, { steps, relatedDocs = [], relatedSolutions = [] } = {}) {
  return {
    id: record.id,
    title: record.title,
    description: record.description,
    url: record.url,
    version: record.version,
    tag: record.tag,
    asset: record.asset,
    repo: record.repo,
    status: record.status,
    featured: Boolean(record.featured),
    difficulty: record.difficulty,
    duration: Number(record.duration),
    download: record.download,
    platforms: record.platforms,
    technologies: record.technologies,
    categories: record.categories,
    useCases: record.useCases,
    personas: record.personas,
    steps: steps || buildSteps(record),
    relatedDocs,
    relatedSolutions,
    attachments: record.attachments,
    supersededBy: record.supersededBy || null,
    lastModified: record.lastModified || null,
  }
}

/** Sidebar model: Solutions home, overview, ordered steps. */
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

function countValues (records, pick) {
  const counts = new Map()
  for (const r of records) {
    for (const v of pick(r)) {
      if (v === undefined || v === null || v === '') continue
      counts.set(v, (counts.get(v) || 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, count }))
}

/** assets/data/solutions.json: published and deprecated solutions plus facets. */
function buildCatalog (publicRecords, { siteUrl = '', generatedAt = new Date().toISOString() } = {}) {
  const solutions = publicRecords
    .filter((r) => CATALOG_STATUSES.includes(r.status))
    .sort((a, b) => a.id.localeCompare(b.id))
  return {
    generatedAt,
    siteUrl,
    solutions,
    facets: {
      categories: countValues(solutions, (r) => r.categories),
      technologies: countValues(solutions, (r) => r.technologies),
      difficulty: countValues(solutions, (r) => [r.difficulty]),
      platforms: countValues(solutions, (r) => r.platforms),
    },
  }
}

/** assets/data/solutions-graph.json: every edge with any signal. */
function buildGraph (edges, { siteUrl = '', generatedAt = new Date().toISOString(), maxRelated, minScore } = {}) {
  return {
    generatedAt,
    siteUrl,
    settings: { maxRelated, minScore },
    edges,
  }
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
}
