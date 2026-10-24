'use strict'

/**
 * Taxonomy concepts for the solutions catalog: what a solution and a Product
 * Docs page are about, as concept IDs from the docs taxonomy
 * (extension-utils/taxonomy.js), and the validation of a solution's facet
 * values against it.
 *
 * A concept set maps a concept ID to 'direct' (authored, or the replacement of
 * an authored deprecated value) or 'implied' (a broader concept, an `implies`
 * target). Scoring treats implied
 * concepts like the old parent categories: a weak bonus, never an edge on
 * their own.
 *
 * Each shared concept also has a strength, by what it is (`conceptStrength`):
 *
 *   strong  a use case, or a technology that is not a format (a database, a
 *           system, a Redpanda product): what the reader builds, or with what
 *   topic   a leaf topic (Schema Registry, Iceberg Topics), or a legacy
 *           category the taxonomy lacks: the subject area, which many pages
 *           and solutions share
 *   weak    a format technology (Avro, Protobuf, Apache Iceberg), and every
 *           broader match: an implied concept, a topic with narrower ones,
 *           a task
 *
 * relationships.js turns strengths into weights, scales each weight by the
 * concept's rarity (how many of the solutions carry it), and requires a strong
 * concept that most solutions do not carry.
 *
 * A legacy category the taxonomy does not know yet (valid-categories.yml can
 * be ahead of taxonomy.yml) keeps its old signal as the pseudo-concept
 * `category:<label>`, so a gap in the taxonomy does not silently drop edges.
 *
 * Everything here is pure.
 */

const { isLeafCategory } = require('../../extension-utils/categories')
const { checkPageMetadata, CATEGORY_ATTRIBUTE } = require('../../extension-utils/metadata-check')
const { toLegacyCategories } = require('../../extension-utils/taxonomy-categories')

// Schemes whose shared concepts count toward a recommendation. A shared task is
// what a shared legacy parent category was (Development, Management): the
// same product area, so a bonus at most. Content type, industry, and
// deployment never score; deployment is the platform filter's job.
const LEAF_SCHEMES = ['topic', 'use-case', 'technology']
const BONUS_SCHEMES = ['task']
const LEGACY_PREFIX = 'category:'

// Strength of a shared concept. See the header.
const STRENGTH_STRONG = 'strong'
const STRENGTH_TOPIC = 'topic'
const STRENGTH_WEAK = 'weak'
// Technology kinds that only say how data is encoded or stored as files. Two
// pages that both use Avro need not be about the same thing.
const WEAK_TECHNOLOGY_KINDS = ['format']

/** Add an ID unless it is already there as direct. */
function add (concepts, id, weight) {
  if (concepts.get(id) === 'direct') return
  concepts.set(id, weight)
}

/**
 * Concepts of a list of authored page-categories values.
 *
 * @param {import('../../extension-utils/taxonomy').Taxonomy} taxonomy
 * @param {Array<string>} categories - authored, not normalized
 * @param {Object} [categoryMap] - legacy map, to keep categories the taxonomy lacks
 * @returns {{concepts: Map<string, string>, deprecated: Array<Object>, unknown: Array<string>, gaps: Array<string>}}
 *   `unknown` is in neither list; `gaps` are legacy categories the taxonomy lacks
 */
function categoryConcepts (taxonomy, categories, categoryMap) {
  const { concepts, deprecated, unknown } = taxonomy.classify(categories)
  const gaps = []
  const stillUnknown = []
  for (const value of unknown) {
    const legacy = categoryMap && (categoryMap.categories.has(value) || categoryMap.subcategories.has(value))
    if (legacy) {
      gaps.push(value)
      add(concepts, `${LEGACY_PREFIX}${value}`, 'direct')
    } else {
      stillUnknown.push(value)
    }
  }
  return { concepts, deprecated, unknown: stillUnknown, gaps }
}

/**
 * Concepts of a Product Docs page, from its authored categories.
 *
 * The technology of the page's component (Redpanda Connect for `connect`) is
 * deliberately left out here, though search facets include it: as an implied
 * concept it could only add the 0.1 bonus, to an edge with every solution that
 * uses Redpanda Connect from every Connect page, which doubles the graph with
 * edges that can never show.
 */
function docConcepts (taxonomy, { categories, categoryMap } = {}) {
  return categoryConcepts(taxonomy, categories || [], categoryMap).concepts
}

/**
 * Resolve one facet's values within its scheme.
 *
 * @returns {{items: Array<{value: string, id: string, implied?: true}>, unknown: Array<string>, deprecated: Array<Object>, wrongScheme: Array<Object>}}
 */
