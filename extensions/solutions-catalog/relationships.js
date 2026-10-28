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
 *   category         0.3 per shared leaf category (a subcategory, or a top-level category
 *                    with no subcategories) + 0.1 per shared parent category (a top-level
 *                    one that has subcategories; capped at 0.1 per edge), cap 0.85
 *   concept          with the docs taxonomy, category edges score shared concept IDs instead
 *                    (see concepts.js), weighted by what each concept is:
 *                      strong  0.3 per use case, or technology that is not a format
 *                              (database, system, Redpanda product)       SCORE_STRONG
 *                      topic   0.2 per leaf topic, or legacy category the taxonomy
 *                              lacks                                       SCORE_TOPIC
 *                      weak    0.1 per format technology (Avro, Protobuf, Apache Iceberg)
 *                              or broader match (an implied concept, a topic with
 *                              narrower ones such as High Availability, a task),
 *                              capped at 0.1 per edge                      SCORE_WEAK, SCORE_WEAK_CAP
 *                    Each weight is then multiplied by the concept's rarity across the
 *                    solutions (see rarityFactor): 1 for a concept on at most a third of
 *                    them (RARITY_FULL_SHARE), falling with an IDF curve,
 *                    log((N+1)/(df+1)) / log((N+1)/(N/3+1)), to 0 for a concept on every
 *                    solution. With 6 solutions, a concept on 1 or 2 counts in full, on 3
 *                    0.66, on 4 0.397, on 5 0.182. Schema Registry, on 4 of 6, says little
 *                    about which solution fits a page; Iceberg Topics, on 1, says a lot.
 *                    The score is capped at 0.85. A concept edge also needs at least MIN_STRONG_SHARED (1)
 *                    strong concept to show: topics and formats alone, however many,
 *                    never recommend a solution. A strong concept on more than half the
 *                    solutions (RARITY_COMMON_SHARE) is common and does not count toward
 *                    MIN_STRONG_SHARED, though it still scores. With fewer than
 *                    RARITY_MIN_SOLUTIONS (4) solutions, rarity is off: every concept
 *                    counts in full. A solution's use cases and technologies count as
 *                    well as its categories. Explicit, editor-approved, and rejected
 *                    edges are not scored this way.
 *   platform filter  category edges only: Cloud doc -> platforms includes cloud,
 *                    Kubernetes doc -> platforms includes kubernetes,
 *                    Linux/Docker doc -> platforms includes self-managed (the docker concept).
 *                    With the taxonomy, by deployment concept, broader and narrower
 *                    concepts included (see platformCompatible)
 *   threshold        min_score (default 0.6): a category-only edge needs two shared leaf
 *                    categories; parent-only or single-leaf overlap never shows. A concept
 *                    edge needs a strong concept plus enough else: two strong concepts, or
 *                    a strong one, a topic, and a weak match, all rare enough to count in full
 *   rank             score desc, featured desc, shared leaf categories desc, lastModified desc,
 *                    title asc; cap max_related. An explicit edge cut by the cap is kept in the
 *                    graph (shown: false) and reported as a warning, because an author asked for it
 *   why              reader-facing reason on every recommendation: explicit edges take the
 *                    overview's Related docs sentence for the doc (fallback: the relationships.yml
 *                    reason), editor-approved edges the relationships.yml reason, category edges
 *                    "Uses <shared leaf categories>"
 *   excluded         solution status != published (a draft built with include_drafts counts as published)
 *
 * Everything here is pure so the ranking can be unit tested without Antora.
 */

const path = require('path')
const yaml = require('js-yaml')
const { isLeafCategory } = require('../../extension-utils/categories')
const concepts = require('./concepts')

const SCORE_EXPLICIT = 1.0
const SCORE_APPROVED_FLOOR = 0.9
const SCORE_PER_LEAF = 0.3
const SCORE_PER_PARENT = 0.1
// Every solution shares a parent with every doc in the same area; that says
// nothing about the page, so parents contribute at most one bonus per edge.
const SCORE_PARENT_CAP = 0.1
const SCORE_CATEGORY_CAP = 0.85
const DEFAULT_MIN_SCORE = 0.6

