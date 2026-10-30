'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  buildDocsResolverContext,
  describeResolverContext,
  convertDocsLinks,
  convertDocsLinksInFile,
  explainRawDocsUrl,
  formatDocsLinkReport,
} = require('../../cli-utils/docs-links-to-xrefs')
const { makeAntoraCheckout } = require('../helpers/antora-checkout')

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'docs-links-component')
const CONNECT_FIXTURE = path.join(__dirname, '..', 'fixtures', 'docs-links-connect')

const makeDocsCheckout = () => makeAntoraCheckout(FIXTURE)

// Trimmed from raw_tree in redpanda-data/docs docs-data/rpk-v26.2.2.json:
// the help text of the rpk commands that link to docs.redpanda.com.
const RPK_HELP = {
  connect: 'A stream processor for mundane tasks - https://docs.redpanda.com/redpanda-connect',
  blobl: 'Find out more about Bloblang at: https://docs.redpanda.com/redpanda-connect/guides/bloblang/about',
  streams: 'For more information check out the docs at:\nhttps://docs.redpanda.com/redpanda-connect/guides/streams_mode/about',
  template: 'For more information check out the docs at:\nhttps://docs.redpanda.com/redpanda-connect/configuration/templating',
  test: 'For more information check out the docs at:\nhttps://docs.redpanda.com/redpanda-connect/configuration/unit_testing',
  restore: 'Use --cluster-uuid-override if you want to specify an explicit cluster UUID\nto restore from. For more information, visit https://docs.redpanda.com/current/manage/disaster-recovery/whole-cluster-restore/.',
  connections: 'refer to the admin API docs of the filter and order-by fields of the ListKafkaConnections endpoint: https://docs.redpanda.com/api/doc/admin/version/11f41833-5783-4f1a-ad64-5957267abd52/operation/operation-redpanda-core-admin-v2-clusterservice-listkafkaconnections',
}

