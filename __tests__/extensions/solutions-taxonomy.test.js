'use strict'

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const { parseTaxonomy } = require('../../extension-utils/taxonomy')
const { createCategoryMap } = require('../../extension-utils/categories')
const concepts = require('../../extensions/solutions-catalog/concepts')
const relationships = require('../../extensions/solutions-catalog/relationships')
const outputs = require('../../extensions/solutions-catalog/outputs')
const generateIndex = require('../../extensions/algolia-indexer/generate-index')

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'taxonomy')
const taxonomy = parseTaxonomy(fs.readFileSync(path.join(FIXTURES, 'taxonomy.yml')))
const categoryMap = createCategoryMap(yaml.load(fs.readFileSync(path.join(FIXTURES, 'valid-categories.yml'), 'utf8'))['page-valid-categories'])

function record (overrides = {}) {
  return {
    id: 'cdc-to-lakehouse',
    title: 'CDC to a lakehouse',
    url: '/solutions/cdc-to-lakehouse/',
    status: 'published',
    featured: false,
    categoriesRaw: ['Iceberg', 'Tiered Storage'],
    categories: ['Iceberg', 'Tiered Storage', 'Deployment'],
    useCases: ['Change data capture'],
    industries: [],
    technologies: ['Postgres', 'Apache Iceberg', 'Redpanda Connect'],
    platforms: ['self-managed'],
    relatedDocKeys: new Set(),
    ...overrides,
  }
}

/** A solution record as validateSolution leaves it with the taxonomy. */
function resolved (overrides) {
  const r = record(overrides)
  const result = concepts.solutionConcepts(taxonomy, r, categoryMap)
  return Object.assign(r, { concepts: result.concepts, platformIds: result.platformIds, conceptFacets: result.facets, result })
}

const doc = (key, categories, deployment = '') => ({
  key,
  url: `/${key}/`,
  categories,
  concepts: concepts.docConcepts(taxonomy, { categories, categoryMap }),
  deployment,
})

describe('solution facets against the taxonomy', () => {
  test('aliases resolve: Postgres, self-managed, and a deprecated category', () => {
    const r = resolved()
    expect(r.conceptFacets.technologies.map((t) => t.id)).toEqual(['postgresql', 'apache-iceberg', 'redpanda-connect'])
    expect(r.conceptFacets.platforms).toEqual([{ value: 'self-managed', id: 'docker' }])
    expect(r.platformIds).toEqual(['docker', 'redpanda-self-managed'])
    expect(r.result.errors).toEqual([])
    expect(r.result.warnings).toEqual(["page-categories value 'Iceberg' is deprecated; use 'Iceberg Topics' instead"])
  })

  test('an unknown use case, technology, or platform is an error', () => {
    const r = resolved({ useCases: ['Data mesh'], technologies: ['Kafkaesque'], platforms: ['mainframe'] })
    expect(r.result.errors).toEqual([
      "page-solution-use-cases value 'Data mesh' is not in the taxonomy; use an existing use-case, or add it to taxonomy.yml in the docs repository first",
      "page-solution-technologies value 'Kafkaesque' is not in the taxonomy; use an existing technology, or add it to taxonomy.yml in the docs repository first",
      "page-solution-platforms value 'mainframe' is not in the taxonomy; use an existing deployment, or add it to taxonomy.yml in the docs repository first",
    ])
  })

  test('a value from another facet warns and adds nothing to that facet', () => {
    const r = resolved({ technologies: ['Postgres', 'Kubernetes'] })
    expect(r.result.errors).toEqual([])
    expect(r.result.warnings).toContain("page-solution-technologies value 'Kubernetes' is Kubernetes (deployment), not a technology")
    expect(r.conceptFacets.technologies.map((t) => t.id)).toEqual(['postgresql'])
  })

  test('a category that repeats a use case is an error, as in the PR check', () => {
    const r = resolved({ categoriesRaw: ['Stream Processing'], useCases: ['Stream processing'] })
    expect(r.result.errors).toEqual(["page-solution-use-cases value 'Stream processing' is the same concept as page-categories value 'Stream Processing': Stream processing (use-case). Keep one"])
  })

  test('an unknown category is left to the legacy check', () => {
    expect(resolved({ categoriesRaw: ['Nonsense'] }).result.errors).toEqual([])
  })

  test('legacyCategories maps new labels back to legacy ones', () => {
    expect(concepts.legacyCategories(taxonomy, ['Iceberg Topics', 'Security', 'Postgres', 'Nonsense'], categoryMap)).toEqual(['Iceberg', 'Security', 'Nonsense'])
  })
})