// Concept weights, by strength (concepts.js conceptStrength). A use case or a
// named system says what the reader builds; a topic says only which part of
// the product is involved, and many solutions share one; a format or a broader
// match says almost nothing.
const SCORE_STRONG = 0.3
const SCORE_TOPIC = 0.2
const SCORE_WEAK = 0.1
// Weak matches together add one bonus at most, as parent categories did, so
// three formats cannot stand in for a strong concept.
const SCORE_WEAK_CAP = 0.1
// A concept edge with fewer strong concepts than this never shows, whatever
// its score: "Specify an Iceberg schema" must not recommend a gaming solution
// for sharing Schema Registry and Protobuf.
const MIN_STRONG_SHARED = 1

// Rarity: how many of the solutions carry a shared concept (its document
// frequency, df). A concept most solutions carry cannot say which of them a
// page should recommend. See rarityFactor.
//
// A concept on at most this share of the solutions counts in full.
const RARITY_FULL_SHARE = 1 / 3
// A strong concept on more than this share is common: it still scores, but it
// does not count as the strong concept an edge needs to show.
const RARITY_COMMON_SHARE = 0.5
// With fewer solutions than this, every concept is on a large share of them,
// so rarity says nothing and is off.
const RARITY_MIN_SOLUTIONS = 4

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
 * Leaf categories carry the signal: a subcategory, or a top-level category with
 * no subcategories at all (`Schema Registry`, `Troubleshooting`, `rpk`), is a
 * specific statement about the page. A top-level category that has children is
 * not, because `normalizeCategories` adds it to every page that names one of
 * its subcategories, so it only says "same product area".
 *
 * @param {Array<string>} docCategories - normalized (parents present)
 * @param {Array<string>} solutionCategories - normalized
 * @param {ReturnType<import('../../extension-utils/categories').createCategoryMap>} [categoryMap]
 * @returns {{score: number, sharedLeaves: Array<string>, sharedParents: Array<string>}}
 */
function categoryScore (docCategories, solutionCategories, categoryMap) {
  const solutionSet = new Set(solutionCategories || [])
  const sharedLeaves = []
  const sharedParents = []
  for (const c of docCategories || []) {
    if (!solutionSet.has(c)) continue
    if (isLeafCategory(c, categoryMap)) sharedLeaves.push(c)
    else sharedParents.push(c)
  }
  const raw = sharedLeaves.length * SCORE_PER_LEAF +
    Math.min(SCORE_PARENT_CAP, sharedParents.length * SCORE_PER_PARENT)
  const score = Math.min(SCORE_CATEGORY_CAP, round(raw))
  return { score, sharedLeaves, sharedParents }
}

/**
 * Rarity factor of a concept that `df` of `total` solutions carry: an IDF
 * weight, normalized so a concept on at most RARITY_FULL_SHARE of the
 * solutions counts 1, and one on every solution counts 0.
 *
 *   factor = log((total + 1) / (df + 1)) / log((total + 1) / (full + 1)),
 *   full = max(1, total * RARITY_FULL_SHARE), and 1 when df <= full
 *
 * Below RARITY_MIN_SOLUTIONS solutions, every factor is 1.
 *
 * @param {number} df - solutions that carry the concept
 * @param {number} total - solutions scored
 * @returns {number} between 0 and 1, rounded to 3 places
 */
function rarityFactor (df, total) {
  if (total < RARITY_MIN_SOLUTIONS) return 1
  const full = Math.max(1, total * RARITY_FULL_SHARE)
  if (df <= full) return 1
  return Math.max(0, round(Math.log((total + 1) / (df + 1)) / Math.log((total + 1) / (full + 1))))
}

/** Is a concept that `df` of `total` solutions carry on most of them? */
function isCommonConcept (df, total) {
  return total >= RARITY_MIN_SOLUTIONS && df / total > RARITY_COMMON_SHARE
}

/**
 * Document frequency of every concept across the solutions, counted once per
 * solution whether it carries the concept directly or as implied.
 *
 * @param {Array<{concepts?: Map<string, string>}>} solutions - the solutions scored
 * @returns {{total: number, df: Map<string, number>, factor: (id: string) => number, common: (id: string) => boolean}}
 */
function conceptRarity (solutions) {
  const df = new Map()
  let total = 0
  for (const solution of solutions || []) {
    if (!solution.concepts) continue
    total++
    for (const id of solution.concepts.keys()) df.set(id, (df.get(id) || 0) + 1)
  }
  return {
    total,
    df,
    factor: (id) => rarityFactor(df.get(id) || 0, total),
    common: (id) => isCommonConcept(df.get(id) || 0, total),
  }
}

