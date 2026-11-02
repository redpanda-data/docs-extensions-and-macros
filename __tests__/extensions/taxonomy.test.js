'use strict'

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const {
  parseTaxonomy,
  loadTaxonomy,
  getTaxonomy,
  pageFacets,
  authoredCategories,
  TaxonomyError,
} = require('../../extension-utils/taxonomy')

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'taxonomy')
const TEXT = fs.readFileSync(path.join(FIXTURES, 'taxonomy.yml'), 'utf8')
const SCHEMA = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'taxonomy.schema.json'), 'utf8'))

function load () {
  return parseTaxonomy(TEXT, { schema: SCHEMA })
}

/** The fixture with one change applied to its parsed data. */
function variant (mutate) {
  const data = yaml.load(TEXT)
  mutate(data)
  return yaml.dump(data)
}

const scheme = (data, id) => data.schemes.find((s) => s.id === id)
const concept = (data, id) => data.schemes.flatMap((s) => s.concepts).find((c) => c.id === id)

function recordingLogger () {
  const lines = { info: [], warn: [], debug: [], error: [] }
  return {
    lines,
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    debug: (m) => lines.debug.push(m),
    error: (m) => lines.error.push(m),
  }
}

function catalogWith (files) {
  return {
    findBy: ({ component, family }) => files.filter((f) => f.src.component === component && f.src.family === family),
  }
}

function sharedAttachment (relative, contents) {
  return { src: { component: 'shared', version: '', module: 'ROOT', family: 'attachment', relative }, contents: Buffer.from(contents) }
}

describe('taxonomy loading and validation', () => {
  test('the fixture parses against the schema', () => {
    const t = load()
    expect(t.schemes.size).toBe(7)
    expect(t.get('replication')).toMatchObject({ scheme: 'topic', broader: 'high-availability' })
    expect(t.conceptIds('topic')).not.toContain('category-iceberg')
    expect(t.conceptIds('topic', { includeDeprecated: true })).toContain('category-iceberg')
  })

  test('a label repeated in another scheme fails, naming both concepts', () => {
    const text = variant((d) => concept(d, 'apache-iceberg').altLabels.push('Iceberg'))
    expect(() => parseTaxonomy(text, { schema: SCHEMA })).toThrow(TaxonomyError)
    expect(() => parseTaxonomy(text, { schema: SCHEMA })).toThrow(/label "Iceberg" of technology\/apache-iceberg duplicates the prefLabel "Iceberg" of topic\/category-iceberg/)
  })

  test('label uniqueness ignores case and whitespace', () => {
    const text = variant((d) => concept(d, 'postgresql').altLabels.push('  security '))
    expect(() => parseTaxonomy(text)).toThrow(/duplicates the prefLabel "Security"/)
  })

  test('a duplicate concept ID fails', () => {
    const text = variant((d) => scheme(d, 'industry').concepts.push({ ...concept(d, 'gambling'), prefLabel: 'Betting', altLabels: [] }))
    expect(() => parseTaxonomy(text)).toThrow(/concept ID gambling is defined more than once/)
  })

  test('dangling and cross-scheme references fail', () => {
    expect(() => parseTaxonomy(variant((d) => { concept(d, 'category-iceberg').replacedBy = ['iceberg-tables'] }))).toThrow(/replacedBy names iceberg-tables, which is not a concept/)
    expect(() => parseTaxonomy(variant((d) => { concept(d, 'replication').broader = 'operate' }))).toThrow(/broader must stay in the same scheme/)
    expect(() => parseTaxonomy(variant((d) => { concept(d, 'category-iceberg').replacedBy = ['category-data-replication'] }))).toThrow(/itself deprecated/)
  })

  test('the schema rejects a missing field, replacedBy on a live concept, and a technology without a kind', () => {
    expect(() => parseTaxonomy(variant((d) => { delete concept(d, 'security').definition }), { schema: SCHEMA })).toThrow(/must have required property 'definition'/)
    expect(() => parseTaxonomy(variant((d) => { concept(d, 'security').replacedBy = ['operate'] }), { schema: SCHEMA })).toThrow(TaxonomyError)
    expect(() => parseTaxonomy(variant((d) => { delete concept(d, 'postgresql').kind }), { schema: SCHEMA })).toThrow(/must have required property 'kind'/)
  })

  test('without the schema, the structural checks still run', () => {
    expect(() => parseTaxonomy(variant((d) => concept(d, 'apache-iceberg').altLabels.push('Iceberg')))).toThrow(TaxonomyError)
  })
})

