'use strict'

// The ids and pages the Connect link macros compute, against the trimmed
// connect-4.115.1 data, real rp-connect-docs page sources and the heading
// lines of the release asset partials (__tests__/helpers/connect-links-catalog.js).
// Expected anchors are the ids on the published pages: the live HTML of
// the kafka_franz input page and the Bloblang pages on 2026-10-29, and what
// Asciidoctor generates for the sources.

const { DATA, PAGES, catalogOf } = require('../helpers/connect-links-catalog')
const links = require('../../extension-utils/connect-links')
const bloblang = require('../../extension-utils/bloblang-values')

const resolve = (text) => links.resolveComponentRef(DATA, text)
const anchorOf = (text, opts = {}) => links.fieldAnchor({ resolved: resolve(text), ...opts }).anchor

describe('sectionId: the id Asciidoctor generates with idprefix empty and idseparator -', () => {
  test.each([
    ['`batching.byte_size`', 'batching-byte_size'],
    ['`addresses[]`', 'addresses'],
    ['`tls.client_certs[].cert`', 'tls-client_certs-cert'],
    ['`sasl[].aws.credentials`', 'sasl-aws-credentials'],
    ['Object & array manipulation', 'object-array-manipulation'],
    ['JSON web tokens', 'json-web-tokens'],
    ['Strict ordering and retries', 'strict-ordering-and-retries'],
    ['Metadata', 'metadata'],
  ])('%s -> %s', (title, id) => {
    expect(links.sectionId(title)).toBe(id)
  })

  test('claimId numbers a taken id from 2, as Asciidoctor does', () => {
    const taken = new Set()
    expect(['metadata', 'fields', 'metadata', 'metadata'].map((id) => links.claimId(id, taken))).toEqual(['metadata', 'fields', 'metadata-2', 'metadata-3'])
  })
})

describe('field anchors', () => {
  test.each([
    ['inputs/kafka_franz.consumer_group', 'consumer_group'],
    ['inputs/kafka_franz.sasl.mechanism', 'sasl-mechanism'],
    ['inputs/kafka_franz.tls.client_certs.cert', 'tls-client_certs-cert'],
    ['inputs/kafka_franz.batching.byte_size', 'batching-byte_size'],
  ])('%s -> #%s, as on the live kafka_franz input page', (text, anchor) => {
    expect(anchorOf(text, { catalog: catalogOf() })).toBe(anchor)
  })

  test('outputs/amqp_1 metadata is metadata-2: the description has a Metadata section first', () => {
    expect(anchorOf('outputs/amqp_1.metadata', { catalog: catalogOf() })).toBe('metadata-2')
    expect(anchorOf('outputs/amqp_1.metadata')).toBe('metadata-2')
  })

  test('processors/nats_request_reply metadata is metadata-2: the description partial includes the metadata partial', () => {
    expect(anchorOf('processors/nats_request_reply.metadata', { catalog: catalogOf() })).toBe('metadata-2')
    const ids = links.componentAnchors({ entry: resolve('processors/nats_request_reply').entry, pageText: PAGES.sources['processors/nats_request_reply'], catalog: catalogOf() })
    expect(ids.has('metadata')).toBe(true)
    expect(ids.has('metadata-2')).toBe(true)
  })

  test('inputs/jira fields is fields-2: the fields partial opens with == Fields', () => {
    expect(anchorOf('inputs/jira.fields', { catalog: catalogOf() })).toBe('fields-2')
    expect(anchorOf('inputs/jira.fields')).toBe('fields-2')
  })

  test('the page source decides: its headings before the fields include, and the partials it includes', () => {
    const source = PAGES.sources['inputs/kafka']
    const { before } = links.componentPageIds({ entry: resolve('inputs/kafka').entry, pageText: source })
    // inputs/kafka.adoc includes the metadata partial, then has Ordering and
    // Troubleshooting, then the fields: the live page's ids in that order.
    expect(before).toEqual(['metadata', 'ordering', 'troubleshooting'])
  })

  test('a == Fields heading written into the page starts the fields, as the fields partial does', () => {
    const pageText = '= kafka_franz\n\n== Metadata\n\nText.\n\n== Fields\n\n=== `consumer_group`\n'
    expect(links.componentPageIds({ entry: resolve('inputs/kafka_franz').entry, pageText }).before).toEqual(['metadata'])
    expect(anchorOf('inputs/kafka_franz.consumer_group', { pageText })).toBe('consumer_group')
  })

  test('a deprecated field has no anchor: the reference does not list it', () => {
    expect(links.fieldAnchor({ resolved: resolve('inputs/kafka_franz.regexp_topics'), catalog: catalogOf() })).toEqual({ heading: 'regexp_topics', documented: false })
  })

  test('the fields partial, when the build has it, decides which fields are listed', () => {
    const partial = PAGES.partials['fields/inputs/kafka_franz.adoc']
    expect(partial).toContain('=== `consumer_group`')
    expect(partial).not.toContain('=== `regexp_topics`')
  })

  test('componentAnchors lists every id on a component page', () => {
    const ids = links.componentAnchors({ entry: resolve('outputs/amqp_1').entry, pageText: PAGES.sources['outputs/amqp_1'], catalog: catalogOf() })
    expect(ids.has('metadata')).toBe(true)
    expect(ids.has('metadata-2')).toBe(true)
    expect(ids.has('fields')).toBe(true)
  })
})

