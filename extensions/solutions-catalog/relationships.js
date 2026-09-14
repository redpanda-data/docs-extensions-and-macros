'use strict'

/**
 * The content graph between Product Docs pages and solutions.
 *
 * Deterministic scoring with provenance on every edge:
 *
 *   explicit         doc listed in the solution's page-solution-related-docs    1.0
 *   editor-approved  relationships.yml status: approved                          max(0.9, confidence)
 *   rejected         relationships.yml status: rejected                          suppressed (edge kept, shown: false)
 *   pending          ignored (awaiting review)
 *   category         0.3 per shared subcategory + 0.1 per shared top-level (parents capped
 *                    at 0.1 per edge in total), cap 0.85
 *   platform filter  category edges only: Cloud doc -> platforms includes cloud,
 *                    Kubernetes/Linux/Docker doc -> platforms includes self-managed
 *   threshold        min_score (default 0.6): a category-only edge needs two shared
 *                    subcategories; parent-only or single-subcategory overlap never shows
 *   rank             score desc, featured desc, lastModified desc, title asc; cap max_related
 *   excluded         solution status != published (a draft built with include_drafts counts as published)
 *
 * Everything here is pure so the ranking can be unit tested without Antora.
 */

const path = require('path')
const yaml = require('js-yaml')

const SCORE_EXPLICIT = 1.0
const SCORE_APPROVED_FLOOR = 0.9
const SCORE_PER_SUBCATEGORY = 0.3
const SCORE_PER_TOP_LEVEL = 0.1
// Every solution shares a parent with every doc in the same area; that says
// nothing about the page, so parents contribute at most one bonus per edge.
const SCORE_TOP_LEVEL_CAP = 0.1
const SCORE_CATEGORY_CAP = 0.85
const DEFAULT_MIN_SCORE = 0.6

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'docs-data', 'solutions-relationships.schema.json')

/** Compile the relationships schema once. */
function createRelationshipsValidator () {
  const Ajv2020 = require('ajv/dist/2020')
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  return ajv.compile(require(SCHEMA_PATH))
}

/**
 * Parse relationships.yml. Uses the core YAML schema so unquoted dates stay
 * strings, which is what the JSON schema expects for reviewedAt.
 */
function parseRelationships (text) {
  const data = yaml.load(String(text || ''), { schema: yaml.CORE_SCHEMA })
  return data === undefined || data === null ? { relationships: [] } : data
}

/**
 * Category overlap between a doc and a solution.
 *
 * @param {Array<string>} docCategories - normalized (parents present)
 * @param {Array<string>} solutionCategories - normalized
 * @param {{subcategories: Set<string>, categories: Set<string>}} categoryMap
 * @returns {{score: number, sharedSub: Array<string>, sharedTop: Array<string>}}
 */
function categoryScore (docCategories, solutionCategories, categoryMap) {
  const solutionSet = new Set(solutionCategories || [])
  const sharedSub = []
  const sharedTop = []
  for (const c of docCategories || []) {
    if (!solutionSet.has(c)) continue
    if (categoryMap && categoryMap.subcategories.has(c)) sharedSub.push(c)
    else if (categoryMap && categoryMap.categories.has(c)) sharedTop.push(c)
    else sharedSub.push(c) // no map: treat every match as specific
  }
  const raw = sharedSub.length * SCORE_PER_SUBCATEGORY + Math.min(SCORE_TOP_LEVEL_CAP, sharedTop.length * SCORE_PER_TOP_LEVEL)
  const score = Math.min(SCORE_CATEGORY_CAP, round(raw))
  return { score, sharedSub, sharedTop }
}

/**
 * Platform filter for category edges. A doc with no deployment marker matches
 * every solution.
 *
 * @param {string} deployment - from getDeploymentType
 * @param {Array<string>} platforms - solution platforms
 */
function platformCompatible (deployment, platforms) {
  if (!deployment) return true
  const set = new Set(platforms || [])
  if (deployment === 'Redpanda Cloud') return set.has('cloud')
  return set.has('self-managed')
}