/**
 * Concept overlap between a doc and a solution, weighted by concept strength
 * and, when `rarity` is given, by each concept's rarity across the solutions.
 *
 * @param {Map<string, string>} docConcepts - concept ID -> 'direct' | 'implied'
 * @param {Map<string, string>} solutionConcepts
 * @param {import('../../extension-utils/taxonomy').Taxonomy} taxonomy
 * @param {Object} [categoryMap] - for legacy categories the taxonomy lacks
 * @param {ReturnType<typeof conceptRarity>} [rarity] - without it, every concept counts in full
 * @returns {{score: number, strong: boolean, common: Array<string>, sharedLeaves: Array<string>, sharedParents: Array<string>}}
 *   labels, plus the IDs in `ids`; `strong` is whether the edge has the strong
 *   concepts it needs to show, and `common` names the strong concepts that do
 *   not count because most solutions carry them. `ids.strong` lists the strong
 *   concepts that count; with rarity on, `ids.rarity` maps every shared concept
 *   to its factor
 */
function conceptScore (docConcepts, solutionConcepts, taxonomy, categoryMap, rarity) {
  const shared = concepts.sharedConcepts(taxonomy, docConcepts, solutionConcepts, categoryMap)
  const factor = rarity ? rarity.factor : () => 1
  const weigh = (ids, weight) => ids.reduce((sum, id) => sum + weight * factor(id), 0)
  const raw = weigh(shared.strong, SCORE_STRONG) +
    weigh(shared.topics, SCORE_TOPIC) +
    Math.min(SCORE_WEAK_CAP, weigh(shared.weak, SCORE_WEAK))
  const common = rarity ? shared.strong.filter(rarity.common) : []
  const strong = shared.strong.filter((id) => !common.includes(id))
  const label = (id) => concepts.conceptLabel(taxonomy, id)
  const ids = { leaves: shared.sharedLeaves, broader: shared.sharedParents, strong }
  if (rarity && rarity.total >= RARITY_MIN_SOLUTIONS) {
    ids.rarity = Object.fromEntries([...shared.sharedLeaves, ...shared.sharedParents].map((id) => [id, factor(id)]))
  }
  return {
    score: Math.min(SCORE_CATEGORY_CAP, round(raw)),
    strong: strong.length >= MIN_STRONG_SHARED,
    common: common.map(label),
    sharedLeaves: shared.sharedLeaves.map(label),
    sharedParents: shared.sharedParents.map(label),
    ids,
  }
}

/** Readable explanation of a category edge, naming what actually matched. */
function formatCategoryReason ({ sharedLeaves, sharedParents }) {
  const parents = sharedParents.length
    ? `parent categor${sharedParents.length === 1 ? 'y' : 'ies'} ${sharedParents.join(', ')}`
    : ''
  if (!sharedLeaves.length) return parents ? `shares only the ${parents}` : 'shares no categories'
  const leaves = `shares categories ${sharedLeaves.join(', ')}`
  return parents ? `${leaves} (and the ${parents})` : leaves
}

/** Readable explanation of a concept-scored edge, by concept label. */
function formatConceptReason ({ sharedLeaves, sharedParents }) {
  const broader = sharedParents.length ? `broader ${sharedParents.join(', ')}` : ''
  if (!sharedLeaves.length) return broader ? `shares only the ${broader}` : 'shares no concepts'
  const leaves = `shares ${sharedLeaves.join(', ')}`
  return broader ? `${leaves} (and the ${broader})` : leaves
}

/**
 * Reader-facing reason for a category edge: the leaf categories the page and
 * the solution share. Parents say only "same product area", so they are left
 * out; an edge with no shared leaf gets no reason rather than a vague one.
 */
function formatCategoryWhy ({ sharedLeaves }) {
  return sharedLeaves.length ? `Uses ${sharedLeaves.join(', ')}` : ''
}

// getDeploymentType values.
const CLOUD_DEPLOYMENT = 'Redpanda Cloud'
const SELF_MANAGED_PEERS = ['Linux', 'Docker']