describe('docs-links-to-xrefs', () => {
  jest.setTimeout(60000)
  let docsRoot
  let context

  beforeAll(async () => {
    docsRoot = makeDocsCheckout()
    context = await buildDocsResolverContext(docsRoot, { cacheDir: path.join(docsRoot, '.antora-cache') })
  })

  afterAll(() => {
    fs.rmSync(docsRoot, { recursive: true, force: true })
  })

  const convert = (text) => convertDocsLinks(text, context)

  test('builds the catalog from the checkout and names its component', () => {
    expect(context.component).toBe('streaming')
    expect(context.pageCount).toBe(4)
    expect(context.loaded).toEqual([{ component: 'streaming', version: '26.2', dir: docsRoot, pageCount: 4 }])
    expect(describeResolverContext(context, docsRoot)).toBe(`Mapping docs URLs against 4 pages of the streaming component in ${docsRoot}`)
    expect(context.urls.get('/streaming/current/manage/kubernetes/manage-resources')).toMatchObject({
      module: 'manage',
      relative: 'kubernetes/manage-resources.adoc',
      latest: true,
    })
  })

  test('converts a current URL into a same-component xref and keeps the sentence punctuation', () => {
    const { content, converted } = convert(
      'CPU configures CPU resources for containers. See https://docs.redpanda.com/current/manage/kubernetes/manage-resources/.'
    )
    expect(content).toBe(
      'CPU configures CPU resources for containers. See xref:manage:kubernetes/manage-resources.adoc[].'
    )
    expect(converted).toBe(1)
  })

  test.each([
    ['the real version number', 'https://docs.redpanda.com/26.2/manage/kubernetes/manage-resources/'],
    ['a v-prefixed version number', 'https://docs.redpanda.com/v26.2/manage/kubernetes/manage-resources/'],
    ['the component and version', 'https://docs.redpanda.com/streaming/26.2/manage/kubernetes/manage-resources/'],
    ['the component and symbolic segment', 'https://docs.redpanda.com/streaming/current/manage/kubernetes/manage-resources/'],
  ])('converts a URL versioned with %s into the unversioned same-component xref', (_, url) => {
    expect(convert(url).content).toBe('xref:manage:kubernetes/manage-resources.adoc[]')
  })

  // The extension does the same in a site build that no longer publishes the
  // old version: the candidate list falls through to the latest version.
  test('resolves a URL pinned to a version the checkout does not have against the current page', () => {
    expect(convert('https://docs.redpanda.com/25.3/manage/kubernetes/manage-resources/').content).toBe(
      'xref:manage:kubernetes/manage-resources.adoc[]'
    )
  })

  test('leaves an external URL unchanged', () => {
    const input =
      'See the GitHub issue https://github.com/redpanda-data/redpanda/issues/350 and link:https://kubernetes.io/docs/concepts/[Kubernetes].'
    const result = convert(input)
    expect(result.content).toBe(input)
    expect(result.converted).toBe(0)
    expect(result.unmapped).toEqual([])
  })

  test('keeps an anchor fragment and labels it with the heading from the included partial', () => {
    expect(
      convert('Enable with https://docs.redpanda.com/current/reference/properties/cluster-properties/#cloud_storage_enabled.')
        .content
    ).toBe('Enable with xref:reference:properties/cluster-properties.adoc#cloud_storage_enabled[cloud_storage_enabled].')
  })

  test('labels a fragment that points at a heading on the page itself', () => {
    expect(convert('https://docs.redpanda.com/current/get-started/architecture/#thread-per-core-model').content).toBe(
      'xref:get-started:architecture.adoc#thread-per-core-model[Thread-per-core model]'
    )
  })

  test('resolves a legacy /docs/ URL of a moved page through its page alias', () => {
    // The page moved to properties/ and declares the old paths as aliases.
    expect(
      convert('https://docs.redpanda.com/docs/reference/cluster-properties/#default_topic_replications').content
    ).toBe('xref:reference:properties/cluster-properties.adoc#default_topic_replications[default_topic_replications]')
    expect(convert('https://docs.redpanda.com/current/reference/tunable-properties/').content).toBe(
      'xref:reference:properties/cluster-properties.adoc[]'
    )
  })

  test('leaves a URL that maps to no page unchanged and reports it', () => {
    const input = 'See https://docs.redpanda.com/current/manage/no-such-page/ for details.'
    const { content, converted, unmapped } = convert(input)
    expect(content).toBe(input)
    expect(converted).toBe(0)
    expect(unmapped).toEqual(['https://docs.redpanda.com/current/manage/no-such-page/'])
  })

  test('leaves a URL of another component unchanged and reports it', () => {
    // A single-repo catalog has no Connect pages; the build-time extension
    // converts this one on the site.
    const input = 'https://docs.redpanda.com/redpanda-connect/configuration/secrets/'
    const { content, unmapped } = convert(input)
    expect(content).toBe(input)
    expect(unmapped).toEqual([input])
  })

  test('converts a file in place and reports what was left', () => {
    const file = path.join(docsRoot, 'generated.adoc')
    fs.writeFileSync(
      file,
      [
        '= Generated',
        '',
        '| *`cores`* __integer__ | See https://docs.redpanda.com/current/get-started/architecture/#thread-per-core-model. +',
        '| *`secrets`* __string__ | See https://docs.redpanda.com/redpanda-connect/configuration/secrets/. +',
        '| *`tabs`* __string__ | See https://docs.redpanda.com/current/manage/kubernetes/manage-resources/?platform=kubernetes. +',
        '| *`tiered`* __boolean__ | See https://docs.redpanda.com/current/reference/properties/cluster-properties/#cloud_storage_no_such_anchor. +',
        '',
      ].join('\n')
    )
    const result = convertDocsLinksInFile(file, context)
    expect(result).toEqual({
      converted: 1,
      unmapped: ['https://docs.redpanda.com/redpanda-connect/configuration/secrets/'],
      withQueryString: ['https://docs.redpanda.com/current/manage/kubernetes/manage-resources/?platform=kubernetes'],
      withoutLinkText: [],
      missingAnchor: ['https://docs.redpanda.com/current/reference/properties/cluster-properties/#cloud_storage_no_such_anchor'],
    })
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('See xref:get-started:architecture.adoc#thread-per-core-model[Thread-per-core model]. +')
    expect(written).toContain('See https://docs.redpanda.com/redpanda-connect/configuration/secrets/. +')
    const report = formatDocsLinkReport(result, file)
    expect(report).toContain(`Converted 1 docs URL to xrefs in ${file}`)
    expect(report).toContain('no page in this checkout matches')
    expect(report).toContain('  https://docs.redpanda.com/redpanda-connect/configuration/secrets/')
    expect(report).toContain('an xref cannot carry a query string')
    expect(report).toContain('anchor not found')
    expect(report).toContain('  https://docs.redpanda.com/current/reference/properties/cluster-properties/#cloud_storage_no_such_anchor')
    expect(written).toContain('See https://docs.redpanda.com/current/reference/properties/cluster-properties/#cloud_storage_no_such_anchor. +')
  })

  test('leaves a URL whose page resolves but whose anchor does not as written, and reports it', () => {
    for (const url of [
      'https://docs.redpanda.com/current/reference/properties/cluster-properties/#cloud_storage_no_such_anchor',
      'https://docs.redpanda.com/current/get-started/architecture/#nope',
    ]) {
      for (const input of [`See ${url}.`, `See ${url}[the setting].`]) {
        const { content, converted, missingAnchor, unmapped, withoutLinkText } = convert(input)
        expect(content).toBe(input)
        expect(converted).toBe(0)
        expect(missingAnchor).toEqual([url])
        expect(unmapped).toEqual([])
        expect(withoutLinkText).toEqual([])
      }
    }
  })

  test('converts a fragment that names a property heading from the generated partial, a custom heading id or a block anchor', () => {
    const property = convert('https://docs.redpanda.com/current/reference/properties/cluster-properties/#default_topic_replications')
    expect(property.content).toBe('xref:reference:properties/cluster-properties.adoc#default_topic_replications[default_topic_replications]')
    expect(property.missingAnchor).toEqual([])
    expect(convert('https://docs.redpanda.com/current/get-started/architecture/#shard-layout').content).toBe(
      'xref:get-started:architecture.adoc#shard-layout[How shards are laid out]'
    )
    expect(convert('https://docs.redpanda.com/current/get-started/architecture/#pinning-note[pinning]').content).toBe(
      'xref:get-started:architecture.adoc#pinning-note[pinning]'
    )
  })

  test('converts the rpk restore help URL and keeps its sentence period', () => {
    const { content, converted } = convert(RPK_HELP.restore)
    expect(content).toBe(
      'Use --cluster-uuid-override if you want to specify an explicit cluster UUID\nto restore from. For more information, visit xref:manage:disaster-recovery/whole-cluster-restore.adoc[].'
    )
    expect(converted).toBe(1)
  })

  test('leaves the rpk API reference URL as written without reporting it', () => {
    const result = convert(RPK_HELP.connections)
    expect(result.content).toBe(RPK_HELP.connections)
    expect(result.converted).toBe(0)
    expect(result.unmapped).toEqual([])
  })

  test('without lenders, reports rpk connect URLs as pointing at a component that was not loaded', () => {
    const result = convert(RPK_HELP.blobl)
    expect(result.content).toBe(RPK_HELP.blobl)
    const report = formatDocsLinkReport(result, 'rpk-connect-blobl.adoc', context)
    expect(report).toContain('it points at the connect component, which this run did not load; pass its checkout with --lender')
    expect(report).toContain('  https://docs.redpanda.com/redpanda-connect/guides/bloblang/about')
    // A URL in a loaded component that matches no page is a likely broken link.
    const broken = convert('See https://docs.redpanda.com/current/manage/no-such-page/.')
    expect(formatDocsLinkReport(broken, 'x.adoc', context)).toContain('no page in the loaded components matches; the link is probably broken')
  })

  test('explains every way a docs URL can stay raw', () => {
    const urls = {
      connect: 'https://docs.redpanda.com/redpanda-connect/guides/bloblang/about',
      broken: 'https://docs.redpanda.com/current/manage/no-such-page/',
      anchor: 'https://docs.redpanda.com/current/get-started/architecture/#nope',
      query: 'https://docs.redpanda.com/current/manage/kubernetes/manage-resources/?platform=kubernetes',
      api: 'https://docs.redpanda.com/api/doc/admin/v2/operation/x',
      listing: 'https://docs.redpanda.com/current/get-started/architecture/',
    }
    const result = convert(
      [urls.connect, urls.broken, urls.anchor, urls.query, urls.api].map((u) => `See ${u}.`).join('\n\n') +
        `\n\n----\ncurl ${urls.listing}\n----\n`
    )
    const report = { result, context }
    expect(explainRawDocsUrl(urls.connect, report)).toMatchObject({ severity: 'info', reason: expect.stringContaining('connect component, which this run did not load') })
    expect(explainRawDocsUrl(urls.broken, report)).toMatchObject({ severity: 'warning', reason: expect.stringContaining('probably broken') })
    expect(explainRawDocsUrl(urls.anchor, report)).toMatchObject({ severity: 'warning', reason: expect.stringContaining('anchor not found') })
    expect(explainRawDocsUrl(urls.query, report)).toMatchObject({ severity: 'info', reason: expect.stringContaining('query string') })
    expect(explainRawDocsUrl(urls.api, report)).toMatchObject({ severity: 'info', reason: expect.stringContaining('outside the Antora catalog') })
    expect(explainRawDocsUrl(urls.listing, report)).toMatchObject({ severity: 'info', reason: expect.stringContaining('code block') })
    expect(explainRawDocsUrl(urls.connect, null)).toMatchObject({ severity: 'info', reason: expect.stringContaining('no docs checkout was given') })
  })

  test('does not rewrite a file that has nothing to convert', () => {
    const file = path.join(docsRoot, 'untouched.adoc')
    const input = '= Untouched\n\nSee https://example.com/ and xref:manage:kubernetes/manage-resources.adoc[].\n'
    fs.writeFileSync(file, input)
    const before = fs.statSync(file).mtimeMs
    const result = convertDocsLinksInFile(file, context)
    expect(result.converted).toBe(0)
    expect(fs.readFileSync(file, 'utf8')).toBe(input)
    expect(fs.statSync(file).mtimeMs).toBe(before)
  })

  test('refuses a directory that is not an Antora component', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-links-empty-'))
    await expect(buildDocsResolverContext(empty)).rejects.toThrow(/No antora\.yml/)
    fs.rmSync(empty, { recursive: true, force: true })
  })
})