describe('Bloblang anchors', () => {
  const order = bloblang.methodCategoryOrder(DATA, PAGES.partials['bloblang/methods.adoc'])

  test('the category order rule matches the published methods partial', () => {
    expect(bloblang.methodCategoryOrder(DATA)).toEqual(order.filter((key) => bloblang.methodCategoryOrder(DATA).includes(key)))
    expect(order[0]).toBe('general')
    expect(order[order.length - 1]).toBe('deprecated')
  })

  test.each([
    ['contains', undefined, 'contains'],
    ['contains', 'Object & Array Manipulation', 'contains'],
    ['contains', 'String Manipulation', 'contains-2'],
    ['length', undefined, 'length'],
    ['length', 'String Manipulation', 'length-2'],
    ['slice', 'String Manipulation', 'slice-2'],
    ['uppercase', undefined, 'uppercase'],
  ])('.%s() in %s -> #%s', (name, category, anchor) => {
    const entry = DATA['bloblang-methods'].find((e) => e.name === name)
    expect(links.bloblangAnchor(entry, bloblang.pickCategory('method', entry, category, order))).toBe(anchor)
  })

  test('the functions page lists every function but the hidden ones, and on Cloud not the impure ones', () => {
    const all = links.bloblangAnchors(DATA, 'function')
    const cloud = links.bloblangAnchors(DATA, 'function', { cloud: true })
    expect(all.has('now')).toBe(true)
    expect(all.has('nothing')).toBe(false)
    expect(all.has('var')).toBe(false)
    expect(all.has('env')).toBe(true)
    expect(cloud.has('env')).toBe(false)
    expect(all.size - cloud.size).toBe(5)
  })

  test('the methods page has each copy and each category heading', () => {
    const ids = links.bloblangAnchors(DATA, 'method', { order })
    for (const id of ['contains', 'contains-2', 'length-2', 'uppercase', 'string-manipulation', 'object-array-manipulation']) expect([id, ids.has(id)]).toEqual([id, true])
    expect(ids.has('uppercase-2')).toBe(false)
  })
})