function round (n) {
  return Math.round(n * 1000) / 1000
}

function compareCandidates (a, b) {
  if (b.score !== a.score) return b.score - a.score
  if (a.solution.featured !== b.solution.featured) return a.solution.featured ? -1 : 1
  const am = a.solution.lastModified || ''
  const bm = b.solution.lastModified || ''
  if (am !== bm) return am < bm ? 1 : -1
  return String(a.solution.title || '').localeCompare(String(b.solution.title || ''))
}

/**
 * Compute recommendations for every eligible doc.
 *
 * @param {Object} input
 * @param {Array<{key: string, url: string, categories: Array<string>, deployment: string}>} input.docs
 * @param {Array<Object>} input.solutions - validated records with normalized `categories`
 *   and `relatedDocKeys` (Set of doc keys resolved from page-solution-related-docs)
 * @param {Array<{solutionId: string, docKey: string, status: string, confidence: number|null, reason: string}>} input.relationships
 *   resolved approved/rejected entries (pending already dropped)
 * @param {Object} input.categoryMap
 * @param {number} [input.maxRelated=3]
 * @param {number} [input.minScore=0.3]
 * @returns {{related: Map<string, Array<Object>>, edges: Array<Object>}}
 *   `related` maps doc key to the shown recommendation items in rank order;
 *   `edges` is every (doc, solution) pair with any signal, for solutions-graph.json.
 */
function computeRelatedSolutions ({ docs, solutions, relationships, categoryMap, maxRelated = 3, minScore = DEFAULT_MIN_SCORE }) {
  const related = new Map()
  const edges = []

  const relByPair = new Map()
  for (const rel of relationships || []) {
    relByPair.set(`${rel.solutionId} ${rel.docKey}`, rel)
  }

  for (const doc of docs) {
    const candidates = []
    for (const solution of solutions) {
      const rel = relByPair.get(`${solution.id} ${doc.key}`)
      const explicit = solution.relatedDocKeys && solution.relatedDocKeys.has(doc.key)
      const cat = categoryScore(doc.categories, solution.categories, categoryMap)

      if (!explicit && !rel && cat.score === 0) continue // no signal at all

      let provenance
      let score
      let reason
      if (explicit) {
        provenance = 'explicit'
        score = SCORE_EXPLICIT
        reason = 'listed in page-solution-related-docs'
      } else if (rel && rel.status === 'approved') {
        provenance = 'editor-approved'
        score = Math.max(SCORE_APPROVED_FLOOR, rel.confidence || 0)
        reason = rel.reason ? `approved in relationships.yml: ${rel.reason}` : 'approved in relationships.yml'
      } else {
        provenance = 'category'
        score = cat.score
        const parts = []
        if (cat.sharedSub.length) parts.push(cat.sharedSub.join(', '))
        if (cat.sharedTop.length) parts.push(`(${cat.sharedTop.join(', ')})`)
        reason = `shares categories ${parts.join(' ')}`.trim()
      }

      const edge = {
        doc: doc.key,
        docUrl: doc.url,
        solution: solution.id,
        provenance,
        score: round(score),
        shown: false,
        rank: null,
        reason,
      }

      if (rel && rel.status === 'rejected') {
        edge.provenance = 'rejected'
        edge.reason = rel.reason ? `rejected in relationships.yml: ${rel.reason}` : 'rejected in relationships.yml'
        edges.push(edge)
        continue
      }
      if (solution.status !== 'published' && !solution.draft) {
        edge.reason = `${edge.reason}; hidden: solution status is ${solution.status}`
        edges.push(edge)
        continue
      }
      if (provenance === 'category' && !platformCompatible(doc.deployment, solution.platforms)) {
        edge.reason = `${edge.reason}; hidden: ${doc.deployment} page, solution platforms ${solution.platforms.join(', ')}`
        edges.push(edge)
        continue
      }
      if (score < minScore) {
        edge.reason = `${edge.reason}; hidden: score ${edge.score} below ${minScore}`
        edges.push(edge)
        continue
      }
      candidates.push({ edge, solution, score })
    }

    candidates.sort(compareCandidates)
    const shown = []
    candidates.forEach((c, i) => {
      if (i < maxRelated) {
        c.edge.shown = true
        c.edge.rank = i + 1
        shown.push(toRecommendation(c.solution, c.edge))
      } else {
        c.edge.reason = `${c.edge.reason}; hidden: rank ${i + 1} exceeds max_related ${maxRelated}`
      }
      edges.push(c.edge)
    })
    if (shown.length) related.set(doc.key, shown)
  }

  edges.sort((a, b) => a.doc.localeCompare(b.doc) || a.solution.localeCompare(b.solution))
  return { related, edges }
}

