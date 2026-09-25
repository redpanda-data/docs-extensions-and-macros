/**
 * @jest-environment node
 */

const { componentsWithExports } = require('../../extension-utils/llms-utils')

describe('componentsWithExports', () => {
  const components = [
    { name: 'streaming', title: 'Redpanda Streaming' },
    { name: 'data-platform', title: 'Data Platform' },
    { name: 'self-managed', title: 'Self-Managed' },
    { name: 'search', title: 'search' },
    { name: 'connect', title: 'Redpanda Connect' },
  ]

  it('returns only components that have at least one page', () => {
    const pages = [
      { src: { component: 'streaming' } },
      { src: { component: 'connect' } },
      { src: { component: 'streaming' } },
    ]
    expect(componentsWithExports(components, pages).map((c) => c.name)).toEqual([
      'streaming',
      'connect',
    ])
  })

  it('excludes corpus-less components so we never advertise a 404 export', () => {
    // data-platform / self-managed / search are landing/utility components with
    // no doc pages, so no `<name>-full.txt` file is generated for them.
    const pages = [{ src: { component: 'streaming' } }]
    const names = componentsWithExports(components, pages).map((c) => c.name)
    expect(names).not.toContain('data-platform')
    expect(names).not.toContain('self-managed')
    expect(names).not.toContain('search')
  })

  it('returns an empty array when there are no pages', () => {
    expect(componentsWithExports(components, [])).toEqual([])
  })

  it('ignores pages with missing src or component', () => {
    const pages = [{ src: { component: 'streaming' } }, {}, { src: {} }]
    expect(componentsWithExports(components, pages).map((c) => c.name)).toEqual([
      'streaming',
    ])
  })

  it('preserves the input component order', () => {
    const pages = [
      { src: { component: 'connect' } },
      { src: { component: 'streaming' } },
    ]
    expect(componentsWithExports(components, pages).map((c) => c.name)).toEqual([
      'streaming',
      'connect',
    ])
  })
})

