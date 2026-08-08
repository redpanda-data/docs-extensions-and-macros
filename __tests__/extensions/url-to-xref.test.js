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
      contents: '= Cluster Configuration Properties\n\n=== kafka_batch_max_bytes\n\nA property.\n',
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
    expect(urls.get('/streaming/current/manage/kubernetes/manage-resources')).toMatchObject({
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
  })

  // An xref with a fragment and no link text renders the raw resource id, so
  // the extension has to supply text of its own.
  test('labels an unlabeled fragment URL with the heading it points at', () => {
    expect(
      convert('https://docs.redpanda.com/streaming/current/reference/properties/cluster-properties/#kafka_batch_max_bytes')
        .content
    ).toBe(
      'xref:streaming:reference:properties/cluster-properties.adoc#kafka_batch_max_bytes[kafka_batch_max_bytes]'
    )
  })

  test('falls back to the page title when the fragment matches no heading', () => {
    expect(
      convert('https://docs.redpanda.com/streaming/current/reference/properties/cluster-properties/#no-such-anchor')
        .content
    ).toBe(
      'xref:streaming:reference:properties/cluster-properties.adoc#no-such-anchor[Cluster Configuration Properties]'
    )
  })

  test('resolves link text from a heading in an included partial', () => {
    const page = makePage({
      component: 'streaming',
      version: '25.3',
      module: 'reference',
      relative: 'properties/broker-properties.adoc',
      url: '/streaming/current/reference/properties/broker-properties/',
      contents: '= Broker Configuration Properties\n\ninclude::reference:partial$properties/broker.adoc[tags=redpanda]\n',
    })
    const partial = { contents: Buffer.from('=== crash_loop_limit\n\nA property.\n') }
    const context = Object.assign(
      buildUrlMap({
        getComponents: () => [{ name: 'streaming', latest: { version: '25.3' } }],
        getPages: (filter) => (filter ? [page].filter(filter) : [page]),
        findBy: () => [],
      }),
      {
        hostnames: new Set(['docs.redpanda.com']),
        ignore: [],
        latestVersionSegment: 'current',
        resolveInclude: (spec) => (spec === 'reference:partial$properties/broker.adoc' ? partial : undefined),
      }
    )
    expect(
      convertContent(
        'https://docs.redpanda.com/streaming/current/reference/properties/broker-properties/#crash_loop_limit',
        context
      ).content
    ).toBe('xref:streaming:reference:properties/broker-properties.adoc#crash_loop_limit[crash_loop_limit]')
  })

  test('leaves a fragment URL raw when the target yields no link text', () => {
    // The manage-resources fixture page has no contents to read a title from.
    const url = 'https://docs.redpanda.com/streaming/current/manage/kubernetes/manage-resources/#anything'
    const { content, converted, withoutLinkText } = convert(url)
    expect(content).toBe(url)
    expect(converted).toBe(0)
    expect(withoutLinkText).toEqual([url])
  })

  test('keeps an unlabeled URL without a fragment as xref:...[] for Antora to title', () => {
    expect(convert('https://docs.redpanda.com/connect/configuration/secrets/').content).toBe(
      'xref:connect:configuration:secrets.adoc[]'
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

  test('resolves component-prefixed symbolic-segment URLs against real version numbers', () => {
    // The preview site publishes the versioned streaming component under its
    // real version, so live-site /streaming/current/... URLs have to fall back
    // to the component's latest version.
    const page = makePage({
      component: 'streaming',
      version: '26.2',
      module: 'get-started',
      relative: 'quick-start.adoc',
      url: '/streaming/26.2/get-started/quick-start/',
    })
    const previewContext = Object.assign(
      buildUrlMap({
        getComponents: () => [{ name: 'streaming', latest: { version: '26.2' } }],
        getPages: (filter) => (filter ? [page].filter(filter) : [page]),
        findBy: () => [],
      }),
      { hostnames: new Set(['docs.redpanda.com']), ignore: [], latestVersionSegment: 'current' }
    )
    expect(
      convertContent('https://docs.redpanda.com/streaming/current/get-started/quick-start/', previewContext).content
    ).toBe('xref:streaming:get-started:quick-start.adoc[]')
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

  test('leaves URLs that carry a query string as raw links', () => {
    // An xref cannot express ?platform=kubernetes, which the docs UI reads to
    // preselect a tab, so the raw URL is kept instead of converted lossily.
    // This shape appears in the generated Helm specs in the docs repo.
    const input = 'https://docs.redpanda.com/connect/configuration/secrets/?platform=kubernetes#store[Licenses]'
    const { content, converted, unmapped, withQueryString } = convert(input)
    expect(content).toBe(input)
    expect(converted).toBe(0)
    expect(unmapped).toEqual([])
    expect(withQueryString).toEqual([
      'https://docs.redpanda.com/connect/configuration/secrets/?platform=kubernetes#store',
    ])
  })

  test('converts multiple URLs in one document', () => {
    const input =
      'A https://docs.redpanda.com/connect/configuration/secrets/ B https://docs.redpanda.com/connect/components/inputs/kafka/[Kafka] C'
    expect(convert(input).content).toBe(
      'A xref:connect:configuration:secrets.adoc[] B xref:connect:components:inputs/kafka.adoc[Kafka] C'
    )
  })
})

// The generated Helm and CRD specs in redpanda-data/docs carry raw
// docs.redpanda.com URLs, now that doc-tools no longer rewrites them at
// generation time. Most use the pre-umbrella /docs/... shape and point at
// pages that have since been renamed, so they only resolve through the
// page-aliases those pages declare.
describe('buildUrlMap page-aliases', () => {
  function mapFor (contents, src = {}) {
    const page = makePage(
      Object.assign(
        {
          component: 'streaming',
          version: '26.2',
          module: 'manage',
          relative: 'kubernetes/k-manage-resources.adoc',
          url: '/streaming/26.2/manage/kubernetes/k-manage-resources/',
        },
        src,
        { contents }
      )
    )
    return buildUrlMap({
      getComponents: () => [{ name: 'streaming', latest: { version: '26.2' } }],
      getPages: (filter) => (filter ? [page].filter(filter) : [page]),
      findBy: () => [],
    }).urls
  }

  test('maps a same-module alias', () => {
    const urls = mapFor('= T\n:page-aliases: kubernetes/manage-resources.adoc\n')
    expect(urls.get('/streaming/26.2/manage/kubernetes/manage-resources')).toMatchObject({
      relative: 'kubernetes/k-manage-resources.adoc',
    })
  })

  test('maps a module-qualified alias, a bare alias, and one without the file extension', () => {
    const urls = mapFor('= T\n:page-aliases: reference:old-spec.adoc, other.adoc, reference:no-extension\n')
    expect(urls.has('/streaming/26.2/reference/old-spec')).toBe(true)
    expect(urls.has('/streaming/26.2/manage/other')).toBe(true)
    expect(urls.has('/streaming/26.2/reference/no-extension')).toBe(true)
  })

  test('maps aliases listed across continuation lines', () => {
    const urls = mapFor('= T\n:page-aliases: kubernetes/manage-resources.adoc, \\\nkubernetes/old-resources.adoc\n')
    expect(urls.has('/streaming/26.2/manage/kubernetes/manage-resources')).toBe(true)
    expect(urls.has('/streaming/26.2/manage/kubernetes/old-resources')).toBe(true)
  })

  test('maps a ROOT-module alias without a module segment', () => {
    const urls = mapFor('= T\n:page-aliases: ROOT:legacy.adoc\n')
    expect(urls.has('/streaming/26.2/legacy')).toBe(true)
  })

  test('maps aliases of an index page against the module root', () => {
    const urls = mapFor('= T\n:page-aliases: home/old-index.adoc\n', {
      module: 'home',
      relative: 'index.adoc',
      url: '/streaming/26.2/home/',
    })
    expect(urls.has('/streaming/26.2/home/home/old-index')).toBe(true)
  })

  test('ignores aliases that name another component or version', () => {
    const urls = mapFor('= T\n:page-aliases: connect:configuration:secrets.adoc, 24.3@manage:old.adoc\n')
    expect(urls.size).toBe(1)
  })

  test('never lets an alias shadow a real page', () => {
    const real = makePage({
      component: 'streaming',
      version: '26.2',
      module: 'manage',
      relative: 'kubernetes/manage-resources.adoc',
      url: '/streaming/26.2/manage/kubernetes/manage-resources/',
    })
    const aliasing = makePage({
      component: 'streaming',
      version: '26.2',
      module: 'manage',
      relative: 'kubernetes/k-manage-resources.adoc',
      url: '/streaming/26.2/manage/kubernetes/k-manage-resources/',
      contents: '= T\n:page-aliases: kubernetes/manage-resources.adoc\n',
    })
    const pages = [real, aliasing]
    const { urls } = buildUrlMap({
      getComponents: () => [{ name: 'streaming', latest: { version: '26.2' } }],
      getPages: (filter) => (filter ? pages.filter(filter) : pages),
      findBy: () => [],
    })
    expect(urls.get('/streaming/26.2/manage/kubernetes/manage-resources')).toMatchObject({
      relative: 'kubernetes/manage-resources.adoc',
    })
  })
})

describe('generated Helm spec URLs', () => {
  function makeHelmSpecContext () {
    const manageResources = makePage({
      component: 'streaming',
      version: '26.2',
      module: 'manage',
      relative: 'kubernetes/k-manage-resources.adoc',
      url: '/streaming/current/manage/kubernetes/k-manage-resources/',
    })
    const clusterProperties = makePage({
      component: 'streaming',
      version: '26.2',
      module: 'reference',
      relative: 'properties/cluster-properties.adoc',
      url: '/streaming/current/reference/properties/cluster-properties/',
    })
    const pages = [manageResources, clusterProperties]
    // The aliases these pages declare in the docs repo today. Antora has not
    // turned them into catalog alias files yet at contentClassified, so the
    // extension has to read them from the page header.
    manageResources.contents = Buffer.from(
      '= Manage Pod Resources\n' +
        ':page-aliases: manage:kubernetes/manage-resources.adoc\n' +
        '\n== Configure CPU resources\n\nHow to configure CPU.\n'
    )
    clusterProperties.contents = Buffer.from(
      '= Cluster Configuration Properties\n' +
        ':page-aliases: reference:tunable-properties.adoc, reference:cluster-properties.adoc\n' +
        '\n=== log_segment_size_min\n\nA property.\n'
    )
    return Object.assign(
      buildUrlMap({
        getComponents: () => [{ name: 'streaming', latest: { version: '26.2' } }],
        getPages: (filter) => (filter ? pages.filter(filter) : pages),
        findBy: () => [],
      }),
      { hostnames: new Set(['docs.redpanda.com']), ignore: [/^\/api\//], latestVersionSegment: 'current' }
    )
  }

  test.each([
    [
      'https://docs.redpanda.com/docs/manage/kubernetes/manage-resources/#configure-cpu-resources',
      'xref:streaming:manage:kubernetes/k-manage-resources.adoc#configure-cpu-resources[Configure CPU resources]',
    ],
    [
      'https://docs.redpanda.com/current/manage/kubernetes/manage-resources/',
      'xref:streaming:manage:kubernetes/k-manage-resources.adoc[]',
    ],
    [
      'https://docs.redpanda.com/docs/reference/cluster-properties/#log_segment_size_min',
      'xref:streaming:reference:properties/cluster-properties.adoc#log_segment_size_min[log_segment_size_min]',
    ],
    [
      'https://docs.redpanda.com/docs/reference/tunable-properties/',
      'xref:streaming:reference:properties/cluster-properties.adoc[]',
    ],
  ])('converts %s through the target page alias', (url, expected) => {
    expect(convertContent(url, makeHelmSpecContext()).content).toBe(expected)
  })

  // The generated specs wrap long lines, so nearly every link label in them
  // opens on one line and closes on the next.
  test('captures a link label that the generator wrapped across a line break', () => {
    const input =
      'For details, see the\n' +
      'https://docs.redpanda.com/docs/manage/kubernetes/manage-resources/#configure-cpu-resources[CPU\n' +
      'documentation].\n'
    const { content, converted } = convertContent(input, makeHelmSpecContext())
    expect(content).toBe(
      'For details, see the\n' +
        'xref:streaming:manage:kubernetes/k-manage-resources.adoc#configure-cpu-resources[CPU documentation].\n'
    )
    expect(converted).toBe(1)
  })

  test('reports a Helm spec URL whose target no longer exists at any path', () => {
    const url = 'https://docs.redpanda.com/docs/cluster-administration/configuration/'
    const { content, unmapped } = convertContent(url, makeHelmSpecContext())
    expect(content).toBe(url)
    expect(unmapped).toEqual([url])
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