describe('pages', () => {
  test('the rendering component first, then connect, and Cloud only its own', () => {
    const catalog = catalogOf()
    const pick = (component, cloud = false) => links.pickConnectPage(catalog, { component, version: '', module: 'components', relative: 'inputs/kafka_franz.adoc', cloud })
    expect(pick('connect')).toMatchObject({ ok: true, own: true, id: 'connect:components:inputs/kafka_franz.adoc' })
    expect(pick('streaming')).toMatchObject({ ok: true, own: false, id: 'connect:components:inputs/kafka_franz.adoc' })
    expect(pick('cloud-data-platform', true)).toMatchObject({ ok: true, own: true, id: 'cloud-data-platform:develop:connect/components/inputs/kafka_franz.adoc' })
    expect(links.pickConnectPage(catalog, { component: 'cloud-data-platform', version: '', module: 'components', relative: 'outputs/amqp_1.adoc', cloud: true })).toEqual({ ok: false, reason: 'cloud-no-page' })
    expect(links.pickConnectPage(catalogOf({ components: [] }), { component: 'streaming', version: '26.2', module: 'components', relative: 'inputs/kafka_franz.adoc' })).toEqual({ ok: false, reason: 'no-page' })
  })

  test('from Cloud, a component whose stub was removed has no page: its path aliases the type\'s about page', () => {
    // cloud-docs d9be410 modules/develop/pages/connect/components/processors/about.adoc:2
    const catalog = catalogOf()
    expect(links.findPage(catalog, 'components:processors/protobuf.adoc', { component: 'cloud-data-platform', version: '', module: 'components' }).src.relative).toBe('connect/components/processors/about.adoc')
    expect(links.pickConnectPage(catalog, { component: 'cloud-data-platform', version: '', module: 'components', relative: 'processors/protobuf.adoc', cloud: true })).toEqual({ ok: false, reason: 'cloud-no-page' })
    expect(links.pickConnectPage(catalog, { component: 'cloud-data-platform', version: '', module: 'components', relative: 'processors/nats_request_reply.adoc', cloud: true })).toMatchObject({ ok: true, own: true })
    expect(links.pickConnectPage(catalog, { component: 'connect', version: '', module: 'components', relative: 'inputs/pg_stream.adoc' })).toMatchObject({ ok: true, own: true, id: 'connect:components:inputs/postgres_cdc.adoc' })
  })

  describe('a Cloud stub is found by the connect page it includes', () => {
    const cloudPick = (catalog, relative) => links.pickConnectPage(catalog, { component: 'cloud-data-platform', version: '', module: 'components', relative, cloud: true })
    const STUB = 'cloud-data-platform:develop:connect/components/inputs/postgres_cdc.adoc'

    // cloud-docs d9be410 modules/develop/pages/connect/components/inputs/postgres_cdc.adoc:2,4
    test('postgres_cdc, whose page-aliases has no components: path, by its include', () => {
      const catalog = catalogOf()
      expect(links.findPage(catalog, 'components:inputs/postgres_cdc.adoc', { component: 'cloud-data-platform', version: '', module: 'components' })).toBeUndefined()
      expect(cloudPick(catalog, 'inputs/postgres_cdc.adoc')).toMatchObject({ ok: true, own: true, id: STUB })
      // pg_stream's connect path goes to the postgres_cdc page, which the stub includes.
      expect(cloudPick(catalog, 'inputs/pg_stream.adoc')).toMatchObject({ ok: true, own: true, id: STUB })
      // Without the stub's source, only its alias is left, and it names no components: path.
      expect(cloudPick(catalogOf({ sources: false }), 'inputs/postgres_cdc.adoc')).toEqual({ ok: false, reason: 'cloud-no-page' })
    })

    // cloud-docs d9be410 modules/develop/pages/connect/components/inputs/redpanda.adoc:2,4
    test('redpanda, whose alias and include agree, as before', () => {
      expect(cloudPick(catalogOf(), 'inputs/redpanda.adoc')).toMatchObject({ ok: true, own: true, id: 'cloud-data-platform:develop:connect/components/inputs/redpanda.adoc' })
      expect(cloudPick(catalogOf({ sources: false }), 'inputs/redpanda.adoc')).toMatchObject({ ok: true, own: true, id: 'cloud-data-platform:develop:connect/components/inputs/redpanda.adoc' })
    })

    test('the include wins over an alias that disagrees: a stub copied from redpanda that kept its include', () => {
      const text = PAGES['cloud-sources']['connect/components/inputs/redpanda.adoc'].replace('= redpanda', '= amqp_1').replace('components:inputs/redpanda.adoc', 'components:outputs/amqp_1.adoc')
      const page = { src: { component: 'cloud-data-platform', version: '', module: 'develop', family: 'page', relative: 'connect/components/outputs/amqp_1.adoc' }, contents: Buffer.from(text) }
      const alias = { src: { component: 'cloud-data-platform', version: '', module: 'components', family: 'alias', relative: 'outputs/amqp_1.adoc' }, rel: page }
      const catalog = catalogOf({ extra: [page, alias] })
      expect(links.findPage(catalog, 'components:outputs/amqp_1.adoc', { component: 'cloud-data-platform', version: '', module: 'components' })).toBe(page)
      expect(links.isPageOf(catalog, page, { module: 'components', relative: 'outputs/amqp_1.adoc' })).toBe(false)
      expect(cloudPick(catalog, 'outputs/amqp_1.adoc')).toEqual({ ok: false, reason: 'cloud-no-page' })
      // The real redpanda stub keeps the redpanda path: it includes that page and has its file name.
      expect(cloudPick(catalog, 'inputs/redpanda.adoc')).toMatchObject({ id: 'cloud-data-platform:develop:connect/components/inputs/redpanda.adoc' })
    })

    test('a stub converted before the link keeps the includes noteIncludes recorded', () => {
      const converted = (note) => {
        const catalog = catalogOf()
        const stub = catalog.findBy({ component: 'cloud-data-platform', family: 'page', relative: 'connect/components/inputs/postgres_cdc.adoc' })[0]
        if (note) links.noteIncludes(stub)
        stub.contents = Buffer.from('<div class="paragraph"><p>converted</p></div>')
        return catalog
      }
      expect(cloudPick(converted(true), 'inputs/postgres_cdc.adoc')).toMatchObject({ ok: true, id: STUB })
      expect(cloudPick(converted(false), 'inputs/postgres_cdc.adoc')).toEqual({ ok: false, reason: 'cloud-no-page' })
    })

    test('includedPaths reads include::connect:components:<type>/<name>.adoc[] with any attributes and an optional page$, and no partials', () => {
      // cloud-docs aab67ef inputs/oracledb_cdc.adoc:4 and inputs/gateway.adoc:4
      const page = { src: {}, contents: Buffer.from('= x\ninclude::connect:components:partial$descriptions/inputs/x.adoc[tag=meta]\ninclude::connect:components:inputs/x.adoc[]\ninclude::connect:components:rate_limits/local.adoc[tag=single-source,leveloffset=+1]\ninclude::connect:components:page$inputs/oracledb_cdc.adoc[tag=single-source]\ninclude::connect:components:partial$components/inputs/gateway.adoc[tag=single-source]\n// include::connect:components:inputs/y.adoc[]\n') }
      expect(links.includedPaths(page)).toEqual(['inputs/x.adoc', 'rate_limits/local.adoc', 'inputs/oracledb_cdc.adoc'])
    })
  })

  test('findPage resolves a page alias to its page', () => {
    expect(links.findPage(catalogOf(), 'connect:components:inputs/pg_stream.adoc').src.relative).toBe('inputs/postgres_cdc.adoc')
  })
})