describe('buildPageIndexes', () => {
  const { buildPageIndexes, renderPageIndexSection } = require('../../extension-utils/llms-utils')
  const { toMarkdownUrl } = require('../../extension-utils/url-utils')
  const siteUrl = 'https://docs.example.com'

  const components = [
    {
      name: 'streaming',
      title: 'Redpanda Streaming',
      latest: { version: '26.2', displayVersion: '26.2' },
      versions: [
        { version: '26.2', displayVersion: '26.2' },
        { version: '26.1', displayVersion: '26.1' },
      ],
    },
    {
      name: 'connect',
      title: 'Redpanda Connect',
      latest: { version: 'master', displayVersion: 'master' },
      versions: [{ version: 'master', displayVersion: 'master' }],
    },
  ]

  // Mirrors how Antora derives URLs: <version root>/<module unless ROOT>/<relative>/
  const page = (component, version, url, title, extra = {}) => {
    const root = component === 'connect' ? '/connect/' : `/${url.split('/')[1]}/${url.split('/')[2]}/`
    const [moduleName, ...rest] = url.slice(root.length).replace(/\/$/, '').split('/')
    return {
    src: { component, version, module: moduleName, relative: `${rest.join('/')}.adoc`, stem: url.split('/').filter(Boolean).pop() },
    pub: { url },
    out: { path: url },
    asciidoc: { doctitle: title, attributes: extra },
    }
  }

  const pages = [
    page('streaming', '26.2', '/streaming/current/manage/tiered-storage/', 'Tiered Storage', { description: 'Offload data to object storage.' }),
    page('streaming', '26.2', '/streaming/current/deploy/kubernetes/', 'Deploy on [K8s]'),
    page('streaming', '26.1', '/streaming/26.1/manage/tiered-storage/', 'Tiered Storage'),
    page('connect', 'master', '/connect/components/inputs/kafka/', 'kafka'),
    page('connect', 'master', '/connect/guides/bloblang/', 'Bloblang'),
  ]

  it('derives the version root from the module and relative path, even when every page shares a deeper directory', () => {
    const only = [page('streaming', '26.1', '/streaming/26.1/manage/tiered-storage/', 'Tiered Storage')]
    const [index] = buildPageIndexes({ pages: only, components, siteUrl, toMarkdownUrl })
    expect(index.path).toBe('streaming/26.1/llms.txt')
    const rootPage = {
      src: { component: 'streaming', version: '26.1', module: 'ROOT', relative: 'index.adoc', stem: 'index' },
      pub: { url: '/streaming/26.1/' }, out: {}, asciidoc: { doctitle: 'Home' },
    }
    expect(buildPageIndexes({ pages: [rootPage], components, siteUrl, toMarkdownUrl })[0].path).toBe('streaming/26.1/llms.txt')
  })

  it('writes one index per component version at the version root, including older versions', () => {
    const indexes = buildPageIndexes({ pages, components, siteUrl, toMarkdownUrl })
    expect(indexes.map((i) => i.path)).toEqual([
      'connect/llms.txt',
      'streaming/current/llms.txt',
      'streaming/26.1/llms.txt',
    ])
    expect(indexes.reduce((n, i) => n + i.pageCount, 0)).toBe(pages.length)
  })

  it('lists every page as a markdown link to its .md URL with its description', () => {
    const [, current] = buildPageIndexes({ pages, components, siteUrl, toMarkdownUrl })
    expect(current.contents).toContain(
      '- [Tiered Storage](https://docs.example.com/streaming/current/manage/tiered-storage.md): Offload data to object storage.'
    )
    // Brackets in titles are escaped so the link parses.
    expect(current.contents).toContain('- [Deploy on \\[K8s\\]](https://docs.example.com/streaming/current/deploy/kubernetes.md)')
    expect(current.contents).not.toMatch(/\]\([^)]*\.txt\)/)
  })

  it('marks older versions and points to the latest', () => {
    const older = buildPageIndexes({ pages, components, siteUrl, toMarkdownUrl }).find((i) => i.version === '26.1')
    expect(older.isLatest).toBe(false)
    expect(older.contents).toContain('This is version 26.1. The latest version is 26.2.')
  })

  it('skips pages that are not published', () => {
    const unpublished = { ...page('connect', 'master', '/connect/hidden/', 'Hidden'), out: undefined }
    const indexes = buildPageIndexes({ pages: [...pages, unpublished], components, siteUrl, toMarkdownUrl })
    expect(indexes.find((i) => i.component === 'connect').pageCount).toBe(2)
  })

  describe('when a version is larger than the size limit', () => {
    const many = []
    for (let i = 0; i < 300; i++) many.push(page('connect', 'master', `/connect/components/inputs/input-${i}/`, `Input ${i}`))
    for (let i = 0; i < 300; i++) many.push(page('connect', 'master', `/connect/components/outputs/output-${i}/`, `Output ${i}`))
    many.push(page('connect', 'master', '/connect/about/', 'About'))
    const maxChars = 10000
    const indexes = buildPageIndexes({ pages: many, components, siteUrl, toMarkdownUrl, maxChars })

    it('keeps every file under the limit', () => {
      expect(indexes.length).toBeGreaterThan(2)
      indexes.forEach((index) => expect(index.contents.length).toBeLessThanOrEqual(maxChars))
    })

    it('splits by directory, then into numbered parts, without dropping or repeating pages', () => {
      const paths = indexes.map((i) => i.path)
      expect(paths).toContain('connect/llms.txt')
      expect(paths).toContain('connect/components/inputs/llms.txt')
      expect(paths).toContain('connect/components/inputs/llms-2.txt')
      expect(paths).toContain('connect/components/outputs/llms.txt')
      const linked = indexes.flatMap((i) => i.contents.match(/\]\(https:[^)]+\.md\)/g) || [])
      expect(linked).toHaveLength(many.length)
      expect(new Set(linked).size).toBe(many.length)
    })
  })

  it('keeps small subdirectories in the parent index and only splits out the large ones', () => {
    const mixed = []
    for (let i = 0; i < 300; i++) mixed.push(page('connect', 'master', `/connect/components/inputs/input-${i}/`, `Input ${i}`))
    mixed.push(page('connect', 'master', '/connect/guides/bloblang/', 'Bloblang'))
    mixed.push(page('connect', 'master', '/connect/about/', 'About'))
    const indexes = buildPageIndexes({ pages: mixed, components, siteUrl, toMarkdownUrl, maxChars: 10000 })
    const root = indexes.find((i) => i.path === 'connect/llms.txt')
    expect(root.contents).toContain('/connect/guides/bloblang.md')
    expect(root.contents).toContain('/connect/about.md')
    expect(indexes.map((i) => i.path)).not.toContain('connect/guides/llms.txt')
    expect(indexes.filter((i) => i.path.startsWith('connect/components/inputs/')).length).toBeGreaterThan(1)
  })

  it('renders a root section that links every index, latest first', () => {
    const indexes = buildPageIndexes({ pages, components, siteUrl, toMarkdownUrl })
    const section = renderPageIndexSection(indexes, components)
    indexes.forEach((i) => expect(section).toContain(`](${i.url})`))
    expect(section.indexOf('streaming/current/llms.txt')).toBeLessThan(section.indexOf('Older versions:'))
    expect(section.indexOf('Older versions:')).toBeLessThan(section.indexOf('streaming/26.1/llms.txt'))
  })
})

describe('stripMarkdownMetadata', () => {
  const { stripMarkdownMetadata, formatLlmsDirective } = require('../../extension-utils/llms-utils')

  it('strips the directive when its links were made absolute', () => {
    const page = '> For the complete documentation index, see [llms.txt](https://docs.example.com/llms.txt). Component-specific: [streaming-full.txt](https://docs.example.com/streaming-full.txt)\n\n# Tiered Storage'
    expect(stripMarkdownMetadata(page)).toBe('# Tiered Storage')
  })

  it('still strips the root-relative directive', () => {
    expect(stripMarkdownMetadata(`${formatLlmsDirective('streaming')}\n\nBody`)).toBe('Body')
  })
})

describe('unlinkSelfReferences', () => {
  const { unlinkSelfReferences } = require('../../extension-utils/llms-utils')
  const siteUrl = 'https://docs.example.com'

  it('unlinks absolute and root-relative links to the root llms.txt', () => {
    expect(unlinkSelfReferences('See [this file](https://docs.example.com/llms.txt) or [root](/llms.txt).', siteUrl))
      .toBe('See this file or root.')
  })

  it('leaves links to exports and nested indexes alone', () => {
    const text = '[full](https://docs.example.com/llms-full.txt) [index](https://docs.example.com/streaming/current/llms.txt)'
    expect(unlinkSelfReferences(text, siteUrl)).toBe(text)
  })
})
