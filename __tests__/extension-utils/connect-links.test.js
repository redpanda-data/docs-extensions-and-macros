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

  test('findPage resolves a page alias to its page', () => {
    expect(links.findPage(catalogOf(), 'connect:components:inputs/pg_stream.adoc').src.relative).toBe('inputs/postgres_cdc.adoc')
  })
})