/**
 * Category coverage: for every solution, how many eligible doc pages share each
 * of its categories, so an author can see which categories reach readers and
 * which reach nobody. Uses the same doc set and normalized categories as the
 * recommendations.
 *
 * @param {Object} input
 * @param {Array<{url: string, categories: Array<string>}>} input.docs - eligible doc pages
 * @param {Array<Object>} input.solutions - active records (published or included drafts)
 * @param {Object} [input.categoryMap]
 * @param {number} [input.sampleSize=20]
 * @returns {{solutions: Object, uncategorizedEligiblePages: number, uncategorizedSample: Array<string>}}
 */
function computeCoverage ({ docs, solutions, categoryMap, sampleSize = 20 }) {
  const counts = new Map()
  const uncategorized = []
  for (const doc of docs) {
    if (!doc.categories || !doc.categories.length) {
      uncategorized.push(doc.url)
      continue
    }
    for (const c of new Set(doc.categories)) counts.set(c, (counts.get(c) || 0) + 1)
  }
  const level = (c) => (categoryMap && categoryMap.categories.has(c) && !categoryMap.subcategories.has(c) ? 'top' : 'sub')

  const perSolution = {}
  for (const solution of solutions) {
    const categories = {}
    const zeroMatch = []
    for (const c of solution.categories || []) {
      const pages = counts.get(c) || 0
      categories[c] = { pages, level: level(c) }
      if (pages === 0) zeroMatch.push(c)
    }
    perSolution[solution.id] = { categories, zeroMatch }
  }
  return {
    solutions: perSolution,
    uncategorizedEligiblePages: uncategorized.length,
    uncategorizedSample: uncategorized.slice(0, sampleSize),
  }
}

/** One log line per solution: `<slug> reach: Clients=13 (sub), Development=28 (top); zero-match: X, Y`. */
function formatCoverageLine (slug, entry) {
  const reach = Object.entries(entry.categories).map(([c, v]) => `${c}=${v.pages} (${v.level})`).join(', ') || 'none'
  const zero = entry.zeroMatch.length ? entry.zeroMatch.join(', ') : 'none'
  return `solutions-catalog: ${slug} reach: ${reach}; zero-match: ${zero}`
}

function toRecommendation (solution, edge) {
  return {
    id: solution.id,
    title: solution.title,
    url: solution.url,
    description: solution.description,
    difficulty: solution.difficulty,
    duration: Number(solution.duration),
    technologies: solution.technologies,
    provenance: edge.provenance,
    score: edge.score,
    reason: edge.reason,
  }
}

module.exports = {
  SCORE_EXPLICIT,
  SCORE_APPROVED_FLOOR,
  SCORE_PER_SUBCATEGORY,
  SCORE_PER_TOP_LEVEL,
  SCORE_TOP_LEVEL_CAP,
  SCORE_CATEGORY_CAP,
  DEFAULT_MIN_SCORE,
  SCHEMA_PATH,
  createRelationshipsValidator,
  parseRelationships,
  categoryScore,
  platformCompatible,
  computeRelatedSolutions,
  computeCoverage,
  formatCoverageLine,
}
