'use strict'

const extension = require('../../extensions/url-to-xref')
const { buildUrlMap, convertContent, normalizeUrlPath } = extension

function makePage ({ component, version, module: module_, relative, url, contents = '' }) {
  return {
    src: { component, version, module: module_, relative, family: 'page' },
    pub: { url },
    out: {},
    path: `modules/${module_}/pages/${relative}`,
    contents: Buffer.from(contents),
  }
}

// Mirrors the published shape of docs.redpanda.com: a versioned streaming
// component (latest published under the symbolic 'current' segment), an
// unversioned multi-module connect component, and a ROOT-only home component.
function makeCatalog () {
  const pages = [
    makePage({
      component: 'streaming',
      version: '25.3',
      module: 'manage',
      relative: 'kubernetes/manage-resources.adoc',
      url: '/streaming/current/manage/kubernetes/manage-resources/',
    }),
    makePage({
      component: 'streaming',
      version: '25.3',
      module: 'reference',
      relative: 'properties/cluster-properties.adoc',
      url: '/streaming/current/reference/properties/cluster-properties/',
    }),
    makePage({
      component: 'streaming',
      version: '24.3',
      module: 'manage',
      relative: 'security/authentication.adoc',
      url: '/streaming/24.3/manage/security/authentication/',
    }),
    makePage({
      component: 'connect',
      version: '',
      module: 'configuration',
      relative: 'secrets.adoc',
      url: '/connect/configuration/secrets/',
    }),
    makePage({
      component: 'connect',
      version: '',
      module: 'components',
      relative: 'inputs/kafka.adoc',
      url: '/connect/components/inputs/kafka/',
    }),
    makePage({
      component: 'connect',
      version: '',
      module: 'home',
      relative: 'index.adoc',
      url: '/connect/home/',
    }),
    makePage({
      component: 'home',
      version: '',
      module: 'ROOT',
      relative: 'index.adoc',
      url: '/home/',
    }),
    // A preview-style build: docs component named ROOT (dropped from URLs)
    // with no symbolic latest-version segment configured.
    makePage({
      component: 'ROOT',
      version: '25.3',
      module: 'get-started',
      relative: 'quick-start.adoc',
      url: '/25.3/get-started/quick-start/',
    }),
  ]
  const connectHome = pages[5]
  const homeIndex = pages[6]
  const aliases = [
    // component start-page alias registered by Antora during classification
    { pub: { url: '/connect/' }, rel: connectHome, src: { family: 'alias' } },
    // site start-page alias
    { pub: { url: '/' }, rel: homeIndex, src: { family: 'alias' } },
    // symbolic-version splat alias: must be ignored
    { pub: { url: '/streaming/25.3/', splat: true }, rel: pages[0], src: { family: 'alias' } },
  ]
  const partials = []
  return {
    pages,
    partials,
    getComponents: () => [
      { name: 'streaming', latest: { version: '25.3' } },
      { name: 'connect', latest: { version: '' } },
      { name: 'home', latest: { version: '' } },
      { name: 'ROOT', latest: { version: '25.3' } },
    ],
    getPages: (filter) => (filter ? pages.filter(filter) : pages),
    findBy: ({ family }) => (family === 'alias' ? aliases : family === 'partial' ? partials : []),
  }
}