describe('docs-links-to-xrefs with lenders', () => {
  jest.setTimeout(60000)
  let docsRoot
  let connectRoot
  let olderDocsRoot
  let context

  beforeAll(async () => {
    docsRoot = makeDocsCheckout()
    connectRoot = makeAntoraCheckout(CONNECT_FIXTURE)
    // The same component at an older version, as a checkout of a docs
    // version branch would be.
    olderDocsRoot = makeAntoraCheckout(FIXTURE, {
      edit: (root) => {
        const descriptor = path.join(root, 'antora.yml')
        fs.writeFileSync(descriptor, fs.readFileSync(descriptor, 'utf8').replace("version: '26.2'", "version: '26.1'"))
      },
    })
    context = await buildDocsResolverContext(docsRoot, {
      lenders: [connectRoot, olderDocsRoot],
      cacheDir: path.join(docsRoot, '.antora-cache'),
    })
  })

  afterAll(() => {
    for (const root of [docsRoot, connectRoot, olderDocsRoot]) fs.rmSync(root, { recursive: true, force: true })
  })

  const convert = (text) => convertDocsLinks(text, context)

  test('reads the lenders into the same catalog and lists what it loaded', () => {
    expect(context.component).toBe('streaming')
    expect(context.loaded).toEqual([
      { component: 'streaming', version: '26.2', dir: docsRoot, pageCount: 4 },
      { component: 'connect', version: '', dir: connectRoot, pageCount: 6 },
      { component: 'streaming', version: '26.1', dir: olderDocsRoot, pageCount: 4 },
    ])
    expect(describeResolverContext(context, docsRoot)).toBe(
      `Mapping docs URLs against 4 pages of the streaming component in ${docsRoot}, plus lender pages: ` +
        `6 of connect in ${connectRoot}; 4 of streaming 26.1 in ${olderDocsRoot}`
    )
  })

  test.each([
    ['connect', 'A stream processor for mundane tasks - xref:connect:home:index.adoc[]'],
    ['blobl', 'Find out more about Bloblang at: xref:connect:guides:bloblang/about.adoc[]'],
    ['streams', 'For more information check out the docs at:\nxref:connect:guides:streams_mode/about.adoc[]'],
    ['template', 'For more information check out the docs at:\nxref:connect:configuration:templating.adoc[]'],
    ['test', 'For more information check out the docs at:\nxref:connect:configuration:unit_testing.adoc[]'],
  ])('converts the rpk %s help URL into a component-qualified Connect xref', (name, expected) => {
    const result = convert(RPK_HELP[name])
    expect(result.content).toBe(expected)
    expect(result.converted).toBe(1)
    expect(result.unmapped).toEqual([])
  })

  test('keeps the module:page form for targets in the local component', () => {
    expect(convert(RPK_HELP.restore).content).toContain('visit xref:manage:disaster-recovery/whole-cluster-restore.adoc[].')
    expect(convert(RPK_HELP.connections).content).toBe(RPK_HELP.connections)
  })

  test('resolves a lender page through its page alias', () => {
    expect(convert('https://docs.redpanda.com/connect/streaming/about/').content).toBe('xref:connect:get-started:about.adoc[]')
  })

  test('converts a lender fragment only when the anchor is on the page', () => {
    expect(convert('https://docs.redpanda.com/redpanda-connect/guides/bloblang/about/#assignment').content).toBe(
      'xref:connect:guides:bloblang/about.adoc#assignment[Assignment]'
    )
    const missing = convert('https://docs.redpanda.com/redpanda-connect/guides/bloblang/about/#nope')
    expect(missing.converted).toBe(0)
    expect(missing.missingAnchor).toEqual(['https://docs.redpanda.com/redpanda-connect/guides/bloblang/about/#nope'])
  })

  test('maps versioned URLs to the component version they name, as the build-time extension does', () => {
    const page = 'manage/kubernetes/manage-resources/'
    expect(convert(`https://docs.redpanda.com/current/${page}`).content).toBe('xref:manage:kubernetes/manage-resources.adoc[]')
    expect(convert(`https://docs.redpanda.com/26.2/${page}`).content).toBe('xref:manage:kubernetes/manage-resources.adoc[]')
    expect(convert(`https://docs.redpanda.com/26.1/${page}`).content).toBe('xref:26.1@streaming:manage:kubernetes/manage-resources.adoc[]')
    expect(convert(`https://docs.redpanda.com/streaming/26.1/${page}`).content).toBe('xref:26.1@streaming:manage:kubernetes/manage-resources.adoc[]')
    // A version no loaded checkout has falls through to the latest page.
    expect(convert(`https://docs.redpanda.com/25.3/${page}`).content).toBe('xref:manage:kubernetes/manage-resources.adoc[]')
  })

  test('reports a lender URL that matches no page as a likely broken link', () => {
    const result = convert('https://docs.redpanda.com/redpanda-connect/guides/no-such-page/')
    expect(result.unmapped).toEqual(['https://docs.redpanda.com/redpanda-connect/guides/no-such-page/'])
    expect(formatDocsLinkReport(result, 'x.adoc', context)).toContain('no page in the loaded components matches')
  })

  test('refuses a lender that duplicates the local component version', async () => {
    const twin = makeDocsCheckout()
    try {
      await expect(buildDocsResolverContext(docsRoot, { lenders: [twin] })).rejects.toThrow(/Each lender must be a different component, or a different version of one/)
    } finally {
      fs.rmSync(twin, { recursive: true, force: true })
    }
  })

  test('refuses a lender that is not an Antora component', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-links-empty-'))
    try {
      await expect(buildDocsResolverContext(docsRoot, { lenders: [empty] })).rejects.toThrow(/No antora\.yml/)
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })
})
