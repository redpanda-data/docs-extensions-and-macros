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

  test('a badge carries its tooltip as visually hidden text, and the label in its own span', () => {
    const html = catalog.cardHtml(catalog.cardModel(DATA.cloud_storage_enabled))
    expect(html).toContain('<span class="prop-badge-label">Restart required</span><span class="prop-catalog-visually-hidden">. A change takes effect only after a restart.</span></span>')
  })

  test('a heading without a link is named with the exact name', () => {
    expect(catalog.cardHtml(catalog.cardModel(DATA.dashboard_dir))).toContain('<h2 class="prop-card-sig" aria-label="dashboard_dir: object">')
  })

  test('badges follow the meaning-system contract', () => {
    const html = cards.map(catalog.cardHtml).join('')
    const badges = html.match(/<span class="rp-badge[^>]*>/g)
    expect(badges.length).toBeGreaterThan(cards.length)
    for (const badge of badges) {
      expect(badge).toMatch(/^<span class="rp-badge rp-badge--sm rp-badge--(neutral|enterprise|deprecated|cloud)(?: prop-badge--restart| prop-badge--scope" style="--ico:var\(--prop-icon-[a-z-]+\))?" data-tooltip="[^"]+">$/)
      expect(badge).not.toMatch(/\btitle=/)
    }
  })

  test('a card has the signature, summary, default, link, and command', () => {
    const card = catalog.cardModel(DATA.retention_bytes, { href: '../reference/properties/cluster-properties/#retention_bytes' })
    const html = catalog.cardHtml(card)
    expect(html).toContain('<h2 class="prop-card-sig"><a class="prop-card-link" href="../reference/properties/cluster-properties/#retention_bytes" aria-label="retention_bytes"><code class="prop-card-name">retention_<wbr>bytes</code></a><span class="prop-card-colon">: </span><code class="prop-card-type">integer</code></h2>')
    expect(html).toContain('<span class="prop-card-fact-label">Default</span> <code>null</code>')
    expect(html).toContain('<span class="prop-cmd-bin">rpk cluster config set</span> <span class="prop-cmd-name">retention_<wbr>bytes</span> <span class="prop-cmd-ph">&lt;value&gt;</span>')
    expect(html).toContain('<span class="copy-toast">Copied!</span>')
    expect(html).not.toMatch(/Full reference|prop-card-actions/)
  })

  // The text a reader, the copy button, and the Markdown export see
  const textOf = (html, cls) => {
    const m = html.match(new RegExp(`<(\\w+) class="${cls}"[^>]*>`))
    if (!m) return undefined
    // The element's inner HTML, up to its matching close tag
    let depth = 0
    const re = new RegExp(`<(/?)${m[1]}\\b[^>]*>`, 'g')
    re.lastIndex = m.index
    let end
    for (let t; (t = re.exec(html));) { depth += t[1] ? -1 : 1; if (!depth) { end = t.index; break } }
    return html.slice(m.index + m[0].length, end).replace(/<wbr>/g, '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  }

  test('the signature reads "name: type", and <wbr> adds no text', () => {
    for (const name of ['retention_bytes', 'retention.ms', 'cloud_storage_cache_size']) {
      const html = catalog.cardHtml(catalog.cardModel(DATA[name], { href: '#x' }))
      expect(textOf(html, 'prop-card-sig')).toBe(`${name}: ${DATA[name].type}`)
      expect(textOf(html, 'prop-card-name')).toBe(name)
      // The link is named with the exact name, which <wbr> would split
      expect(html).toContain(`<a class="prop-card-link" href="#x" aria-label="${name}"><code class="prop-card-name">`)
    }
  })

  test('the colored command reads exactly setCommand() for cluster, broker, and topic', () => {
    for (const name of ['retention_bytes', 'kafka_api', 'brokers', 'cleanup.policy', 'retention.ms']) {
      const html = catalog.cardHtml(catalog.cardModel(DATA[name]))
      expect(textOf(html, 'prop-card-command-text')).toBe(catalog.setCommand(DATA[name]))
      expect(textOf(html, 'prop-cmd-name')).toMatch(new RegExp(`(^|\\.)${name.replace(/\./g, '\\.')}$`))
    }
    const topic = catalog.cardHtml(catalog.cardModel(DATA['cleanup.policy']))
    expect(topic).toContain('<span class="prop-cmd-bin">rpk topic alter-config</span> <span class="prop-cmd-ph">&lt;topic&gt;</span> <span class="prop-cmd-bin">--set</span> <span class="prop-cmd-name">cleanup.<wbr>policy</span>=<span class="prop-cmd-ph">&lt;value&gt;</span>')
  })

  test('the accent bar: deprecated, then Enterprise, then BYOC only', () => {
    expect(catalog.cardModel(DATA.dashboard_dir).accent).toBe('deprecated')
    expect(catalog.cardModel({ ...DATA.cloud_storage_enabled, is_deprecated: true }).accent).toBe('deprecated')
    expect(catalog.cardModel(DATA.cloud_storage_enabled).accent).toBe('enterprise')
    expect(catalog.cardModel({ name: 'x', config_scope: 'cluster', is_enterprise: true }).accent).toBe('enterprise')
    expect(catalog.cardModel(DATA.retention_bytes).accent).toBe('')
    const byoc = Object.values(DATA).find((e) => e.cloud_byoc_only === true && e.config_scope === 'cluster')
    expect(catalog.cardModel(byoc, { cloud: true }).accent).toBe('byoc')
    expect(catalog.cardModel(byoc).accent).not.toBe('byoc')
    expect(catalog.cardHtml(catalog.cardModel(DATA.cloud_storage_enabled))).toMatch(/^<li class="prop-card prop-card--enterprise"/)
    expect(catalog.cardHtml(catalog.cardModel(DATA.retention_bytes))).toMatch(/^<li class="prop-card" /)
  })

  test('badges keep their order, scope first, and Restart required carries its icon class', () => {
    const labels = (entry, opts) => catalog.cardModel(entry, opts).badges.map((b) => b.label)
    expect(labels(DATA.cloud_storage_enabled)).toEqual(['Object storage', 'Restart required', 'Enterprise values'])
    expect(labels(DATA.dashboard_dir)).toEqual(['Broker', 'Restart required', 'Deprecated'])
    // The generator's own object-storage scope keeps its group, whatever the name
    expect(catalog.cardModel({ name: 'x', config_scope: 'object-storage' }).group).toBe('object-storage')
    expect(catalog.cardModel({ name: 'x', config_scope: 'other' }).group).toBe('cluster')
    const html = catalog.cardHtml(catalog.cardModel(DATA.cloud_storage_enabled))
    expect(html).toContain('<span class="rp-badge rp-badge--sm rp-badge--neutral prop-badge--restart" data-tooltip="')
    expect(html.indexOf('>Object storage<')).toBeLessThan(html.indexOf('>Restart required<'))
  })

  test('the license row only for Enterprise values that name values', () => {
    const values = catalog.cardHtml(catalog.cardModel(DATA.sasl_mechanisms))
    expect(values).toContain('<span class="prop-card-fact-label">Needs a license</span> <code>GSSAPI</code> <code>OAUTHBEARER</code>')
    expect(catalog.cardHtml(catalog.cardModel(DATA.default_leaders_preference))).not.toContain('prop-card-license')
    expect(catalog.cardHtml(catalog.cardModel({ name: 'x', config_scope: 'cluster', is_enterprise: true }))).not.toContain('prop-card-license')
    expect(catalog.cardHtml(catalog.cardModel(DATA.retention_bytes))).not.toContain('prop-card-license')
  })

  test('the section label on broker and topic rows only', () => {
    expect(catalog.cardHtml(catalog.cardModel(DATA['retention.ms']))).toContain('<span class="prop-card-section"><span class="prop-card-fact-label">Section</span> Retention and compaction</span>')
    expect(catalog.cardHtml(catalog.cardModel(DATA.brokers))).toContain('<span class="prop-card-section"><span class="prop-card-fact-label">Section</span> HTTP Proxy client</span>')
    expect(catalog.cardHtml(catalog.cardModel(DATA.retention_bytes))).not.toContain('prop-card-section')
  })

  test('Cloud cards Cloud manages say so instead of a command', () => {
    const managed = Object.values(DATA).find((e) => e.config_scope === 'cluster' && e.cloud_supported === true && e.cloud_editable !== true)
    const html = catalog.cardHtml(catalog.cardModel(managed, { cloud: true }))
    expect(html).toContain('<span class="prop-card-managed"><span class="prop-ico prop-card-managed-icon" style="--ico:var(--icon-cloud)" aria-hidden="true"></span>Redpanda Cloud manages this property.</span>')
    expect(html).not.toContain('prop-card-command')
    expect(catalog.cardHtml(catalog.cardModel(DATA.iceberg_enabled, { cloud: true }))).not.toContain('prop-card-managed')
    expect(catalog.cardHtml(catalog.cardModel(DATA.dashboard_dir))).not.toContain('prop-card-managed')
  })

  test('deprecated cards start hidden; Cloud cards have Cloud badges and no default or Enterprise', () => {
    expect(catalog.cardHtml(catalog.cardModel(DATA.dashboard_dir))).toMatch(/^<li class="prop-card[^"]*"[^>]* hidden>/)
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

  test('the empty state names its cause', () => {
    expect(catalog.emptyStateText({ search: 'segment_bytes', filtered: false })).toEqual({ title: 'No properties match "segment_bytes".', hint: 'Check the spelling, or try part of the name.', button: 'Clear search' })
    expect(catalog.emptyStateText({ search: '', filtered: true })).toEqual({ title: 'No properties match these filters.', hint: 'Remove a filter, or clear them all.', button: 'Clear filters' })
    expect(catalog.emptyStateText({ search: 'x', filtered: true, page: true }).title).toBe('No properties on this page match "x" and these filters.')
  })

  test('search text reads . _ and - as one separator and indexes paths and badge words', () => {
    expect(catalog.normalizeSearch('Segment.Bytes')).toBe(catalog.normalizeSearch('segment_bytes'))
    expect(catalog.normalizeSearch('log.segment-size')).toBe('log_segment_size')
    const sasl = catalog.cardModel(DATA.sasl_mechanism)
    expect(sasl.search).toContain('pandaproxy_client_sasl_mechanism')
    expect(sasl.search).toContain('enterprise values')
    expect(catalog.cardModel(DATA.cloud_storage_enabled).search).toContain('restart required')
    expect(catalog.cardModel(DATA['segment.bytes'] || DATA['retention.ms']).search).not.toMatch(/\./)
  })
})

describe('markup', () => {
  // The HTML without the inline stylesheet and script, which name every class
  const markup = (html) => html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, '')
  const cards = Object.values(DATA).filter((e) => catalog.isListed(e)).map((e) => catalog.cardModel(e))

  test('the catalog has one status region, an empty state, the search index, and disclosure filters', () => {
    const html = catalog.catalogHtml(cards)
    expect(html.match(/role="status"/g)).toHaveLength(1)
    expect(html).toContain('<div class="prop-catalog-empty" hidden>')
    expect(html).toContain('<button type="button" class="rp-button rp-button--primary prop-catalog-clear">Clear filters</button>')
    expect(markup(html).match(/prop-catalog-clear\b/g)).toHaveLength(1)
    expect(html).toContain('<button type="button" class="prop-catalog-reset" hidden>Clear all</button>')
    expect(html).not.toMatch(/aria-haspopup|role="menu"/)
    expect(html).toMatch(/aria-expanded="false" aria-controls="property-catalog-type-menu"/)
    expect(html).toMatch(/class="prop-chip prop-chip--more" aria-expanded="false" aria-controls="property-catalog-more"/)
    expect(html).toContain('<div class="prop-catalog-more" id="property-catalog-more" hidden>')
    const shown = cards.filter((c) => c.deprecated === 'no').length
    expect(html).toContain(`placeholder="Search ${shown} properties"`)
    // The count is readable in browse mode
    expect(html).toContain(`<p class="prop-catalog-count"><strong>${shown}</strong> properties</p>`)
    // The list is named, keeps its badges out of the tab order, and each card's name is a heading
    expect(html).toContain('<ul class="prop-catalog-list" role="list" aria-label="Properties" data-tooltip-nofocus>')
    expect(html.match(/<h2 class="prop-card-sig"/g)).toHaveLength(cards.length)
    expect(catalog.catalogHtml(cards.slice(0, 3), { headingLevel: 3 }).match(/<h3 class="prop-card-sig"/g)).toHaveLength(3)
    // Each filter's label is read once, through aria-labelledby only
    expect(markup(html)).not.toMatch(/<label class="prop-catalog-visually-hidden" for="[^"]*-toggle"/)
    expect(html).toContain('<span id="property-catalog-type-label" hidden>Type:</span>')
    expect(html).toContain('<p class="prop-catalog-reveal" hidden>')
    expect(html).toContain('<div class="prop-catalog-pill" hidden>')
    expect(html).toContain('class="table-filters prop-catalog-filters prop-catalog-bar" role="search"')
    expect(html).not.toContain('▼')
    expect(html.match(/<li class="prop-card[ "]/g)).toHaveLength(cards.length)
    const index = html.match(/<script type="application\/json" class="prop-catalog-index">([\s\S]*?)<\/script>/)[1]
    expect(JSON.parse(index)).toHaveLength(cards.length)
    expect(index).not.toContain('</')
  })

  test('the catalog renders Group as chips with hidden checkboxes and an All chip counting the visible total', () => {
    const html = catalog.catalogHtml(cards)
    const group = html.match(/<div class="filter-group prop-chip-group" data-filter="group"[\s\S]*?<\/div>/)[0]
    expect(group).not.toContain('dropdown-checkbox-toggle')
    const shown = cards.filter((c) => c.deprecated === 'no')
    expect(group).toContain(`<button type="button" class="prop-chip prop-chip--group" data-value="" aria-pressed="true"><span class="prop-chip-label">All</span> <span class="prop-chip-count">${shown.length}</span>`)
    // Cluster covers the object storage properties, which are cluster properties too
    const n = (g) => shown.filter((c) => c.group === g).length
    for (const [g, count] of [['cluster', n('cluster') + n('object-storage')], ['object-storage', n('object-storage')], ['broker', n('broker')], ['topic', n('topic')]]) {
      expect(group).toMatch(new RegExp(`data-value="${g}"[^>]* aria-pressed="false"`))
      expect(group).toContain(`<input type="checkbox" value="${g}" checked hidden>`)
      expect(group).toMatch(new RegExp(`data-value="${g}"[^]*?<span class="prop-chip-count">${count}</span>`))
    }
    expect(group).toContain('data-value="cluster" data-covers="cluster,object-storage" data-tooltip="Includes the object storage properties, which are cluster properties too."')
    expect(group).toContain('class="prop-chip prop-chip--group prop-chip--sub" data-value="object-storage"')
    expect(html.match(/data-filter="group"/g)).toHaveLength(1)
  })

  test('quick chips only for filters that survive, self-managed and Cloud sets', () => {
    const chipsOf = (html) => [...html.matchAll(/data-chip-for="([^"]+)" data-chip-values="([^"]+)"[^>]*>.*?<span class="prop-chip-label">([^<]+)</g)].map((m) => `${m[1]}=${m[2]}:${m[3]}`)
    // Enterprise selects the license kinds present: this release has only Enterprise values
    expect(catalog.filterSpecs(cards).find((s) => s.key === 'enterprise').options.map((o) => o.value)).toEqual(['values', 'none'])
    expect(chipsOf(catalog.catalogHtml(cards))).toEqual(['restart=yes:Restart required', 'enterprise=values:Enterprise', 'deprecated=no,yes:Show deprecated'])
    const whole = [...cards, catalog.cardModel({ name: 'x', config_scope: 'cluster', is_enterprise: true })]
    expect(chipsOf(catalog.catalogHtml(whole))).toContain('enterprise=enterprise,values:Enterprise')
    expect(catalog.catalogHtml(cards)).toContain('class="prop-chip prop-chip--enterprise" data-chip-for="enterprise"')
    const cloud = Object.values(DATA).filter((e) => catalog.isListed(e, { cloud: true })).map((e) => catalog.cardModel(e, { cloud: true }))
    const cloudChips = chipsOf(catalog.catalogHtml(cloud, { cloud: true }))
    expect(cloudChips).toEqual(expect.arrayContaining(['editable=yes:Cloud editable', 'byoc=yes:BYOC only']))
    expect(cloudChips.join()).not.toContain('Enterprise')
    // Cloud says how licensing applies, and its chips carry tooltips and the Cloud icon
    const cloudHtml = catalog.catalogHtml(cloud, { cloud: true })
    expect(cloudHtml).toContain('Redpanda Cloud is a managed deployment of Redpanda Enterprise Edition')
    expect(markup(catalog.catalogHtml(cards))).not.toContain('prop-catalog-note')
    expect(cloudHtml).toMatch(/data-chip-for="editable"[^>]*data-tooltip="You can change this property on Redpanda Cloud clusters\."[^>]*><span class="prop-ico prop-chip-icon" style="--ico:var\(--icon-cloud\)"/)
    // The broker page: no restart filter survives, so no Restart chip
    const broker = cards.filter((c) => c.group === 'broker' && c.deprecated === 'no').map((c) => ({ ...c, anchor: c.name }))
    expect(chipsOf(catalog.filterBarHtml(broker))).toEqual(['enterprise=values:Enterprise'])
  })

  test('the filter bar has no Group chips; the topic page shows Section as chips with counts and no More', () => {
    const cluster = cards.filter((c) => c.group === 'cluster' && c.deprecated === 'no').map((c) => ({ ...c, anchor: c.name }))
    const html = catalog.filterBarHtml(cluster)
    expect(markup(html)).not.toMatch(/prop-chip-group|prop-chip--group/)
    expect(html).toContain(`placeholder="Filter ${cluster.length} properties"`)
    expect(html).toContain('<div class="prop-catalog-results" hidden>')
    expect(html).toContain('<div class="prop-catalog-more" id="property-filter-more" hidden>')
    expect(markup(html).match(/prop-catalog-clear\b/g)).toHaveLength(1)
    const topic = cards.filter((c) => c.group === 'topic' && c.deprecated === 'no').map((c) => ({ ...c, anchor: c.name }))
    const topicHtml = catalog.filterBarHtml(topic)
    expect(markup(topicHtml)).not.toContain('prop-chip--more')
    expect(topicHtml).toMatch(/<div class="prop-catalog-chips"><div class="filter-group prop-chip-group" data-filter="section"/)
    expect(topicHtml).toMatch(/data-filter="section"[^]*?<span class="prop-chip-count">\d+<\/span>/)
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