describe('taxonomy resolution', () => {
  const t = load()

  test('resolves a prefLabel, an altLabel, and an ID to the same concept', () => {
    expect(t.resolve('PostgreSQL').ids).toEqual(['postgresql'])
    expect(t.resolve('Postgres')).toMatchObject({ ids: ['postgresql'], via: 'altLabel', deprecated: false })
    expect(t.resolve('postgresql').ids).toEqual(['postgresql'])
  })

  test('ignores case, padding, and no-break spaces', () => {
    expect(t.resolve(' high availability ').ids).toEqual(['high-availability'])
    expect(t.resolve('High Availability').ids).toEqual(['high-availability'])
  })

  test('a deprecated value resolves to its replacedBy', () => {
    expect(t.resolve('Iceberg')).toMatchObject({ deprecated: true, ids: ['iceberg-topics'] })
    expect(t.resolve('Management')).toMatchObject({ deprecated: true, ids: ['operate'] })
  })

  test('a deprecated value with no replacement resolves to nothing, but is not unknown', () => {
    expect(t.resolve('Integration')).toMatchObject({ deprecated: true, ids: [] })
    expect(t.resolve('Not a category')).toBeNull()
  })

  test('platforms: self-managed resolves to docker through its altLabel', () => {
    const opts = { schemes: ['deployment'], prefer: 'id' }
    expect(t.resolve('self-managed', opts).ids).toEqual(['docker'])
    expect(t.resolve('cloud', opts).ids).toEqual(['cloud'])
    expect(t.resolve('kubernetes', opts).ids).toEqual(['kubernetes'])
    expect(t.label('docker')).toBe('Docker Compose')
  })

  test('a scheme filter rejects a concept from another scheme', () => {
    expect(t.resolve('Security', { schemes: ['technology'] })).toBeNull()
  })

  test('expand adds broader concepts and implies targets as implied', () => {
    const out = t.expand(['replication', 'iceberg-topics'])
    expect([...out]).toEqual([
      ['replication', 'direct'],
      ['iceberg-topics', 'direct'],
      ['high-availability', 'implied'],
      ['apache-iceberg', 'implied'],
    ])
  })

  test('a concept assigned directly stays direct when something also implies it', () => {
    expect(t.expand(['iceberg-topics', 'apache-iceberg']).get('apache-iceberg')).toBe('direct')
  })

  test('legacyLabel finds the old category for a new concept', () => {
    const legacy = new Set(['Iceberg', 'Data Replication', 'Security', 'Management'])
    const isLegacy = (l) => legacy.has(l)
    expect(t.legacyLabel('iceberg-topics', isLegacy)).toBe('Iceberg')
    expect(t.legacyLabel('replication', isLegacy)).toBe('Data Replication')
    expect(t.legacyLabel('security', isLegacy)).toBe('Security')
    expect(t.legacyLabel('postgresql', isLegacy)).toBeNull()
  })

  test('technologiesForComponent maps an Antora component to its product', () => {
    expect(t.technologiesForComponent('connect')).toEqual(['redpanda-connect'])
    expect(t.technologiesForComponent('streaming')).toEqual([])
  })
})

