'use strict'

/**
 * assets/data/doc-concepts.json: the inputs of the recommendation scoring, as
 * the build computed them, so a PR check can rerun the same scoring
 * (relationships.computeRelatedSolutions) without building the site. The
 * build writes it with buildDocConceptsIndex, and `doc-tools
 * recommendations-diff` reads it back with readDocConceptsIndex, so the two
 * sides share one shape and one scorer.
 *
 *   docs       every eligible Product Docs page: resource ID, title, URL,
 *              deployment (the platform filter's input), and concept IDs
 *   solutions  every solution scored: the concept set behind its score
 *              (solutions.json carries only the display facets, not implied
 *              concepts or legacy category pseudo-concepts), its platform
 *              concept IDs, and the explicit related docs
 *   relationships  the approved and rejected relationships.yml entries
 *   settings   max_related and min_score as the build applied them
 *
 * A concept set is { <concept ID>: 'direct'|'implied' }, the weights of
 * concepts.js, in the order the build derived them: the order decides the
 * order of the shared concepts in an edge's reason, so it is kept.
 *
 * Everything here is pure.
 */

const INDEX_FILENAME = 'doc-concepts.json'
const INDEX_VERSION = 1

/** Map(id -> 'direct'|'implied') -> { id: weight }, in the map's order. */
function conceptsToJson (map) {
  return Object.fromEntries(map || [])
}

/** { id: weight } -> Map(id -> 'direct'|'implied'). */
function conceptsFromJson (json) {
  return new Map(Object.entries(json || {}))
}

/**
 * Build the index from what the build scored.
 *
 * @param {Object} input
 * @param {Array<{key: string, title?: string, url?: string, deployment?: string, concepts: Map}>} input.docs
 * @param {Array<Object>} input.solutions - validated records, as passed to computeRelatedSolutions
 * @param {Array<Object>} input.relationships - resolved approved/rejected entries
 * @param {{maxRelated: number, minScore: number}} input.settings
 * @param {string} [input.siteUrl]
 * @param {string} [input.generatedAt]
 */
function buildDocConceptsIndex ({ docs, solutions, relationships, settings, siteUrl = '', generatedAt = new Date().toISOString() }) {
  return {
    version: INDEX_VERSION,
    generatedAt,
    siteUrl,
    settings: { maxRelated: settings.maxRelated, minScore: settings.minScore },
    docs: docs
      .filter((d) => d.concepts)
      .map((d) => ({ id: d.key, title: d.title || '', url: d.url || '', deployment: d.deployment || '', concepts: conceptsToJson(d.concepts) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    solutions: solutions
      .map((s) => ({
        id: s.id,
        title: s.title || s.id,
        url: s.url || '',
        status: s.status,
        draft: Boolean(s.draft),
        featured: Boolean(s.featured),
        lastModified: s.lastModified || null,
        platforms: s.platforms || [],
        platformIds: ((s.conceptFacets && s.conceptFacets.platforms) || []).map((p) => p.id),
        concepts: conceptsToJson(s.concepts),
        relatedDocs: [...(s.relatedDocKeys || [])].sort(),
        relatedDocTwins: Object.fromEntries([...(s.relatedDocTwins || new Map())].sort()),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    relationships: (relationships || [])
      .filter((r) => r.status === 'approved' || r.status === 'rejected')
      .map((r) => ({ solutionId: r.solutionId, docKey: r.docKey, status: r.status, confidence: r.confidence === undefined ? null : r.confidence, reason: r.reason || '' }))
      .sort((a, b) => a.solutionId.localeCompare(b.solutionId) || a.docKey.localeCompare(b.docKey)),
  }
}

/** One index solution entry -> the record shape computeRelatedSolutions reads. */
function solutionFromJson (s) {
  return {
    id: s.id,
    title: s.title,
    url: s.url,
    status: s.status,
    draft: Boolean(s.draft),
    featured: Boolean(s.featured),
    lastModified: s.lastModified || null,
    platforms: s.platforms || [],
    conceptFacets: { platforms: (s.platformIds || []).map((id) => ({ id })) },
    concepts: conceptsFromJson(s.concepts),
    categories: [],
    relatedDocKeys: new Set(s.relatedDocs || []),
    relatedDocTwins: new Map(Object.entries(s.relatedDocTwins || {})),
  }
}

/** One index doc entry -> the doc shape computeRelatedSolutions reads. */
function docFromJson (d) {
  return { key: d.id, title: d.title, url: d.url, deployment: d.deployment || '', categories: [], concepts: conceptsFromJson(d.concepts) }
}

/**
 * Read a published index back into computeRelatedSolutions inputs.
 *
 * @param {Object} json - parsed doc-concepts.json
 * @returns {{docs: Array<Object>, solutions: Array<Object>, relationships: Array<Object>, settings: {maxRelated: number, minScore: number}, generatedAt: string, siteUrl: string}}
 * @throws {Error} when it is not an index this code can read
 */
function readDocConceptsIndex (json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.docs) || !Array.isArray(json.solutions)) {
    throw new Error(`${INDEX_FILENAME} has no docs and solutions lists`)
  }
  if (json.version !== INDEX_VERSION) throw new Error(`${INDEX_FILENAME} version ${json.version} is not ${INDEX_VERSION}`)
  return {
    docs: json.docs.map(docFromJson),
    solutions: json.solutions.map(solutionFromJson),
    relationships: (json.relationships || []).map((r) => ({ ...r })),
    settings: { maxRelated: json.settings.maxRelated, minScore: json.settings.minScore },
    generatedAt: json.generatedAt,
    siteUrl: json.siteUrl,
  }
}

module.exports = {
  INDEX_FILENAME,
  INDEX_VERSION,
  conceptsToJson,
  conceptsFromJson,
  buildDocConceptsIndex,
  readDocConceptsIndex,
  solutionFromJson,
  docFromJson,
}