describe('concept scoring', () => {
  test('shared leaf topics score 0.3 each; an implied technology adds the 0.1 bonus', () => {
    const s = conceptsScore(doc('iceberg', ['Iceberg', 'Tiered Storage']), resolved())
    expect(s.score).toBe(0.7)
    expect(s.sharedLeaves).toEqual(['Iceberg Topics', 'Tiered Storage'])
    expect(s.sharedParents).toEqual(['Apache Iceberg'])
  })

  test("a solution's use case counts when a doc carries it as a category", () => {
    const s = conceptsScore(doc('cdc', ['Change data capture', 'Tiered Storage']), resolved())
    expect(s.sharedLeaves).toEqual(['Change data capture', 'Tiered Storage'])
    expect(s.score).toBe(0.6)
  })

  test('a topic with narrower concepts and a shared task are bonuses only', () => {
    const s = conceptsScore(doc('ha', ['High Availability', 'Management']), resolved({ categoriesRaw: ['High Availability', 'Management'] }))
    expect(s.sharedLeaves).toEqual([])
    expect(s.score).toBe(0.1)
  })

  test('a narrower topic implies its broader one for the bonus', () => {
    const s = conceptsScore(doc('rep', ['Data Replication']), resolved({ categoriesRaw: ['Data Replication'] }))
    expect(s.sharedLeaves).toEqual(['Replication'])
    expect(s.sharedParents).toEqual(['High Availability'])
    expect(s.score).toBe(0.4)
  })

  test('a legacy category the taxonomy lacks keeps its old weight', () => {
    const s = conceptsScore(doc('ts', ['Troubleshooting']), resolved({ categoriesRaw: ['Troubleshooting'] }))
    expect(s.sharedLeaves).toEqual(['Troubleshooting'])
  })

  test('a deprecated value with no replacement scores nothing', () => {
    expect(conceptsScore(doc('int', ['Integration']), resolved({ categoriesRaw: ['Integration'] })).score).toBe(0)
  })

  function conceptsScore (d, solution) {
    return relationships.conceptScore(d.concepts, solution.concepts, taxonomy, categoryMap)
  }
})

describe('computeRelatedSolutions with the taxonomy', () => {
  test('edges carry the shared concept IDs and a concept reason', () => {
    const { edges, related } = relationships.computeRelatedSolutions({
      docs: [doc('streaming:manage:iceberg.adoc', ['Iceberg', 'Tiered Storage'])],
      solutions: [resolved()],
      relationships: [],
      categoryMap,
      taxonomy,
    })
    expect(edges[0]).toMatchObject({
      provenance: 'category',
      score: 0.7,
      shown: true,
      reason: 'shares Iceberg Topics, Tiered Storage (and the broader Apache Iceberg)',
      why: 'Uses Iceberg Topics, Tiered Storage',
      shared: { leaves: ['iceberg-topics', 'tiered-storage'], broader: ['apache-iceberg'] },
    })
    expect(related.get('streaming:manage:iceberg.adoc')).toHaveLength(1)
  })

  test('the platform filter reads platform IDs: a Docker page matches self-managed, a Kubernetes page does not', () => {
    const run = (deployment) => relationships.computeRelatedSolutions({
      docs: [doc('d', ['Iceberg', 'Tiered Storage'], deployment)],
      solutions: [resolved()],
      relationships: [],
      categoryMap,
      taxonomy,
    }).edges[0].shown
    expect(run('Docker')).toBe(true)
    expect(run('Linux')).toBe(true)
    expect(run('Kubernetes')).toBe(false)
    expect(run('Redpanda Cloud')).toBe(false)
  })

  test('without the taxonomy, scoring is the category scoring', () => {
    const { edges } = relationships.computeRelatedSolutions({
      docs: [{ key: 'd', url: '/d/', categories: ['Iceberg', 'Tiered Storage', 'Deployment'], deployment: '' }],
      solutions: [record()],
      relationships: [],
      categoryMap,
    })
    expect(edges[0].reason).toBe('shares categories Iceberg, Tiered Storage (and the parent category Deployment)')
    expect(edges[0]).not.toHaveProperty('shared')
  })
})

