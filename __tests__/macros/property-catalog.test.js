'use strict'

jest.mock('@antora/logger', () => {
  const logger = { warn: jest.fn(), info: () => {}, error: jest.fn(), debug: () => {} }
  const getLogger = () => logger
  getLogger.configure = () => getLogger
  return getLogger
})

const fs = require('fs')
const path = require('path')
const asciidoctor = require('@asciidoctor/core')()
const catalog = require('../../macros/property-catalog')
const { propertyPageFor } = require('../../tools/property-extractor/property-page')
const { extractHeadingsWithTags } = require('../../macros/prop')

const FIXTURES = path.join(__dirname, '..', 'e2e', 'property-catalog', 'fixtures', 'reference')
const DATA = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'attachments', 'redpanda-properties-v26.2.6.json'), 'utf8')).properties

describe('enterpriseInfo follows the reference templates', () => {
  test('restricted values of an is_enterprise property', () => {
    expect(catalog.enterpriseInfo(DATA.cloud_storage_enabled)).toEqual({ kind: 'values', values: ['true'], sanctioned: [] })
  })
  test('enum values marked in x-enum-metadata, even without is_enterprise', () => {
    expect(DATA.sasl_mechanism.is_enterprise).toBe(false)
    expect(catalog.enterpriseInfo(DATA.sasl_mechanism).values).toEqual(['OAUTHBEARER'])
  })
  test('items enum metadata for array properties', () => {
    expect(catalog.enterpriseInfo({ items: { 'x-enum-metadata': { OIDC: { is_enterprise: true }, BASIC: { is_enterprise: false } } } }).values).toEqual(['OIDC'])
  })
  test('the license-free default of restricted_with_sanctioned', () => {
    const info = catalog.enterpriseInfo(DATA.partition_autobalancing_mode)
    expect(info).toEqual({ kind: 'values', values: ['continuous'], sanctioned: ['node_add'] })
    expect(catalog.enterpriseValuesTooltip(info)).toBe('The value continuous requires an Enterprise Edition license. Without a license, the default is node_add.')
  })
  test('the simple constructor names no values', () => {
    const info = catalog.enterpriseInfo(DATA.default_leaders_preference)
    expect(info.kind).toBe('values')
    expect(catalog.enterpriseValuesTooltip(info)).toBe('Some values of this property require an Enterprise Edition license.')
  })
  test('enterprise_value without a constructor; whole-property Enterprise; none', () => {
    expect(catalog.enterpriseInfo({ is_enterprise: true, enterprise_value: ['a', 'b'] }).values).toEqual(['a', 'b'])
    expect(catalog.enterpriseInfo({ is_enterprise: true }).kind).toBe('enterprise')
    expect(catalog.enterpriseInfo(DATA.retention_bytes)).toBeNull()
  })
  test('lists more than one value with "or"', () => {
    expect(catalog.enterpriseValuesTooltip({ values: ['GSSAPI', 'OAUTHBEARER'], sanctioned: [] })).toBe('The values GSSAPI or OAUTHBEARER require an Enterprise Edition license.')
  })
})