/**
 * Platform filter for category edges. A doc with no deployment marker matches
 * every solution.
 *
 * Without the taxonomy, the fallback platform values are compared as written.
 * With it, the doc's deployment (a getDeploymentType value) and the
 * solution's platforms are deployment concepts, and they match when one is the
 * other, or one is the other's broader concept: a solution that says Redpanda
 * Self-Managed matches Linux, Docker, and Kubernetes pages, and a BYOC
 * solution matches a Redpanda Cloud page. Linux and Docker pages share one
 * audience, as they always have, so the base self-managed run (Docker
 * Compose) matches a Linux page too. A Kubernetes page needs a solution with
 * its own Kubernetes path.
 *
 * @param {string} deployment - from getDeploymentType
 * @param {Array<string>} platforms - solution platforms, as authored (fallback check)
 * @param {{taxonomy: Object, ids: Array<string>}} [byConcept] - the taxonomy and
 *   the solution's resolved platform concept IDs (see solutionPlatformIds)
 * @returns {boolean|null} null when the taxonomy has no deployment concept for
 *   `deployment`, so the caller can say the page is left unfiltered
 */
function platformCompatible (deployment, platforms, byConcept) {
  if (!deployment) return true
  if (byConcept && byConcept.taxonomy) {
    const { taxonomy, ids } = byConcept
    const idsOf = (value) => {
      const hit = taxonomy.resolve(value, { schemes: ['deployment'] })
      return hit ? hit.ids : []
    }
    const audience = new Set(idsOf(deployment))
    if (!audience.size) return null
    if (SELF_MANAGED_PEERS.includes(deployment)) {
      for (const peer of SELF_MANAGED_PEERS) for (const id of idsOf(peer)) audience.add(id)
    }
    const broader = (id) => {
      const concept = taxonomy.get(id)
      return concept ? concept.broader : null
    }
    return (ids || []).some((s) => [...audience].some((d) => s === d || broader(d) === s || broader(s) === d))
  }
  const set = new Set(platforms || [])
  if (deployment === CLOUD_DEPLOYMENT) return set.has('cloud')
  // A Kubernetes page recommends only solutions a Kubernetes reader can run
  // there: the ones with their own Kubernetes path.
  if (deployment === 'Kubernetes') return set.has('kubernetes')
  return set.has('self-managed')
}

/** A validated solution's direct platform concept IDs (empty without the taxonomy). */
function solutionPlatformIds (solution) {
  const items = (solution && solution.conceptFacets && solution.conceptFacets.platforms) || []
  return items.map((p) => p.id)
}

/**
 * Does the solution run on Redpanda Cloud? With the taxonomy, by concept, so
 * `Cloud`, `Redpanda Cloud`, and a narrower Cloud concept all count.
 */
function runsOnCloud (solution, taxonomy) {
  return Boolean(platformCompatible(CLOUD_DEPLOYMENT, solution.platforms,
    taxonomy && solution.conceptFacets ? { taxonomy, ids: solutionPlatformIds(solution) } : undefined))
}

function round (n) {
  return Math.round(n * 1000) / 1000
}