describe('catalog output', () => {
  test('each solution lists its concepts next to the authored values', () => {
    const r = resolved({ industries: ['iGaming'] })
    const pub = outputs.buildPublicRecord({ ...r, steps: [], stepIds: [] }, { steps: [], taxonomy })
    expect(pub.platforms).toEqual(['self-managed'])
    expect(pub.concepts.platforms).toEqual([{ value: 'self-managed', id: 'docker', label: 'Docker Compose' }])
    expect(pub.concepts.technologies).toContainEqual({ value: 'Redpanda Connect', id: 'redpanda-connect', label: 'Redpanda Connect', kind: 'redpanda-product', component: 'connect' })
    expect(pub.concepts.technologies).toContainEqual({ value: 'Postgres', id: 'postgresql', label: 'PostgreSQL', kind: 'database' })
    expect(pub.concepts.industries).toEqual([{ value: 'iGaming', id: 'gambling', label: 'Gambling' }])
    expect(pub.concepts.topics).toEqual([{ id: 'iceberg-topics', label: 'Iceberg Topics' }, { id: 'tiered-storage', label: 'Tiered Storage' }])
  })

  test('without the taxonomy there is no concepts field', () => {
    expect(outputs.buildPublicRecord({ ...record(), steps: [], stepIds: [] }, { steps: [] })).not.toHaveProperty('concepts')
  })

  test('the catalog carries the platform labels and the product of each component', () => {
    const catalog = outputs.buildCatalog([], { siteUrl: 'https://docs.redpanda.com', taxonomy })
    expect(catalog.taxonomy.source).toBe('https://docs.redpanda.com/shared/_attachments/taxonomy.yml')
    expect(catalog.taxonomy.platforms).toContainEqual({ id: 'docker', label: 'Docker Compose', altLabels: ['self-managed', 'Docker'], broader: 'redpanda-self-managed' })
    expect(catalog.taxonomy.technologies).toContainEqual({ id: 'redpanda-connect', label: 'Redpanda Connect', kind: 'redpanda-product', component: 'connect' })
    expect(outputs.buildCatalog([], {})).not.toHaveProperty('taxonomy')
  })
})

describe('Algolia solution records with the taxonomy', () => {
  test('technologies become prefLabels; platforms stay as authored', () => {
    const r = resolved({ technologies: ['Postgres', 'Kubernetes'] })
    const pub = outputs.buildPublicRecord({ ...r, steps: [], stepIds: [] }, { steps: [], taxonomy })
    const comp = { name: 'solutions', title: 'Solutions', latest: { version: '' } }
    const page = {
      contents: Buffer.from('<article class="doc"><h1>CDC</h1><div class="paragraph"><p>Intro.</p></div></article>'),
      out: { dirname: 'solutions/cdc', basename: 'index.html' },
      pub: { url: '/solutions/cdc/' },
      src: { component: 'solutions', version: '', origin: {} },
      asciidoc: {
        attributes: {
          'page-layout': 'solution',
          'page-solution-id': 'cdc',
          'page-solution': JSON.stringify(pub),
          'page-solution-technologies': 'Postgres, Kubernetes',
          'page-solution-platforms': 'self-managed',
          'page-categories': 'Iceberg, Tiered Storage, Deployment',
        },
      },
    }
    const index = generateIndex({ site: { url: 'https://docs.redpanda.com' } }, {
      getPages: (fn) => [page].filter((p) => fn(p) !== undefined),
      getComponent: () => comp,
      getComponentVersion: () => comp.latest,
      getComponents: () => [comp],
    }, { logger: { info () {}, warn () {}, debug () {}, error () {} }, taxonomy })
    const rec = index.solutions[''][0]
    expect(rec.technologies).toEqual(['PostgreSQL'])
    expect(rec.technologyIds).toEqual(['postgresql'])
    expect(rec.platforms).toEqual(['self-managed'])
    expect(rec.deployments).toEqual(['Docker Compose'])
    expect(rec).not.toHaveProperty('deployment')
    expect(rec.useCaseIds).toEqual(['change-data-capture'])
    expect(rec.topicIds).toEqual(['iceberg-topics', 'tiered-storage'])
    expect(rec.categories).toEqual(['Iceberg', 'Tiered Storage', 'Deployment'])
  })
})

