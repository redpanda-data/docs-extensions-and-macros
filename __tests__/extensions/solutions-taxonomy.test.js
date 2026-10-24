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
  test('the weights are named: strong 0.3, topic 0.2, weak 0.1 capped at 0.1, one strong concept required', () => {
    expect(relationships.SCORE_STRONG).toBe(0.3)
    expect(relationships.SCORE_TOPIC).toBe(0.2)
    expect(relationships.SCORE_WEAK).toBe(0.1)
    expect(relationships.SCORE_WEAK_CAP).toBe(0.1)
    expect(relationships.MIN_STRONG_SHARED).toBe(1)
  })

  test('strength by kind: a use case and a non-format technology are strong, a topic is a topic, a format is weak', () => {
    expect(concepts.conceptStrength(taxonomy, 'change-data-capture')).toBe('strong')
    expect(concepts.conceptStrength(taxonomy, 'postgresql')).toBe('strong')
    expect(concepts.conceptStrength(taxonomy, 'redpanda-connect')).toBe('strong')
    expect(concepts.conceptStrength(taxonomy, 'schema-registry')).toBe('topic')
    expect(concepts.conceptStrength(taxonomy, 'category:Troubleshooting')).toBe('topic')
    expect(concepts.conceptStrength(taxonomy, 'avro')).toBe('weak')
    expect(concepts.conceptStrength(taxonomy, 'apache-iceberg')).toBe('weak')
  })

  test('shared leaf topics score 0.2 each; an implied technology adds the 0.1 bonus; no strong concept', () => {
    const s = conceptsScore(doc('iceberg', ['Iceberg', 'Tiered Storage']), resolved())
    expect(s.score).toBe(0.5)
    expect(s.strong).toBe(false)
    expect(s.sharedLeaves).toEqual(['Iceberg Topics', 'Tiered Storage'])
    expect(s.sharedParents).toEqual(['Apache Iceberg'])
    expect(s.ids.strong).toEqual([])
  })

  test("a solution's use case counts, as a strong concept, when a doc carries it as a category", () => {
    const s = conceptsScore(doc('cdc', ['Change data capture', 'Tiered Storage']), resolved())
    expect(s.sharedLeaves).toEqual(['Change data capture', 'Tiered Storage'])
    expect(s.score).toBe(0.5)
    expect(s.strong).toBe(true)
    expect(s.ids.strong).toEqual(['change-data-capture'])
  })

  test('a database technology is strong; formats are weak and capped together', () => {
    const s = conceptsScore(doc('fmt', ['Postgres', 'Avro', 'Protobuf']), resolved({ technologies: ['Postgres', 'Avro', 'Protobuf'] }))
    expect(s.sharedLeaves).toEqual(['PostgreSQL', 'Avro', 'Protobuf'])
    expect(s.ids.strong).toEqual(['postgresql'])
    expect(s.score).toBe(0.4)
  })

  test('a topic with narrower concepts and a shared task are bonuses only', () => {
    const s = conceptsScore(doc('ha', ['High Availability', 'Management']), resolved({ categoriesRaw: ['High Availability', 'Management'] }))
    expect(s.sharedLeaves).toEqual([])
    expect(s.score).toBe(0.1)
    expect(s.strong).toBe(false)
  })

  test('a narrower topic implies its broader one for the bonus', () => {
    const s = conceptsScore(doc('rep', ['Data Replication']), resolved({ categoriesRaw: ['Data Replication'] }))
    expect(s.sharedLeaves).toEqual(['Replication'])
    expect(s.sharedParents).toEqual(['High Availability'])
    expect(s.score).toBe(0.3)
  })

  test('a legacy category the taxonomy lacks counts as a topic', () => {
    const s = conceptsScore(doc('ts', ['Troubleshooting']), resolved({ categoriesRaw: ['Troubleshooting'] }))
    expect(s.sharedLeaves).toEqual(['Troubleshooting'])
    expect(s.score).toBe(0.2)
  })

  test('a deprecated value with no replacement scores nothing', () => {
    expect(conceptsScore(doc('int', ['Integration']), resolved({ categoriesRaw: ['Integration'] })).score).toBe(0)
  })

  function conceptsScore (d, solution) {
    return relationships.conceptScore(d.concepts, solution.concepts, taxonomy, categoryMap)
  }
})