function makeResolverContext () {
  return Object.assign(buildUrlMap(makeCatalog()), {
    hostnames: new Set(['docs.redpanda.com']),
    ignore: [/^\/api\//],
    latestVersionSegment: 'current',
  })
}

function convert (text) {
  return convertContent(text, makeResolverContext())
}

describe('normalizeUrlPath', () => {
  test.each([
    ['/connect/configuration/secrets/', '/connect/configuration/secrets'],
    ['/connect/configuration/secrets', '/connect/configuration/secrets'],
    ['/connect/configuration/secrets/index.html', '/connect/configuration/secrets'],
    ['/connect/configuration/secrets.html', '/connect/configuration/secrets'],
    ['/connect/configuration/secrets/?q=1', '/connect/configuration/secrets'],
    ['/', '/'],
    ['/index.html', '/'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeUrlPath(input)).toBe(expected)
  })
})

describe('buildUrlMap', () => {
  const { urls, components } = buildUrlMap(makeCatalog())

  test('maps page URLs to their source coordinates with latest flags', () => {
    expect(urls.get('/streaming/current/manage/kubernetes/manage-resources')).toEqual({
      component: 'streaming',
      version: '25.3',
      module: 'manage',
      relative: 'kubernetes/manage-resources.adoc',
      latest: true,
    })
    expect(urls.get('/streaming/24.3/manage/security/authentication').latest).toBe(false)
  })

  test('maps start-page aliases to the target page coordinates', () => {
    expect(urls.get('/connect')).toMatchObject({ component: 'connect', module: 'home', relative: 'index.adoc' })
    expect(urls.get('/')).toMatchObject({ component: 'home', module: 'ROOT', relative: 'index.adoc' })
  })

  test('ignores splat aliases and records component latest versions', () => {
    expect(urls.has('/streaming/25.3')).toBe(false)
    expect(components).toEqual({
      streaming: { latestVersion: '25.3' },
      connect: { latestVersion: '' },
      home: { latestVersion: '' },
      ROOT: { latestVersion: '25.3' },
    })
  })
})

describe('convertContent', () => {
  test('converts the docs#1830 legacy cross-component URL', () => {
    const { content, converted } = convert(
      'See https://docs.redpanda.com/redpanda-connect/configuration/secrets/ for details.'
    )
    expect(content).toBe('See xref:connect:configuration:secrets.adoc[] for details.')
    expect(converted).toBe(1)
  })

  test.each([
    ['current slug', 'https://docs.redpanda.com/connect/configuration/secrets/'],
    ['no trailing slash', 'https://docs.redpanda.com/connect/configuration/secrets'],
    ['index.html suffix', 'https://docs.redpanda.com/connect/configuration/secrets/index.html'],
  ])('converts %s variants to the same xref', (_, url) => {
    expect(convert(url).content).toBe('xref:connect:configuration:secrets.adoc[]')
  })

  test('converts deep paths', () => {
    expect(convert('https://docs.redpanda.com/connect/components/inputs/kafka/').content).toBe(
      'xref:connect:components:inputs/kafka.adoc[]'
    )
  })

  test('emits unversioned xrefs for latest-version targets', () => {
    expect(
      convert('https://docs.redpanda.com/streaming/current/manage/kubernetes/manage-resources/').content
    ).toBe('xref:streaming:manage:kubernetes/manage-resources.adoc[]')
  })

  test.each([
    ['unprefixed current', 'https://docs.redpanda.com/current/manage/kubernetes/manage-resources/'],
    ['docs prefix', 'https://docs.redpanda.com/docs/manage/kubernetes/manage-resources/'],
    ['explicit latest version', 'https://docs.redpanda.com/streaming/25.3/manage/kubernetes/manage-resources/'],
    ['unprefixed explicit latest', 'https://docs.redpanda.com/25.3/manage/kubernetes/manage-resources/'],
  ])('resolves legacy URL shape (%s) against the catalog', (_, url) => {
    expect(convert(url).content).toBe('xref:streaming:manage:kubernetes/manage-resources.adoc[]')
  })

  test('emits version-pinned xrefs for non-latest targets', () => {
    expect(convert('https://docs.redpanda.com/streaming/24.3/manage/security/authentication/').content).toBe(
      'xref:24.3@streaming:manage:security/authentication.adoc[]'
    )
    expect(convert('https://docs.redpanda.com/24.3/manage/security/authentication/').content).toBe(
      'xref:24.3@streaming:manage:security/authentication.adoc[]'
    )
  })

  test('converts component landing and site root URLs via start-page aliases', () => {
    expect(convert('https://docs.redpanda.com/connect/').content).toBe('xref:connect:home:index.adoc[]')
    expect(convert('https://docs.redpanda.com/redpanda-connect/').content).toBe('xref:connect:home:index.adoc[]')
    expect(convert('https://docs.redpanda.com/').content).toBe('xref:home:ROOT:index.adoc[]')
  })

  test('preserves fragments and labels', () => {
    const url =
      'https://docs.redpanda.com/streaming/current/reference/properties/cluster-properties/#kafka_batch_max_bytes'
    expect(convert(`${url}[Batch size]`).content).toBe(
      'xref:streaming:reference:properties/cluster-properties.adoc#kafka_batch_max_bytes[Batch size]'
    )
    expect(convert(url).content).toBe(
      'xref:streaming:reference:properties/cluster-properties.adoc#kafka_batch_max_bytes[]'
    )
  })

  test('replaces a link: macro wholesale', () => {
    expect(convert('link:https://docs.redpanda.com/connect/configuration/secrets/[Secrets]').content).toBe(
      'xref:connect:configuration:secrets.adoc[Secrets]'
    )
  })

  test('leaves unmapped internal URLs untouched and reports them', () => {
    const input = 'See https://docs.redpanda.com/no/such/page/ here.'
    const { content, converted, unmapped } = convert(input)
    expect(content).toBe(input)
    expect(converted).toBe(0)
    expect(unmapped).toEqual(['https://docs.redpanda.com/no/such/page/'])
  })

  test('resolves symbolic-segment URLs in builds that publish real version numbers', () => {
    // Preview builds have no latest_version_segment, so /current/... URLs
    // must resolve against the latest version's real URL, including for a
    // ROOT component whose name is dropped from URLs.
    expect(convert('https://docs.redpanda.com/current/get-started/quick-start/').content).toBe(
      'xref:ROOT:get-started:quick-start.adoc[]'
    )
    expect(convert('https://docs.redpanda.com/docs/get-started/quick-start/').content).toBe(
      'xref:ROOT:get-started:quick-start.adoc[]'
    )
  })

  test('leaves macro attribute values untouched', () => {
    const input = 'image:diagram.png[Alt,link=https://docs.redpanda.com/connect/configuration/secrets/]'
    const { content, converted, unmapped } = convert(input)
    expect(content).toBe(input)
    expect(converted).toBe(0)
    expect(unmapped).toEqual([])
  })

  test('leaves ignored paths untouched without reporting them', () => {
    const input = 'API: https://docs.redpanda.com/api/doc/cloud-dataplane/operation/listquotas'
    const { content, unmapped } = convert(input)
    expect(content).toBe(input)
    expect(unmapped).toEqual([])
  })

  test('leaves external hostnames, code blocks, and attribute entries untouched', () => {
    const input = [
      ':url-x: https://docs.redpanda.com/connect/configuration/secrets/',
      '',
      'External https://example.com/page stays.',
      '----',
      'curl https://docs.redpanda.com/connect/configuration/secrets/',
      '----',
    ].join('\n')
    const { content, converted } = convert(input)
    expect(content).toBe(input)
    expect(converted).toBe(0)
  })

  test('converts multiple URLs in one document', () => {
    const input =
      'A https://docs.redpanda.com/connect/configuration/secrets/ B https://docs.redpanda.com/connect/components/inputs/kafka/[Kafka] C'
    expect(convert(input).content).toBe(
      'A xref:connect:configuration:secrets.adoc[] B xref:connect:components:inputs/kafka.adoc[Kafka] C'
    )
  })
})

describe('register', () => {
  function run (catalog, config = {}) {
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const context = {
      getLogger: () => logger,
      on: jest.fn((event, handler) => {
        if (event === 'contentClassified') {
          handler({ playbook: { urls: { latestVersionSegment: 'current' } }, contentCatalog: catalog })
        }
      }),
    }
    extension.register.call(context, { config })
    return logger
  }

  test('rewrites page and partial contents and logs a summary', () => {
    const catalog = makeCatalog()
    catalog.pages[0].contents = Buffer.from(
      'Link to https://docs.redpanda.com/connect/configuration/secrets/ here.'
    )
    catalog.partials.push({
      src: { family: 'partial' },
      path: 'modules/reference/partials/props.adoc',
      contents: Buffer.from('See https://docs.redpanda.com/connect/components/inputs/kafka/.'),
    })
    const logger = run(catalog)
    expect(catalog.pages[0].contents.toString()).toBe(
      'Link to xref:connect:configuration:secrets.adoc[] here.'
    )
    expect(catalog.partials[0].contents.toString()).toBe(
      'See xref:connect:components:inputs/kafka.adoc[].'
    )
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Converted 2 docs URLs'))
  })

  test('warns for internal URLs that match no published page', () => {
    const catalog = makeCatalog()
    catalog.pages[0].contents = Buffer.from('Broken: https://docs.redpanda.com/gone/page/')
    const logger = run(catalog)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No published page matches https://docs.redpanda.com/gone/page/')
    )
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(catalog.pages[0].path))
  })

  test('honors log_unconverted: false', () => {
    const catalog = makeCatalog()
    catalog.pages[0].contents = Buffer.from('Broken: https://docs.redpanda.com/gone/page/')
    const logger = run(catalog, { logUnconverted: false })
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