describe('taxonomy loader', () => {
  test('reads taxonomy.yml and its schema from the shared component attachments', () => {
    const logger = recordingLogger()
    const catalog = catalogWith([
      sharedAttachment('taxonomy.yml', TEXT),
      sharedAttachment('taxonomy.schema.json', JSON.stringify(SCHEMA)),
    ])
    const t = loadTaxonomy(catalog, { logger })
    expect(t.get('docker')).toBeDefined()
    expect(logger.lines.warn).toEqual([])
    expect(loadTaxonomy(catalog, { logger })).toBe(t) // cached per catalog
  })

  test('an invalid file fails the build when the schema is present', () => {
    const bad = variant((d) => { delete concept(d, 'security').definition })
    const catalog = catalogWith([sharedAttachment('taxonomy.yml', bad), sharedAttachment('taxonomy.schema.json', JSON.stringify(SCHEMA))])
    expect(() => loadTaxonomy(catalog)).toThrow(TaxonomyError)
  })

  test('a missing file returns null with one warning, so the deploy order is free', () => {
    const logger = recordingLogger()
    const catalog = catalogWith([])
    expect(loadTaxonomy(catalog, { logger })).toBeNull()
    expect(loadTaxonomy(catalog, { logger })).toBeNull()
    expect(logger.lines.warn).toHaveLength(1)
    expect(logger.lines.warn[0]).toMatch(/taxonomy\.yml not found/)
  })

  test('a missing schema warns and runs the structural checks only', () => {
    const logger = recordingLogger()
    expect(loadTaxonomy(catalogWith([sharedAttachment('taxonomy.yml', TEXT)]), { logger })).not.toBeNull()
    expect(logger.lines.warn[0]).toMatch(/taxonomy\.schema\.json not found/)
  })

  test('a taxonomy.yml in another component or module is ignored', () => {
    const elsewhere = { ...sharedAttachment('taxonomy.yml', TEXT), src: { component: 'shared', module: 'other', family: 'attachment', relative: 'taxonomy.yml' } }
    expect(loadTaxonomy(catalogWith([elsewhere]))).toBeNull()
  })

  test('getTaxonomy shares one instance on siteCatalog.taxonomy', () => {
    const catalog = catalogWith([sharedAttachment('taxonomy.yml', TEXT)])
    const siteCatalog = {}
    const t = getTaxonomy({ contentCatalog: catalog, siteCatalog })
    expect(siteCatalog.taxonomy).toBe(t)
    expect(getTaxonomy({ contentCatalog: catalogWith([]), siteCatalog })).toBe(t)
  })
})

describe('pageFacets', () => {
  const t = load()

  test('resolves legacy categories, the deployment type, and the component', () => {
    const facets = pageFacets(t, { categories: ['Iceberg', 'Data Replication', 'Management', 'Integration'], deployment: 'Docker', component: 'connect' })
    expect(facets.topicIds).toEqual(['iceberg-topics', 'replication', 'high-availability'])
    expect(facets.topics).toEqual(['Iceberg Topics', 'Replication', 'High Availability'])
    expect(facets.technologyIds).toEqual(['apache-iceberg', 'redpanda-connect'])
    expect(facets.deploymentIds).toEqual(['docker', 'redpanda-self-managed'])
    expect(facets.deployment).toEqual(['Docker Compose', 'Redpanda Self-Managed'])
    expect(facets.useCaseIds).toEqual([])
  })

  test('a Cloud page gets the cloud deployment', () => {
    expect(pageFacets(t, { deployment: 'Redpanda Cloud' }).deploymentIds).toEqual(['cloud'])
  })
})

describe('authoredCategories', () => {
  test('prefers what the author wrote over the rewritten legacy list', () => {
    expect(authoredCategories({ 'page-categories': 'Iceberg, Deployment', 'page-categories-authored': 'Iceberg' })).toEqual(['Iceberg'])
    expect(authoredCategories({ 'page-categories': 'Security, ' })).toEqual(['Security'])
    expect(authoredCategories(undefined)).toEqual([])
  })
})