describe('computeRelatedSolutions with the taxonomy', () => {
  const run = ({ docs, solutions = [resolved()], rels = [], minScore }) => relationships.computeRelatedSolutions({
    docs, solutions, relationships: rels, categoryMap, taxonomy, ...(minScore === undefined ? {} : { minScore }),
  })

  test('edges carry the shared concept IDs and a concept reason', () => {
    const { edges, related } = run({ docs: [doc('streaming:manage:iceberg.adoc', ['Iceberg', 'Tiered Storage', 'Change data capture'])] })
    expect(edges[0]).toMatchObject({
      provenance: 'category',
      score: 0.8,
      shown: true,
      reason: 'shares Iceberg Topics, Tiered Storage, Change data capture (and the broader Apache Iceberg)',
      why: 'Uses Iceberg Topics, Tiered Storage, Change data capture',
      shared: { leaves: ['iceberg-topics', 'tiered-storage', 'change-data-capture'], broader: ['apache-iceberg'], strong: ['change-data-capture'] },
    })
    expect(related.get('streaming:manage:iceberg.adoc')).toHaveLength(1)
  })

  test('topics alone never show, even above min_score', () => {
    const solution = resolved({ categoriesRaw: ['Iceberg', 'Tiered Storage', 'Security'], useCases: ['Stream processing'], technologies: ['rpk'] })
    const { edges, related } = run({ docs: [doc('d', ['Iceberg Topics', 'Tiered Storage', 'Security'])], solutions: [solution] })
    expect(edges[0].score).toBe(0.7)
    expect(edges[0].shown).toBe(false)
    expect(edges[0].reason).toBe('shares Iceberg Topics, Tiered Storage, Security (and the broader Apache Iceberg); hidden: no shared use case or technology (formats do not count)')
    expect(related.size).toBe(0)
  })

  // "Specify an Iceberg schema" recommended multiplayer-gaming and
  // sports-data-fanout because all three name Schema Registry and a
  // serialization format.
  const icebergSchema = ['Iceberg Topics', 'Tiered Storage', 'Schema Registry', 'Data lakehouse', 'Avro', 'Protobuf']
  const gaming = () => resolved({
    id: 'multiplayer-gaming',
    categoriesRaw: ['Schema Registry'],
    useCases: ['Stream processing'],
    technologies: ['Redpanda Connect', 'Protobuf', 'Postgres'],
  })

  test('Specify an Iceberg schema: Schema Registry and a format do not recommend a gaming solution', () => {
    const { edges } = run({ docs: [doc('streaming:manage:iceberg/specify-iceberg-schema.adoc', icebergSchema)], solutions: [gaming()], minScore: 0.3 })
    expect(edges[0]).toMatchObject({
      solution: 'multiplayer-gaming',
      provenance: 'category',
      score: 0.3,
      shown: false,
      shared: { leaves: ['schema-registry', 'protobuf'], broader: [], strong: [] },
    })
    expect(edges[0].reason).toMatch(/hidden: no shared use case or technology/)
  })

  test('migrate-to-iceberg-topics still recommends cdc-to-lakehouse: a topic, a use case, and the implied format', () => {
    const lakehouse = resolved({ categoriesRaw: ['Iceberg'], useCases: ['Change data capture', 'Data lakehouse'] })
    const { edges } = run({ docs: [doc('streaming:manage:iceberg/migrate-to-iceberg-topics.adoc', ['Iceberg Topics', 'Schema Registry', 'Data lakehouse'])], solutions: [lakehouse] })
    expect(edges[0]).toMatchObject({ score: 0.6, shown: true, shared: { leaves: ['iceberg-topics', 'data-lakehouse'], broader: ['apache-iceberg'], strong: ['data-lakehouse'] } })
  })

  test('explicit and approved edges ignore the strength rule; rejected still suppresses', () => {
    const d = doc('streaming:manage:iceberg/specify-iceberg-schema.adoc', icebergSchema)
    const explicit = run({ docs: [d], solutions: [Object.assign(gaming(), { relatedDocKeys: new Set([d.key]) })] }).edges[0]
    expect(explicit).toMatchObject({ provenance: 'explicit', score: 1, shown: true })
    const approved = run({ docs: [d], solutions: [gaming()], rels: [{ solutionId: 'multiplayer-gaming', docKey: d.key, status: 'approved', confidence: null, reason: 'Schemas' }] }).edges[0]
    expect(approved).toMatchObject({ provenance: 'editor-approved', score: 0.9, shown: true })
    const strongDoc = doc('cdc', ['Change data capture', 'Postgres', 'Tiered Storage'])
    expect(run({ docs: [strongDoc] }).edges[0].shown).toBe(true)
    const rejected = run({ docs: [strongDoc], rels: [{ solutionId: 'cdc-to-lakehouse', docKey: 'cdc', status: 'rejected', confidence: null, reason: 'Off topic' }] }).edges[0]
    expect(rejected).toMatchObject({ provenance: 'rejected', shown: false })
  })

  test('the platform filter reads platform IDs: a Docker page matches self-managed, a Kubernetes page does not', () => {
    const run = (deployment) => relationships.computeRelatedSolutions({
      docs: [doc('d', ['Iceberg', 'Tiered Storage', 'Change data capture'], deployment)],
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

describe('concept rarity across solutions', () => {
  // Six solutions shaped like the catalog: Schema Registry on 4 of 6, Redpanda
  // Connect on 4, Avro and PostgreSQL on 3, Schema management on 2, and the
  // lakehouse concepts (Iceberg Topics, Data lakehouse) on 1.
  const catalog = () => [
    resolved({ id: 'cdc-to-lakehouse', categoriesRaw: ['Iceberg', 'Tiered Storage'], useCases: ['Change data capture', 'Data lakehouse'], technologies: ['Redpanda Connect', 'Apache Iceberg', 'Postgres'] }),
    resolved({ id: 'disaster-recovery', categoriesRaw: ['Data Replication', 'High Availability'], useCases: ['Disaster recovery'], technologies: ['rpk'] }),
    resolved({ id: 'kafka-migration', categoriesRaw: ['Security', 'Schema Registry'], useCases: [], technologies: ['Redpanda Connect', 'Avro'] }),
    resolved({ id: 'kafka-migration-shadowing', categoriesRaw: ['Security', 'Schema Registry', 'High Availability'], useCases: [], technologies: ['Avro'] }),
    resolved({ id: 'multiplayer-gaming', categoriesRaw: ['Schema Registry'], useCases: ['Schema management', 'Stream processing'], technologies: ['Redpanda Connect', 'Protobuf', 'Postgres'] }),
    resolved({ id: 'sports-data-fanout', categoriesRaw: ['Schema Registry'], useCases: ['Schema management'], technologies: ['Redpanda Connect', 'Avro', 'Postgres'] }),
  ]
  const run = (docs, { solutions = catalog(), minScore } = {}) => relationships.computeRelatedSolutions({
    docs, solutions, relationships: [], categoryMap, taxonomy, ...(minScore === undefined ? {} : { minScore }),
  })
  const edgeTo = (edges, solution) => edges.find((e) => e.solution === solution)

  test('the rarity constants are named: full weight up to a third of the solutions, common above half, off below four', () => {
    expect(relationships.RARITY_FULL_SHARE).toBeCloseTo(1 / 3)
    expect(relationships.RARITY_COMMON_SHARE).toBe(0.5)
    expect(relationships.RARITY_MIN_SOLUTIONS).toBe(4)
  })

  test('the rarity factor is a normalized IDF: 1 up to a third of the solutions, 0 on all of them', () => {
    expect([1, 2, 3, 4, 5, 6].map((df) => relationships.rarityFactor(df, 6))).toEqual([1, 1, 0.66, 0.397, 0.182, 0])
    expect([1, 2, 3, 4, 5, 6].map((df) => relationships.isCommonConcept(df, 6))).toEqual([false, false, false, true, true, true])
    // Too few solutions to tell what is common: everything counts in full.
    expect(relationships.rarityFactor(3, 3)).toBe(1)
    expect(relationships.isCommonConcept(3, 3)).toBe(false)
  })

  test('conceptRarity counts each solution once per concept, implied concepts included', () => {
    const rarity = relationships.conceptRarity(catalog())
    expect(rarity.total).toBe(6)
    expect(rarity.df.get('schema-registry')).toBe(4)
    expect(rarity.df.get('redpanda-connect')).toBe(4)
    expect(rarity.df.get('avro')).toBe(3)
    expect(rarity.df.get('schema-management')).toBe(2)
    expect(rarity.df.get('iceberg-topics')).toBe(1)
    expect(rarity.df.get('apache-iceberg')).toBe(1)
    expect(rarity.factor('schema-registry')).toBe(0.397)
    expect(rarity.factor('iceberg-topics')).toBe(1)
    expect(rarity.common('redpanda-connect')).toBe(true)
  })

  test('Specify an Iceberg schema: Schema Registry on most solutions no longer carries the gaming and fan-out solutions over min_score', () => {
    const d = doc('streaming:manage:iceberg/specify-iceberg-schema.adoc', ['Iceberg Topics', 'Schema Registry', 'Schema management', 'Avro', 'Protobuf'])
    const { edges, related } = run([d])
    // Without rarity, each scored 0.2 + 0.3 + 0.1 = 0.6 and showed.
    expect(edgeTo(edges, 'multiplayer-gaming')).toMatchObject({
      score: 0.479,
      shown: false,
      shared: { leaves: ['schema-registry', 'schema-management', 'protobuf'], strong: ['schema-management'], rarity: { 'schema-registry': 0.397, 'schema-management': 1, protobuf: 1 } },
    })
    expect(edgeTo(edges, 'sports-data-fanout')).toMatchObject({
      score: 0.445,
      shown: false,
      shared: { leaves: ['schema-registry', 'schema-management', 'avro'], rarity: { 'schema-registry': 0.397, avro: 0.66 } },
    })
    expect(edgeTo(edges, 'multiplayer-gaming').reason).toMatch(/hidden: score 0.479 below 0.6/)
    expect(related.size).toBe(0)
  })

  test('a rare shared concept counts in full: migrate-to-iceberg-topics still recommends cdc-to-lakehouse', () => {
    const d = doc('streaming:manage:iceberg/migrate-to-iceberg-topics.adoc', ['Iceberg Topics', 'Schema Registry', 'Data lakehouse'])
    const { edges } = run([d])
    expect(edgeTo(edges, 'cdc-to-lakehouse')).toMatchObject({
      score: 0.6,
      shown: true,
      rank: 1,
      shared: { leaves: ['iceberg-topics', 'data-lakehouse'], broader: ['apache-iceberg'], rarity: { 'iceberg-topics': 1, 'data-lakehouse': 1, 'apache-iceberg': 1 } },
    })
  })

  test('a rare topic outranks a common one with the same kind of overlap', () => {
    const rare = doc('rare', ['Tiered Storage', 'Change data capture'])
    const common = doc('common', ['Schema Registry', 'Schema management'])
    const { edges } = run([rare, common], { minScore: 0.3 })
    // Without rarity, both are a topic and a use case: 0.5 each.
    expect(edges.find((e) => e.doc === 'rare' && e.solution === 'cdc-to-lakehouse').score).toBe(0.5)
    expect(edges.find((e) => e.doc === 'common' && e.solution === 'multiplayer-gaming').score).toBe(0.379)
  })

  test('a strong concept on most solutions still scores but does not count as strong', () => {
    const d = doc('connect-tiered', ['Redpanda Connect', 'Tiered Storage'])
    const e = edgeTo(run([d], { minScore: 0.3 }).edges, 'cdc-to-lakehouse')
    expect(e).toMatchObject({ score: 0.319, shown: false, shared: { leaves: ['redpanda-connect', 'tiered-storage'], strong: [] } })
    expect(e.reason).toMatch(/hidden: no shared use case or technology that few solutions carry \(Redpanda Connect is on most solutions\)/)
  })

  test('with fewer than RARITY_MIN_SOLUTIONS solutions, rarity is off and edges carry no rarity', () => {
    const d = doc('streaming:manage:iceberg/specify-iceberg-schema.adoc', ['Iceberg Topics', 'Schema Registry', 'Schema management', 'Avro', 'Protobuf'])
    const [, , , , gaming, sports] = catalog()
    const { edges } = run([d], { solutions: [gaming, sports] })
    expect(edgeTo(edges, 'multiplayer-gaming')).toMatchObject({ score: 0.6, shown: true })
    expect(edgeTo(edges, 'multiplayer-gaming').shared).not.toHaveProperty('rarity')
  })
})

describe('doc-concepts.json: the scoring inputs, published for recommendations-diff', () => {
  const recsIndex = require('../../extensions/solutions-catalog/recs-index')
  const solutions = () => {
    const list = [
      resolved({ id: 'cdc-to-lakehouse', categoriesRaw: ['Iceberg', 'Tiered Storage'], useCases: ['Change data capture', 'Data lakehouse'], technologies: ['Redpanda Connect', 'Apache Iceberg', 'Postgres'], relatedDocKeys: new Set(['streaming:manage:tiered.adoc']) }),
      resolved({ id: 'disaster-recovery', categoriesRaw: ['Data Replication', 'High Availability'], useCases: ['Disaster recovery'], technologies: ['rpk'], featured: true }),
      resolved({ id: 'kafka-migration', categoriesRaw: ['Security', 'Schema Registry'], useCases: [], technologies: ['Redpanda Connect', 'Avro'] }),
      resolved({ id: 'multiplayer-gaming', categoriesRaw: ['Schema Registry'], useCases: ['Schema management', 'Stream processing'], technologies: ['Redpanda Connect', 'Protobuf', 'Postgres'], platforms: ['kubernetes'] }),
      resolved({ id: 'sports-data-fanout', categoriesRaw: ['Schema Registry'], useCases: ['Schema management'], technologies: ['Redpanda Connect', 'Avro', 'Postgres'], status: 'draft', draft: true }),
    ]
    list[0].relatedDocTwins = new Map([['cloud:manage:tiered.adoc', 'streaming:manage:tiered.adoc']])
    list[0].relatedDocKeys.add('cloud:manage:tiered.adoc')
    return list
  }
  const docs = [
    doc('streaming:manage:tiered.adoc', ['Tiered Storage']),
    doc('cloud:manage:tiered.adoc', ['Tiered Storage'], 'Redpanda Cloud'),
    doc('streaming:manage:iceberg/specify-iceberg-schema.adoc', ['Iceberg Topics', 'Schema Registry', 'Schema management', 'Avro', 'Protobuf']),
    doc('streaming:manage:dr.adoc', ['Data Replication', 'Disaster Recovery', 'rpk']),
    doc('streaming:develop:cdc.adoc', ['Change data capture', 'PostgreSQL', 'Redpanda Connect'], 'Kubernetes'),
    doc('streaming:develop:gaming.adoc', ['Stream processing', 'Schema management', 'Protobuf']),
  ].map((d) => ({ ...d, title: d.key }))
  const rels = [
    { solutionId: 'kafka-migration', docKey: 'streaming:manage:dr.adoc', status: 'approved', confidence: 0.95, reason: 'Migrate, then fail over' },
    { solutionId: 'multiplayer-gaming', docKey: 'streaming:develop:gaming.adoc', status: 'rejected', confidence: null, reason: 'Not a gaming page' },
  ]
  const settings = { maxRelated: 2, minScore: 0.6 }
  const score = (input) => relationships.computeRelatedSolutions({ ...input, taxonomy, categoryMap: null, maxRelated: input.settings.maxRelated, minScore: input.settings.minScore })

  test('scoring the published index gives the edges the build computed', () => {
    const built = score({ docs, solutions: solutions(), relationships: rels, settings })
    const json = JSON.parse(JSON.stringify(recsIndex.buildDocConceptsIndex({ docs, solutions: solutions(), relationships: rels, settings, siteUrl: 'https://docs.redpanda.com', generatedAt: 'now' })))
    const read = recsIndex.readDocConceptsIndex(json)
    const again = score(read)
    const shape = (edges) => edges.map(({ doc, solution, provenance, score, shown, rank, reason, shared }) => ({ doc, solution, provenance, score, shown, rank, reason, shared }))
    expect(shape(again.edges)).toEqual(shape(built.edges))
    // The fixture exercises what the index must carry: rarity (5 solutions),
    // an explicit edge and its Cloud twin, an approved and a rejected
    // relationship, a draft, the platform filter, and max_related.
    const provenances = new Set(built.edges.map((e) => e.provenance))
    expect([...provenances].sort()).toEqual(['category', 'editor-approved', 'explicit', 'rejected'])
    expect(built.edges.some((e) => e.shared && e.shared.rarity)).toBe(true)
    expect(built.edges.some((e) => /hidden: Kubernetes page/.test(e.reason) || /hidden: rank 3 exceeds max_related 2/.test(e.reason))).toBe(true)
  })

  test('the index is plain JSON, with each concept set in the order the build derived it', () => {
    const json = recsIndex.buildDocConceptsIndex({ docs, solutions: solutions(), relationships: rels, settings, generatedAt: 'now' })
    expect(json).toMatchObject({ version: 1, settings: { maxRelated: 2, minScore: 0.6 } })
    expect(json.docs.find((d) => d.id === 'streaming:manage:tiered.adoc')).toEqual({ id: 'streaming:manage:tiered.adoc', title: 'streaming:manage:tiered.adoc', url: '/streaming:manage:tiered.adoc/', deployment: '', concepts: { 'tiered-storage': 'direct' } })
    const cdc = json.solutions.find((x) => x.id === 'cdc-to-lakehouse')
    expect(cdc).toMatchObject({ relatedDocs: ['cloud:manage:tiered.adoc', 'streaming:manage:tiered.adoc'], relatedDocTwins: { 'cloud:manage:tiered.adoc': 'streaming:manage:tiered.adoc' }, platformIds: ['docker'] })
    expect(cdc.concepts).toEqual({ 'iceberg-topics': 'direct', 'tiered-storage': 'direct', 'apache-iceberg': 'direct', 'change-data-capture': 'direct', 'data-lakehouse': 'direct', 'redpanda-connect': 'direct', postgresql: 'direct' })
    const dr = json.docs.find((d) => d.id === 'streaming:manage:dr.adoc')
    expect(dr.concepts['high-availability']).toBe('implied')
    expect(() => recsIndex.readDocConceptsIndex({ docs: [] })).toThrow(/no docs and solutions lists/)
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
  // The doc shares a use case with the solution, so only the platform decides.
  const shown = (solution, deployment) => relationships.computeRelatedSolutions({
    docs: [doc('d', ['Iceberg', 'Tiered Storage', 'Change data capture'], deployment)],
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
      docs: [doc('a', ['Iceberg', 'Tiered Storage', 'Change data capture'], 'Mainframe'), doc('b', ['Iceberg', 'Tiered Storage', 'Change data capture'], 'Mainframe')],
      solutions: [resolved()],
      relationships: [],
      categoryMap,
      taxonomy,
    })
    expect(edges.map((e) => e.shown)).toEqual([true, true])
    expect(warnings).toEqual(['the taxonomy has no deployment concept for Mainframe pages; their category recommendations are not filtered by platform'])
  })
})