function compareCandidates (a, b) {
  if (b.score !== a.score) return b.score - a.score
  if (a.solution.featured !== b.solution.featured) return a.solution.featured ? -1 : 1
  // Equal scores are common: every explicit edge scores 1.0. The number of
  // leaf categories the solution shares with the page is the semantic signal
  // left, so it decides before dates and the alphabet do.
  const al = a.sharedLeaves || 0
  const bl = b.sharedLeaves || 0
  if (al !== bl) return bl - al
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
 *   and `relatedDocKeys` (Set of doc keys resolved from page-solution-related-docs). Optional:
 *   `relatedDocWhy` (Map doc key -> the overview's Related docs sentence) and
 *   `relatedDocTwins` (Map Cloud twin key -> the related doc key it single-sources)
 * @param {Array<{solutionId: string, docKey: string, status: string, confidence: number|null, reason: string}>} input.relationships
 *   resolved approved/rejected entries (pending already dropped)
 * @param {Object} input.categoryMap
 * @param {number} [input.maxRelated=3]
 * @param {number} [input.minScore=0.3]
 * @returns {{related: Map<string, Array<Object>>, edges: Array<Object>, warnings: Array<string>}}
 *   `related` maps doc key to the shown recommendation items in rank order;
 *   `edges` is every (doc, solution) pair with any signal, for solutions-graph.json;
 *   `warnings` names every doc where max_related hid an explicit edge.
 */
function computeRelatedSolutions ({ docs, solutions, relationships, categoryMap, taxonomy, maxRelated = 3, minScore = DEFAULT_MIN_SCORE }) {
  const related = new Map()
  const edges = []
  const warnings = []
  const unfiltered = new Set()
  // Rarity is computed over the solutions scored, so a draft built with
  // include_drafts counts, and one left out does not. A deprecated solution is
  // never recommended, so it does not count either.
  const rarity = taxonomy ? conceptRarity(solutions.filter((s) => s.status !== 'deprecated')) : null

  const relByPair = new Map()
  for (const rel of relationships || []) {
    relByPair.set(`${rel.solutionId} ${rel.docKey}`, rel)
  }

  for (const doc of docs) {
    const candidates = []
    for (const solution of solutions) {
      const rel = relByPair.get(`${solution.id} ${doc.key}`)
      const explicit = solution.relatedDocKeys && solution.relatedDocKeys.has(doc.key)
      const byConcepts = Boolean(taxonomy && doc.concepts && solution.concepts)
      const cat = byConcepts
        ? conceptScore(doc.concepts, solution.concepts, taxonomy, categoryMap, rarity)
        : categoryScore(doc.categories, solution.categories, categoryMap)

      if (!explicit && !rel && cat.score === 0) continue // no signal at all

      let provenance
      let score
      let reason
      let why
      if (explicit) {
        provenance = 'explicit'
        score = SCORE_EXPLICIT
        const twinOf = solution.relatedDocTwins && solution.relatedDocTwins.get(doc.key)
        reason = twinOf
          ? `listed in page-solution-related-docs as ${twinOf}, which this page single-sources`
          : 'listed in page-solution-related-docs'
        why = (solution.relatedDocWhy && solution.relatedDocWhy.get(doc.key)) || (rel && rel.reason) || ''
      } else if (rel && rel.status === 'approved') {
        provenance = 'editor-approved'
        score = Math.max(SCORE_APPROVED_FLOOR, rel.confidence || 0)
        reason = rel.reason ? `approved in relationships.yml: ${rel.reason}` : 'approved in relationships.yml'
        why = rel.reason || ''
      } else {
        provenance = 'category'
        score = cat.score
        reason = byConcepts ? formatConceptReason(cat) : formatCategoryReason(cat)
        why = formatCategoryWhy(cat)
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
        why,
      }
      // The concepts behind the score, so the graph shows what matched by ID.
      if (byConcepts && (cat.ids.leaves.length || cat.ids.broader.length)) edge.shared = cat.ids

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
      const compatible = provenance === 'category'
        ? platformCompatible(doc.deployment, solution.platforms, byConcepts ? { taxonomy, ids: solutionPlatformIds(solution) } : undefined)
        : true
      if (compatible === null && !unfiltered.has(doc.deployment)) {
        unfiltered.add(doc.deployment)
        warnings.push(`the taxonomy has no deployment concept for ${doc.deployment} pages; their category recommendations are not filtered by platform`)
      }
      if (compatible === false) {
        edge.reason = `${edge.reason}; hidden: ${doc.deployment} page, solution platforms ${solution.platforms.join(', ')}`
        edges.push(edge)
        continue
      }
      if (score < minScore) {
        edge.reason = `${edge.reason}; hidden: score ${edge.score} below ${minScore}`
        edges.push(edge)
        continue
      }
      if (provenance === 'category' && byConcepts && !cat.strong) {
        edge.reason = cat.common.length
          ? `${edge.reason}; hidden: no shared use case or technology that few solutions carry (${cat.common.join(', ')} ${cat.common.length === 1 ? 'is' : 'are'} on most solutions)`
          : `${edge.reason}; hidden: no shared use case or technology (formats do not count)`
        edges.push(edge)
        continue
      }
      candidates.push({ edge, solution, score, sharedLeaves: cat.sharedLeaves.length })
    }

    candidates.sort(compareCandidates)
    const shown = []
    const cutExplicit = []
    candidates.forEach((c, i) => {
      if (i < maxRelated) {
        c.edge.shown = true
        c.edge.rank = i + 1
        shown.push(toRecommendation(c.solution, c.edge))
      } else {
        c.edge.reason = `${c.edge.reason}; hidden: rank ${i + 1} exceeds max_related ${maxRelated}`
        if (c.edge.provenance === 'explicit') cutExplicit.push(c.solution.id)
      }
      edges.push(c.edge)
    })
    if (shown.length) related.set(doc.key, shown)
    if (cutExplicit.length) {
      const explicitCount = candidates.filter((c) => c.edge.provenance === 'explicit').length
      warnings.push(`${doc.key}: ${explicitCount} solutions list this page in page-solution-related-docs but max_related is ${maxRelated}; hidden: ${cutExplicit.join(', ')}`)
    }
  }

  edges.sort((a, b) => a.doc.localeCompare(b.doc) || a.solution.localeCompare(b.solution))
  return { related, edges, warnings }
}

/**
 * Category coverage: for every solution, how many eligible doc pages share each
 * of its categories, so an author can see which categories reach readers and
 * which reach nobody. Uses the same doc set and normalized categories as the
 * recommendations.
 *
 * @param {Object} input
 * @param {Array<{url: string, categories: Array<string>, authoredCategories?: Array<string>}>} input.docs -
 *   eligible doc pages. With a taxonomy, `authoredCategories` (what the page
 *   says, before legacy normalization drops labels valid-categories.yml lacks)
 *   is counted when present.
 * @param {Array<Object>} input.solutions - active records (published or included drafts)
 * @param {Object} [input.categoryMap]
 * @param {import('../../extension-utils/taxonomy').Taxonomy} [input.taxonomy] - when
 *   present, a page counts for a category when they name the same concept, so a
 *   page rewritten from Iceberg to Iceberg Topics still counts for a solution
 *   that says Iceberg
 * @param {number} [input.sampleSize=20]
 * @returns {{solutions: Object, uncategorizedEligiblePages: number, uncategorizedSample: Array<string>}}
 */
function computeCoverage ({ docs, solutions, categoryMap, taxonomy, sampleSize = 20 }) {
  // The keys a category label counts under: its concept IDs (a deprecated
  // value's replacements), or the label itself without a taxonomy or a match.
  // Memoized: the same labels recur on thousands of pages.
  const keyCache = new Map()
  const keysOf = (label) => {
    if (keyCache.has(label)) return keyCache.get(label)
    const hit = taxonomy ? taxonomy.resolve(label) : null
    const keys = hit && hit.ids.length ? hit.ids.map((id) => `id:${id}`) : [`label:${label}`]
    keyCache.set(label, keys)
    return keys
  }
  const categoriesOf = (doc) => (taxonomy && doc.authoredCategories ? doc.authoredCategories : doc.categories) || []
  const counts = new Map()
  const uncategorized = []
  // Each doc's key set, computed once for the multi-key lookups below.
  const docKeySets = []
  for (const doc of docs) {
    if (!categoriesOf(doc).length) {
      uncategorized.push(doc.url)
      continue
    }
    const keys = new Set(categoriesOf(doc).flatMap(keysOf))
    docKeySets.push(keys)
    for (const k of keys) counts.set(k, (counts.get(k) || 0) + 1)
  }
  const pagesFor = (label) => {
    const keys = keysOf(label)
    if (keys.length === 1) return counts.get(keys[0]) || 0
    let n = 0
    for (const set of docKeySets) {
      if (keys.some((k) => set.has(k))) n++
    }
    return n
  }
  const level = (c) => (categoryMap && categoryMap.categories.has(c) && !categoryMap.subcategories.has(c) ? 'top' : 'sub')

  const perSolution = {}
  for (const solution of solutions) {
    const categories = {}
    const zeroMatch = []
    // With the taxonomy, the solution side counts what it authored too, not
    // the parents normalization adds, which no doc lists as authored.
    const solutionCategories = (taxonomy && solution.categoriesRaw ? solution.categoriesRaw : solution.categories) || []
    for (const c of solutionCategories) {
      const pages = pagesFor(c)
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
    technologies: solution.technologies,
    provenance: edge.provenance,
    score: edge.score,
    reason: edge.reason,
    // For the reader, unlike `reason`, which explains the ranking to authors.
    why: edge.why || '',
  }
}

module.exports = {
  SCORE_EXPLICIT,
  SCORE_APPROVED_FLOOR,
  SCORE_PER_LEAF,
  SCORE_PER_PARENT,
  SCORE_PARENT_CAP,
  SCORE_CATEGORY_CAP,
  DEFAULT_MIN_SCORE,
  SCORE_STRONG,
  SCORE_TOPIC,
  SCORE_WEAK,
  SCORE_WEAK_CAP,
  MIN_STRONG_SHARED,
  RARITY_FULL_SHARE,
  RARITY_COMMON_SHARE,
  RARITY_MIN_SOLUTIONS,
  SCHEMA_PATH,
  createRelationshipsValidator,
  parseRelationships,
  categoryScore,
  rarityFactor,
  isCommonConcept,
  conceptRarity,
  conceptScore,
  formatCategoryReason,
  formatConceptReason,
  formatCategoryWhy,
  platformCompatible,
  solutionPlatformIds,
  runsOnCloud,
  computeRelatedSolutions,
  computeCoverage,
  formatCoverageLine,
}