function resolveFacet (taxonomy, values, scheme, { prefer = 'label' } = {}) {
  const items = []
  const unknown = []
  const deprecated = []
  const wrongScheme = []
  for (const value of values || []) {
    const hit = taxonomy.resolve(value, { prefer })
    if (!hit) {
      unknown.push(value)
      continue
    }
    if (hit.deprecated) deprecated.push({ value, id: hit.concept.id, replacedBy: hit.ids })
    let ids = hit.ids.filter((id) => taxonomy.get(id).scheme === scheme)
    if (hit.concept.scheme !== scheme && !hit.deprecated) {
      // A value from another facet (Kubernetes as a technology). What it
      // implies in this scheme still counts.
      ids = []
      wrongScheme.push({ value, id: hit.concept.id, scheme: hit.concept.scheme })
    }
    let implied = false
    if (!ids.length) {
      for (const id of hit.ids) {
        for (const target of taxonomy.get(id).implies) if (taxonomy.get(target).scheme === scheme) ids.push(target)
      }
      implied = ids.length > 0
    }
    for (const id of ids) {
      if (items.some((i) => i.id === id)) continue
      // An implied item (what a value from another facet implies here) is
      // listed in the facet but scores as an implied concept, not a direct one.
      items.push(implied ? { value, id, implied: true } : { value, id })
    }
  }
  return { items, unknown, deprecated, wrongScheme }
}

/**
 * Validate a solution's facets against the taxonomy and derive its concepts.
 *
 * The findings come from extension-utils/metadata-check.js, the rules
 * `doc-tools check-metadata` runs on the same page in a pull request: an
 * unknown use case, industry, technology, or platform, or two values that are
 * one concept, is an error; a deprecated value or a value from the wrong facet
 * warns. An unknown category is left to the legacy check, which already fails
 * the build on it.
 *
 * @param {import('../../extension-utils/taxonomy').Taxonomy} taxonomy
 * @param {Object} record - collected solution
 * @param {Object} [categoryMap]
 * @returns {{errors: string[], warnings: string[], concepts: Map<string, string>, platformIds: string[], facets: Object}}
 */
function solutionConcepts (taxonomy, record, categoryMap) {
  const isLegacy = categoryMap
    ? (label) => categoryMap.categories.has(label) || categoryMap.subcategories.has(label)
    : undefined
  // Default platforms (collect.js DEFAULT_PLATFORMS, when the overview sets
  // none) are not checked as if the author wrote them.
  const authoredPlatforms = record.platformsAuthored === false ? [] : (record.platforms || [])
  const findings = checkPageMetadata({
    [CATEGORY_ATTRIBUTE]: record.categoriesRaw || [],
    'page-solution-use-cases': record.useCases || [],
    'page-solution-industries': record.industries || [],
    'page-solution-technologies': record.technologies || [],
    'page-solution-platforms': authoredPlatforms,
  }, { taxonomy, solution: true, isLegacyCategory: isLegacy })
  const errors = []
  const warnings = []
  for (const f of findings) {
    if (f.rule === 'unknown-value' && f.attribute === CATEGORY_ATTRIBUTE) continue
    ;(f.severity === 'error' ? errors : warnings).push(f.message)
  }

  const cats = categoryConcepts(taxonomy, record.categoriesRaw || [], categoryMap)
  const facet = (values, scheme, opts) => resolveFacet(taxonomy, values, scheme, opts).items
  const useCases = facet(record.useCases, 'use-case')
  const industries = facet(record.industries, 'industry')
  const technologies = facet(record.technologies, 'technology')
  const platforms = facet(record.platforms, 'deployment', { prefer: 'id' })

  // A platform value that names a concept but no deployment (a technology, or
  // a deprecated value with no deployment replacement) would leave the
  // solution with no platform, and the platform filter would then hide it
  // from every deployment-tagged page. That is an error, not a warning. An
  // unknown value is already one.
  const deploymentIds = taxonomy.conceptIds('deployment')
  for (const value of authoredPlatforms) {
    if (platforms.some((p) => p.value === value) || !taxonomy.resolve(value, { prefer: 'id' })) continue
    errors.push(`page-solution-platforms value '${value}' names no deployment, so the solution would match no deployment-tagged page; use one of ${deploymentIds.join(', ')}`)
  }
  if (record.platformsAuthored === false) {
    const unresolved = (record.platforms || []).filter((value) => !platforms.some((p) => p.value === value))
    if (unresolved.length) {
      warnings.push(`the default page-solution-platforms value${unresolved.length === 1 ? '' : 's'} ${unresolved.join(', ')} ${unresolved.length === 1 ? 'is' : 'are'} not a deployment in taxonomy.yml; set page-solution-platforms on the overview`)
    }
  }

  const direct = new Map(cats.concepts)
  const impliedItems = []
  for (const item of [...useCases, ...technologies]) {
    if (item.implied) impliedItems.push(item.id)
    else direct.set(item.id, 'direct')
  }
  const concepts = new Map()
  for (const [id, weight] of direct) add(concepts, id, weight)
  for (const [id, weight] of taxonomy.expand([...direct.keys()].filter((id) => taxonomy.get(id)))) {
    if (weight === 'implied') add(concepts, id, 'implied')
  }
  for (const id of taxonomy.expand(impliedItems).keys()) add(concepts, id, 'implied')

  const platformIds = [...taxonomy.expand(platforms.map((p) => p.id)).keys()]
  return {
    errors,
    warnings,
    concepts,
    platformIds,
    facets: { useCases, industries, technologies, platforms },
  }
}