describe('plain-text summaries', () => {
  test('strip AsciiDoc to the words a reader sees', () => {
    const text = catalog.plainText('See xref:manage:tiered-storage.adoc[Tiered Storage], prop:log_segment_ms[], `code`, **bold**, <<anchor,here>>, glossterm:broker[brokers], link:https://x.io[site], and {ui}.', (name) => (name === 'ui' ? 'Console' : undefined))
    expect(text).toBe('See Tiered Storage, log_segment_ms, code, bold, here, brokers, site, and Console.')
  })
  test('drop include directives and admonition labels', () => {
    expect(catalog.plainText('include::reference:partial$internal-use-property.adoc[]\nNOTE: Do it.').trim()).toBe('Do it.')
  })
  test('take the first sentence of the first paragraph', () => {
    expect(catalog.summarize('First one, e.g. this. Second.\n\nOther paragraph.')).toBe('First one, e.g. this.')
  })
  test('cut long sentences near 200 characters at a word boundary', () => {
    const summary = catalog.summarize(`${'word '.repeat(80)}end.`)
    expect(summary.length).toBeLessThanOrEqual(201)
    expect(summary.endsWith('…')).toBe(true)
    expect(summary).not.toMatch(/\s…$/)
  })
  test('no summary in the real data shows raw markup', () => {
    const raw = Object.values(DATA).map((e) => catalog.summarize(e.description)).filter((s) => /xref:|`|\*\*|include::|<<|\{[a-z-]+\}/.test(s))
    expect(raw).toEqual([])
  })
})

describe('setCommand', () => {
  test('cluster, topic, and broker commands', () => {
    expect(catalog.setCommand(DATA.retention_bytes)).toBe('rpk cluster config set retention_bytes <value>')
    expect(catalog.setCommand(DATA['cleanup.policy'])).toBe('rpk topic alter-config <topic> --set cleanup.policy=<value>')
    expect(catalog.setCommand(DATA.kafka_api)).toBe('rpk redpanda config set redpanda.kafka_api <value>')
    expect(catalog.setCommand(DATA.brokers)).toBe('rpk redpanda config set pandaproxy_client.brokers <value>')
    expect(catalog.setCommand(DATA.schema_registry_api)).toBe('rpk redpanda config set schema_registry.schema_registry_api <value>')
  })
  test('none for a broker property outside the known sections, or a Cloud property Cloud manages', () => {
    expect(catalog.setCommand(DATA.dashboard_dir)).toBeUndefined()
    expect(catalog.setCommand({ name: 'x', config_scope: 'cluster', cloud_editable: false }, { cloud: true })).toBeUndefined()
    expect(catalog.setCommand({ name: 'x', config_scope: 'broker', category: 'redpanda' }, { cloud: true })).toBeUndefined()
  })
})

describe('which properties are listed', () => {
  test('self-managed: all but exclude_from_docs', () => {
    expect(catalog.isListed(DATA['redpanda.virtual.cluster.id'])).toBe(false)
    expect(catalog.isListed(DATA.dashboard_dir)).toBe(true)
  })
  test('Cloud: cloud_supported cluster properties and topic properties, no broker ones', () => {
    expect(catalog.isListed(DATA.iceberg_enabled, { cloud: true })).toBe(true)
    expect(catalog.isListed(DATA.abort_index_segment_size, { cloud: true })).toBe(false)
    expect(catalog.isListed(DATA['cleanup.policy'], { cloud: true })).toBe(true)
    expect(catalog.isListed(DATA.kafka_api, { cloud: true })).toBe(false)
  })
})

describe('cards', () => {
  const cards = Object.values(DATA).filter((e) => catalog.isListed(e)).map((e) => catalog.cardModel(e))

  test('every card is grouped on the page the generator writes it to', () => {
    // From the generated partials themselves: which partial carries each heading
    const pageOf = {}
    for (const page of ['cluster', 'object-storage', 'broker', 'topic']) {
      const source = fs.readFileSync(path.join(FIXTURES, 'partials', 'properties', `${page}-properties.adoc`), 'utf8')
      for (const { name } of extractHeadingsWithTags(source)) if (DATA[name]) pageOf[name] = page
    }
    const checked = cards.filter((c) => pageOf[c.name])
    expect(checked.length).toBe(cards.length)
    expect(checked.filter((c) => c.group !== pageOf[c.name]).map((c) => c.name)).toEqual([])
    expect(cards.every((c) => c.group === propertyPageFor(DATA[c.name]))).toBe(true)
  })

  test('sections are the topic and broker pages\' category tags', () => {
    const byName = Object.fromEntries(cards.map((c) => [c.name, c]))
    expect(byName['retention.ms'].section).toBe('topic:retention-compaction')
    expect(byName.kafka_api.section).toBe('broker:redpanda')
    expect(byName.retention_bytes.section).toBe('')
    expect(catalog.sectionLabel('topic:tiered-storage')).toBe('Topic: Tiered Storage')
    expect(catalog.sectionLabel('broker:pandaproxy-client', { withGroup: false })).toBe('HTTP Proxy client')
  })

  test('badges follow the meaning-system contract', () => {
    const html = cards.map(catalog.cardHtml).join('')
    const badges = html.match(/<span class="rp-badge[^>]*>/g)
    expect(badges.length).toBeGreaterThan(cards.length)
    for (const badge of badges) {
      expect(badge).toMatch(/^<span class="rp-badge rp-badge--sm rp-badge--(neutral|enterprise|deprecated|cloud)" data-tooltip="[^"]+">$/)
      expect(badge).not.toMatch(/\btitle=/)
    }
  })

  test('a card has the signature, summary, default, link, and command', () => {
    const card = catalog.cardModel(DATA.retention_bytes, { href: '../reference/properties/cluster-properties/#retention_bytes' })
    const html = catalog.cardHtml(card)
    expect(html).toContain('<code class="prop-card-name">retention_bytes</code>: <code class="prop-card-type">integer</code>')
    expect(html).toContain('<code>null</code>')
    expect(html).toContain('href="../reference/properties/cluster-properties/#retention_bytes"')
    expect(html).toContain('rpk cluster config set retention_bytes &lt;value&gt;')
    expect(html).toContain('<span class="copy-toast">Copied!</span>')
  })

  test('deprecated cards start hidden; Cloud cards have Cloud badges and no default or Enterprise', () => {
    expect(catalog.cardHtml(catalog.cardModel(DATA.dashboard_dir))).toMatch(/^<li class="prop-card"[^>]* hidden>/)
    const cloud = catalog.cardModel(DATA.cloud_storage_enabled, { cloud: true })
    expect(cloud.defaultValue).toBeUndefined()
    expect(cloud.badges.map((b) => b.label)).not.toContain('Enterprise values')
    const byoc = Object.values(DATA).find((e) => e.cloud_byoc_only === true)
    expect(catalog.cardModel(byoc, { cloud: true }).badges.map((b) => `${b.meaning}:${b.label}`)).toContain('cloud:BYOC only')
  })
})

describe('filters', () => {
  const cards = Object.values(DATA).filter((e) => catalog.isListed(e)).map((e) => catalog.cardModel(e))

  test('the catalog offers Group, Section, Type, Restart, Enterprise, Deprecated', () => {
    expect(catalog.filterSpecs(cards).map((s) => s.label)).toEqual(['Group', 'Section', 'Type', 'Restart required', 'Enterprise', 'Deprecated'])
    const deprecated = catalog.filterSpecs(cards).find((s) => s.key === 'deprecated')
    expect(deprecated.options).toEqual([{ value: 'no', label: 'Not deprecated' }, { value: 'yes', label: 'Deprecated', off: true }])
  })

  test('no option matches nothing, and no filter has a single option', () => {
    const visible = cards.filter((c) => c.deprecated === 'no')
    for (const spec of catalog.filterSpecs(cards)) {
      expect(spec.options.length).toBeGreaterThanOrEqual(2)
      if (spec.key === 'deprecated') continue
      for (const option of spec.options) expect(visible.some((c) => c[spec.key] === option.value)).toBe(true)
    }
    // broker:other holds only deprecated properties
    expect(catalog.filterSpecs(cards).find((s) => s.key === 'section').options.map((o) => o.value)).not.toContain('broker:other')
  })

  test('a reference page offers only what divides its entries', () => {
    const topic = cards.filter((c) => c.group === 'topic' && c.deprecated === 'no')
    expect(catalog.filterSpecs(topic, { mode: 'filter' }).map((s) => s.label)).toEqual(['Section'])
    expect(catalog.filterSpecs(topic, { mode: 'filter' })[0].options.find((o) => o.value === 'topic:tiered-storage').label).toBe('Tiered Storage')
    const broker = cards.filter((c) => c.group === 'broker' && c.deprecated === 'no')
    expect(catalog.filterSpecs(broker, { mode: 'filter' }).map((s) => s.label)).toEqual(['Enterprise'])
    const cluster = cards.filter((c) => c.group === 'cluster' && c.deprecated === 'no')
    expect(catalog.filterSpecs(cluster, { mode: 'filter' }).map((s) => s.label)).toEqual(['Restart required', 'Enterprise'])
  })

  test('Cloud adds Cloud editable and BYOC only and drops Enterprise', () => {
    const cloud = Object.values(DATA).filter((e) => catalog.isListed(e, { cloud: true })).map((e) => catalog.cardModel(e, { cloud: true }))
    const labels = catalog.filterSpecs(cloud, { cloud: true }).map((s) => s.label)
    expect(labels).toEqual(expect.arrayContaining(['Cloud editable', 'BYOC only']))
    expect(labels).not.toContain('Enterprise')
    expect(catalog.filterSpecs(cloud, { cloud: true }).find((s) => s.key === 'cloudEditable').param).toBe('editable')
  })

  test('matchesCard needs every search word and a checked value for each narrowed filter', () => {
    const record = { search: 'retention_bytes default maximum bytes', group: 'cluster', restart: 'no' }
    expect(catalog.matchesCard(record, ['retention', 'maximum'], [])).toBe(true)
    expect(catalog.matchesCard(record, ['retention', 'zzz'], [])).toBe(false)
    expect(catalog.matchesCard(record, [], [{ key: 'group', checked: { topic: true }, all: false }])).toBe(false)
    expect(catalog.matchesCard(record, [], [{ key: 'group', checked: { cluster: true }, all: false }])).toBe(true)
    expect(catalog.matchesCard(record, [], [{ key: 'group', checked: {}, all: true }])).toBe(true)
  })

  test('status text', () => {
    expect(catalog.catalogStatusText({ shown: 674, search: '', filtered: false, deprecatedHidden: true })).toBe('Showing 674 properties. Deprecated properties are hidden.')
    expect(catalog.catalogStatusText({ shown: 36, search: 'retention', filtered: false })).toBe('36 properties match "retention".')
    expect(catalog.catalogStatusText({ shown: 1, search: 'x', filtered: true })).toBe('1 property matches "x" and these filters.')
    expect(catalog.catalogStatusText({ shown: 0, search: '', filtered: true })).toBe('No properties match these filters.')
  })
})

describe('markup', () => {
  const cards = Object.values(DATA).filter((e) => catalog.isListed(e)).map((e) => catalog.cardModel(e))

  test('the catalog has one status region, an empty state, the search index, and disclosure filters', () => {
    const html = catalog.catalogHtml(cards)
    expect(html.match(/role="status"/g)).toHaveLength(1)
    expect(html).toContain('<div class="prop-catalog-empty" hidden>')
    expect(html).toContain('<button type="button" class="prop-catalog-clear">Clear filters</button>')
    expect(html).not.toMatch(/aria-haspopup|role="menu"/)
    expect(html).toMatch(/aria-expanded="false" aria-controls="property-catalog-group-menu"/)
    expect(html.match(/<li class="prop-card"/g)).toHaveLength(cards.length)
    const index = html.match(/<script type="application\/json" class="prop-catalog-index">([\s\S]*?)<\/script>/)[1]
    expect(JSON.parse(index)).toHaveLength(cards.length)
    expect(index).not.toContain('</')
  })

  test('the filter bar carries rows keyed by anchor and no cards', () => {
    const topic = cards.filter((c) => c.group === 'topic').map((c) => ({ ...c, anchor: c.name.replace(/\./g, '-') }))
    const html = catalog.filterBarHtml(topic)
    expect(html).toContain('data-mode="filter"')
    expect(html).not.toContain('<li class="prop-card"')
    const rows = JSON.parse(html.match(/class="prop-catalog-index">([\s\S]*?)<\/script>/)[1])
    expect(rows.find((r) => r[0] === 'retention-ms')).toEqual(['retention-ms', 'no', 'none', 'no', 'topic:retention-compaction', undefined, undefined].map((v) => (v === undefined ? null : v)))
  })

  test('relativeUrl matches Antora\'s xref paths', () => {
    expect(catalog.relativeUrl('/streaming/current/reference/properties/all-properties/', '/streaming/current/reference/properties/cluster-properties/', '#x')).toBe('../cluster-properties/#x')
    expect(catalog.relativeUrl('/a/b/', '/a/b/', '#x')).toBe('#x')
  })
})

describe('the block macro', () => {
  const json = fs.readFileSync(path.join(FIXTURES, 'attachments', 'redpanda-properties-v26.2.6.json'))
  const partial = (name) => fs.readFileSync(path.join(FIXTURES, 'partials', 'properties', `${name}-properties.adoc`))
  const pageSource = (name) => fs.readFileSync(path.join(FIXTURES, 'pages', 'properties', `${name}-properties.adoc`))
  const version = '26.2'
  const file = (family, relative, contents, extra = {}) => ({ src: { component: 'streaming', version, module: 'reference', family, relative }, contents, ...extra })
  const files = [
    file('attachment', 'redpanda-properties-v26.2.6.json', json),
    ...['cluster', 'broker', 'topic', 'object-storage'].flatMap((name) => [
      file('partial', `properties/${name}-properties.adoc`, partial(name)),
      file('page', `properties/${name}-properties.adoc`, pageSource(name), { pub: { url: `/streaming/reference/properties/${name}-properties/` } }),
    ]),
  ]
  const contentCatalog = {
    findBy: (query) => files.filter((f) => Object.entries(query).every(([k, v]) => f.src[k] === v)),
    getComponent: (name) => (name === 'streaming' ? { name, latest: { version }, versions: [{ version, asciidoc: { attributes: {} } }] } : undefined),
  }
  const convert = (source, relative) => {
    const registry = asciidoctor.Extensions.create()
    catalog.register(registry, { contentCatalog, file: { src: { component: 'streaming', version, module: 'reference', relative, path: `modules/reference/pages/${relative}` }, pub: { url: `/streaming/reference/${relative.replace(/\.adoc$/, '/')}` } } })
    return asciidoctor.convert(source, { extension_registry: registry, safe: 'safe' })
  }

  test('renders the catalog from the page\'s own release, with links through the page index', () => {
    const html = convert('property_catalog::[]', 'properties/all-properties.adoc')
    expect(html).toContain('data-dataset="redpanda-properties-v26.2.6.json"')
    expect(html).toContain('href="../cluster-properties/#retention_bytes"')
    expect(html).toContain('href="../topic-properties/#retention-ms"')
    expect(html).toContain('href="../object-storage-properties/#cloud_storage_cache_size"')
  })

  test('mode=filter renders a bar for the entries the page renders', () => {
    const html = convert('property_catalog::[mode=filter]', 'properties/topic-properties.adoc')
    const rows = JSON.parse(html.match(/class="prop-catalog-index">([\s\S]*?)<\/script>/)[1])
    expect(rows.length).toBe(Object.values(DATA).filter((e) => e.config_scope === 'topic' && !e.is_deprecated && !e.exclude_from_docs).length)
    expect(rows.every((r) => r[4].startsWith('topic:'))).toBe(true)
  })

  test('a page with no entries gets no bar and a warning', () => {
    expect(convert('property_catalog::[mode=filter]', 'properties/index.adoc')).not.toContain('prop-catalog')
  })
})