describe('category coverage with the taxonomy', () => {
  const docs = [
    // Legacy normalization drops the new labels from categories; the authored list keeps them.
    { url: '/a/', categories: [], authoredCategories: ['Iceberg Topics', 'Replication'] },
    { url: '/b/', categories: ['Iceberg'] },
    { url: '/c/', categories: ['Security'] },
  ]
  const solutions = [{ id: 's', categories: ['Iceberg', 'Data Replication', 'Ghost'] }]

  test('a page counts for a category when they name the same concept', () => {
    const coverage = relationships.computeCoverage({ docs, solutions, categoryMap, taxonomy })
    expect(coverage.solutions.s.categories.Iceberg.pages).toBe(2)
    expect(coverage.solutions.s.categories['Data Replication'].pages).toBe(1)
    expect(coverage.solutions.s.zeroMatch).toEqual(['Ghost'])
  })

  test('without the taxonomy, labels must match exactly, as before', () => {
    const coverage = relationships.computeCoverage({ docs, solutions, categoryMap })
    expect(coverage.solutions.s.categories.Iceberg.pages).toBe(1)
    expect(coverage.solutions.s.zeroMatch).toEqual(['Data Replication', 'Ghost'])
    expect(coverage.uncategorizedEligiblePages).toBe(1)
  })
})