/** Is this shared concept specific enough to carry an edge? */
function isLeafConcept (taxonomy, id, categoryMap) {
  if (id.startsWith(LEGACY_PREFIX)) return isLeafCategory(id.slice(LEGACY_PREFIX.length), categoryMap)
  const concept = taxonomy.get(id)
  return Boolean(concept) && LEAF_SCHEMES.includes(concept.scheme) && taxonomy.narrower(id).length === 0
}

function scores (taxonomy, id) {
  if (id.startsWith(LEGACY_PREFIX)) return true
  const concept = taxonomy.get(id)
  return Boolean(concept) && (LEAF_SCHEMES.includes(concept.scheme) || BONUS_SCHEMES.includes(concept.scheme))
}

/**
 * Strength of a shared leaf concept: strong, topic, or weak (see the header).
 * A broader match is always weak, so this is only asked of leaves.
 */
function conceptStrength (taxonomy, id) {
  if (id.startsWith(LEGACY_PREFIX)) return STRENGTH_TOPIC
  const concept = taxonomy.get(id)
  if (!concept) return STRENGTH_WEAK
  if (concept.scheme === 'use-case') return STRENGTH_STRONG
  if (concept.scheme === 'technology') return WEAK_TECHNOLOGY_KINDS.includes(concept.kind) ? STRENGTH_WEAK : STRENGTH_STRONG
  if (concept.scheme === 'topic') return STRENGTH_TOPIC
  return STRENGTH_WEAK
}

/**
 * Split the concepts a doc and a solution share into leaves and broader ones,
 * and group them by strength.
 * A leaf is a topic, use case, or technology with no narrower concepts that
 * both sides carry directly; everything else shared (an implied concept, a
 * concept with narrower ones such as High Availability, a task) is broader.
 *
 * @returns {{sharedLeaves: string[], sharedParents: string[], strong: string[], topics: string[], weak: string[]}}
 *   `strong`, `topics`, and `weak` partition the leaves and parents together
 */
function sharedConcepts (taxonomy, docSet, solutionSet, categoryMap) {
  const sharedLeaves = []
  const sharedParents = []
  const byStrength = { [STRENGTH_STRONG]: [], [STRENGTH_TOPIC]: [], [STRENGTH_WEAK]: [] }
  for (const [id, docWeight] of docSet || []) {
    const solutionWeight = solutionSet && solutionSet.get(id)
    if (!solutionWeight || !scores(taxonomy, id)) continue
    if (docWeight === 'direct' && solutionWeight === 'direct' && isLeafConcept(taxonomy, id, categoryMap)) {
      sharedLeaves.push(id)
      byStrength[conceptStrength(taxonomy, id)].push(id)
    } else {
      sharedParents.push(id)
      byStrength[STRENGTH_WEAK].push(id)
    }
  }
  return {
    sharedLeaves,
    sharedParents,
    strong: byStrength[STRENGTH_STRONG],
    topics: byStrength[STRENGTH_TOPIC],
    weak: byStrength[STRENGTH_WEAK],
  }
}

/**
 * The legacy page-categories list for a list that may hold new labels. The
 * mapping is validate-attributes' (toLegacyCategories), so a solution and a
 * Product Docs page with the same value get the same legacy categories.
 */
function legacyCategories (taxonomy, list, categoryMap) {
  return toLegacyCategories(list, { taxonomy, categoryMap })
}

/** Display label of a concept ID, including legacy pseudo-concepts. */
function conceptLabel (taxonomy, id) {
  return id.startsWith(LEGACY_PREFIX) ? id.slice(LEGACY_PREFIX.length) : taxonomy.label(id)
}

module.exports = {
  LEAF_SCHEMES,
  BONUS_SCHEMES,
  LEGACY_PREFIX,
  STRENGTH_STRONG,
  STRENGTH_TOPIC,
  STRENGTH_WEAK,
  WEAK_TECHNOLOGY_KINDS,
  categoryConcepts,
  legacyCategories,
  docConcepts,
  resolveFacet,
  solutionConcepts,
  sharedConcepts,
  isLeafConcept,
  conceptStrength,
  conceptLabel,
}