describe('review fixes: legacy mapping, platforms, and facet weights', () => {
  const { toLegacyCategories } = require('../../extension-utils/taxonomy-categories')
  const shown = (solution, deployment) => relationships.computeRelatedSolutions({
    docs: [doc('d', ['Iceberg', 'Tiered Storage'], deployment)],
    solutions: [solution],
    relationships: [],
    categoryMap,
    taxonomy,
  }).edges[0].shown

  test('a use-case spelling of a legacy category maps the same way on a solution and a docs page', () => {
    const list = ['Disaster recovery', 'Stream processing']
    expect(concepts.legacyCategories(taxonomy, list, categoryMap)).toEqual(['Disaster Recovery', 'Stream Processing'])
    expect(concepts.legacyCategories(taxonomy, list, categoryMap)).toEqual(toLegacyCategories(list, { taxonomy, categoryMap }))
    // Control: the legacy spelling itself passes through unchanged.
    expect(concepts.legacyCategories(taxonomy, ['Disaster Recovery'], categoryMap)).toEqual(['Disaster Recovery'])
  })

  test('the broader self-managed platform matches every self-managed page, and not Cloud', () => {
    const broad = resolved({ platforms: ['redpanda-self-managed'] })
    expect(broad.result.errors).toEqual([])
    expect(shown(broad, 'Linux')).toBe(true)
    expect(shown(broad, 'Docker')).toBe(true)
    expect(shown(broad, 'Kubernetes')).toBe(true)
    expect(shown(broad, 'Redpanda Cloud')).toBe(false)
    // Control: the narrower docker concept still needs its own Kubernetes path.
    expect(shown(resolved({ platforms: ['docker'] }), 'Kubernetes')).toBe(false)
  })

  test('Cloud as a label counts as running on Cloud', () => {
    expect(relationships.runsOnCloud(resolved({ platforms: ['Cloud'] }), taxonomy)).toBe(true)
    expect(relationships.runsOnCloud(resolved({ platforms: ['Redpanda Cloud'] }), taxonomy)).toBe(true)
    expect(shown(resolved({ platforms: ['Cloud'] }), 'Redpanda Cloud')).toBe(true)
    // Controls: a self-managed solution does not, and without the taxonomy the
    // fallback value is compared as written.
    expect(relationships.runsOnCloud(resolved({ platforms: ['self-managed'] }), taxonomy)).toBe(false)
    expect(relationships.runsOnCloud(record({ platforms: ['Cloud'] }))).toBe(false)
    expect(relationships.runsOnCloud(record({ platforms: ['cloud'] }))).toBe(true)
  })

  test('a platform value from another facet is an error, not a warning that hides the solution', () => {
    const r = resolved({ platforms: ['redpanda-connect'] })
    expect(r.result.errors).toEqual([
      "page-solution-platforms value 'redpanda-connect' names no deployment, so the solution would match no deployment-tagged page; use one of cloud, redpanda-self-managed, docker, kubernetes, linux",
    ])
    // Control: a deployment value is fine.
    expect(resolved({ platforms: ['docker'] }).result.errors).toEqual([])
  })

  test('default platforms are not checked as authored values', () => {
    const defaulted = resolved({ platforms: ['mainframe'], platformsAuthored: false })
    expect(defaulted.result.errors).toEqual([])
    expect(defaulted.result.warnings).toContain('the default page-solution-platforms value mainframe is not a deployment in taxonomy.yml; set page-solution-platforms on the overview')
    // Control: the same value written by the author is fatal.
    expect(resolved({ platforms: ['mainframe'], platformsAuthored: true }).result.errors).toHaveLength(1)
  })

  test('a deprecated value from another scheme is a wrong-facet warning, not a false duplicate', () => {
    const r = resolved({ technologies: ['Iceberg'], categoriesRaw: ['Iceberg Topics'] })
    expect(r.result.errors).toEqual([])
    expect(r.result.warnings).toEqual(["page-solution-technologies value 'Iceberg' is Iceberg (topic), deprecated, not a technology"])
    expect(r.conceptFacets.technologies.map((t) => t.id)).toEqual(['apache-iceberg'])
    // Control: as a category, where its replacement is in scheme, the same
    // value is deprecated and is the same concept as Iceberg Topics.
    const dup = resolved({ categoriesRaw: ['Iceberg', 'Iceberg Topics'] })
    expect(dup.result.warnings).toContain("page-categories value 'Iceberg' is deprecated; use 'Iceberg Topics' instead")
    expect(dup.result.errors).toEqual(["page-categories value 'Iceberg Topics' is the same concept as page-categories value 'Iceberg': Iceberg Topics (topic). Keep one"])
  })

  test('a concept a wrong-facet value implies scores as implied, not direct', () => {
    const viaTopic = resolved({ technologies: ['Iceberg Topics'], categoriesRaw: ['Tiered Storage'] })
    expect(viaTopic.conceptFacets.technologies).toEqual([{ value: 'Iceberg Topics', id: 'apache-iceberg', implied: true }])
    expect(viaTopic.concepts.get('apache-iceberg')).toBe('implied')
    // Control: the technology written directly is direct.
    expect(resolved({ technologies: ['Apache Iceberg'], categoriesRaw: ['Tiered Storage'] }).concepts.get('apache-iceberg')).toBe('direct')
  })

  test('a deployment the taxonomy cannot name leaves the page unfiltered, with one warning', () => {
    const { edges, warnings } = relationships.computeRelatedSolutions({
      docs: [doc('a', ['Iceberg', 'Tiered Storage'], 'Mainframe'), doc('b', ['Iceberg', 'Tiered Storage'], 'Mainframe')],
      solutions: [resolved()],
      relationships: [],
      categoryMap,
      taxonomy,
    })
    expect(edges.map((e) => e.shown)).toEqual([true, true])
    expect(warnings).toEqual(['the taxonomy has no deployment concept for Mainframe pages; their category recommendations are not filtered by platform'])
  })
})
