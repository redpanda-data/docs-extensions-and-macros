'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const checker = require('../../extensions/external-link-checker')
const { checkUrl, collectExternalUrls, repoSlug } = checker

function makeCatalog (pages, partials = [], components) {
  const catalog = {
    getPages: (filter) => (filter ? pages.filter(filter) : pages),
    findBy: ({ family }) => (family === 'partial' ? partials : []),
  }
  if (components) catalog.getComponents = () => components
  return catalog
}

function makePage (path, contents, src = {}) {
  return { out: {}, path, contents: Buffer.from(contents), src: { family: 'page', ...src } }
}

function response (status) {
  return Promise.resolve({ status })
}

describe('collectExternalUrls', () => {
  const options = { internalHostnames: new Set(['docs.redpanda.com']), include: [], exclude: [] }

  test('collects external URLs with page attribution, skipping internal hostnames', () => {
    const catalog = makeCatalog([
      makePage('a.adoc', 'See https://example.com/x and https://docs.redpanda.com/internal/'),
      makePage('b.adoc', 'Also https://example.com/x here'),
    ])
    const { urlReferences } = collectExternalUrls(catalog, options)
    expect([...urlReferences.keys()]).toEqual(['https://example.com/x'])
    expect([...urlReferences.get('https://example.com/x').keys()]).toEqual(['a.adoc', 'b.adoc'])
  })

  test('applies include and exclude filters', () => {
    const catalog = makeCatalog([
      makePage('a.adoc', 'https://one.example/x https://two.example/y https://two.example/skip'),
    ])
    const { urlReferences } = collectExternalUrls(catalog, {
      internalHostnames: new Set(),
      include: [/two\.example/],
      exclude: [/skip/],
    })
    expect([...urlReferences.keys()]).toEqual(['https://two.example/y'])
  })

  test('scans partials too', () => {
    const catalog = makeCatalog(
      [],
      [{ path: 'p.adoc', contents: Buffer.from('https://example.com/from-partial'), src: { family: 'partial' } }]
    )
    const { urlReferences } = collectExternalUrls(catalog, options)
    expect([...urlReferences.keys()]).toEqual(['https://example.com/from-partial'])
  })

  // A path alone is ambiguous: an aggregated site builds the same
  // 'modules/reference/pages/x.adoc' from several repositories and many
  // version branches, so a report carrying only the path cannot tell anything
  // downstream which one to open a pull request against.
  test('attributes a URL to its repository, branch, and start path', () => {
    const catalog = makeCatalog([
      makePage('modules/ROOT/pages/how-to.adoc', 'https://example.com/x', {
        component: 'home',
        version: '',
        origin: {
          url: 'https://github.com/redpanda-data/docs-site.git',
          refname: 'main',
          startPath: 'home',
        },
      }),
    ])
    const { urlReferences } = collectExternalUrls(catalog, options)
    const refs = urlReferences.get('https://example.com/x')
    expect([...refs.keys()]).toEqual(['redpanda-data/docs-site@main:home/modules/ROOT/pages/how-to.adoc'])
    expect([...refs.values()]).toEqual([
      {
        repo: 'redpanda-data/docs-site',
        refname: 'main',
        component: 'home',
        version: '',
        path: 'home/modules/ROOT/pages/how-to.adoc',
      },
    ])
  })

  test.each([
    ['https://github.com/redpanda-data/docs.git', 'redpanda-data/docs'],
    ['https://github.com/redpanda-data/docs', 'redpanda-data/docs'],
    ['git@github.com:redpanda-data/cloud-docs.git', 'redpanda-data/cloud-docs'],
    ['', ''],
    [undefined, ''],
  ])('derives the repository slug from %s', (url, expected) => {
    expect(repoSlug(url)).toBe(expected)
  })

  describe('version scoping', () => {
    const components = [{ name: 'ROOT', latest: { version: '26.2' } }]
    const pages = [
      makePage('a.adoc', 'https://example.com/latest-only', { component: 'ROOT', version: '26.2' }),
      makePage('a.adoc', 'https://example.com/frozen-only', { component: 'ROOT', version: '24.2' }),
      makePage('u.adoc', 'https://example.com/unversioned', { component: 'labs', version: '' }),
    ]

    // Frozen version branches republish the same dead link once per branch,
    // and nobody edits them, so checking them fills the report with findings
    // that cannot be acted on.
    test('skips non-latest versions by default', () => {
      const { urlReferences } = collectExternalUrls(makeCatalog(pages, [], components), {
        ...options,
        versions: 'latest',
      })
      expect([...urlReferences.keys()].sort()).toEqual([
        'https://example.com/latest-only',
        'https://example.com/unversioned',
      ])
    })

    test('checks every version with versions: all', () => {
      const { urlReferences } = collectExternalUrls(makeCatalog(pages, [], components), {
        ...options,
        versions: 'all',
      })
      expect([...urlReferences.keys()].sort()).toEqual([
        'https://example.com/frozen-only',
        'https://example.com/latest-only',
        'https://example.com/unversioned',
      ])
    })

    test('checks everything when the catalog cannot report components', () => {
      const { urlReferences } = collectExternalUrls(makeCatalog(pages), { ...options, versions: 'latest' })
      expect([...urlReferences.keys()]).toContain('https://example.com/frozen-only')
    })
  })

  // These render fine once Asciidoctor substitutes the attribute; this hook
  // runs before that, so fetching the literal braces reports a false 404.
  test('separates URLs holding an unresolved attribute reference', () => {
    const catalog = makeCatalog([
      makePage('a.adoc', 'https://github.com/{project-github}/issues/399[Related issue^] and https://example.com/x'),
    ])
    const { urlReferences, unresolved } = collectExternalUrls(catalog, options)
    expect([...urlReferences.keys()]).toEqual(['https://example.com/x'])
    expect([...unresolved.keys()]).toEqual(['https://github.com/{project-github}/issues/399'])
  })
})

// Every string here is a real entry from docs-site#211 that the checker
// reported as a broken link while the published page carried no such link.
describe('report noise from the weekly link check', () => {
  const options = { internalHostnames: new Set(['docs.redpanda.com']), include: [], exclude: [] }

  test.each([
    [
      'a shell fence with a language info string',
      '```bash\ncurl -LO https://github.com/redpanda-data/redpanda/releases/download/v<version>/rpk-darwin-amd64.zip\n```',
    ],
    ['a yml fence holding a config default', '```yml\n  base_url: https://api.cohere.com\n```'],
    [
      'a generator provenance comment',
      '// This content is autogenerated. To customize content, see the writer\'s guide: ' +
        'https://github.com/redpanda-data/docs/blob/main/docs-data/RPK_OVERRIDES_GUIDE.adoc',
    ],
    [
      'a Doc Detective test step in a comment',
      '// (step {"runShell": {"command": "helm repo add jetstack https://charts.jetstack.io\\nhelm repo update"}})',
    ],
    ['an editorial note in a comment block', '////\nSee https://github.com/redpanda-data/adp-docs/pull/227\n////'],
  ])('reports nothing for %s', (_, contents) => {
    const { urlReferences } = collectExternalUrls(makeCatalog([makePage('a.adoc', contents)]), options)
    expect([...urlReferences.keys()]).toEqual([])
  })

  test('still reports a real link on the line after a fence closes', () => {
    const contents = '```bash\ncurl https://example.com/in-fence\n```\n\nSee https://example.com/in-prose.'
    const { urlReferences } = collectExternalUrls(makeCatalog([makePage('a.adoc', contents)]), options)
    expect([...urlReferences.keys()]).toEqual(['https://example.com/in-prose'])
  })
})

describe('checkUrl', () => {
  test.each([
    [200, 'ok'],
    [301, 'ok'],
    [404, 'broken'],
    [410, 'broken'],
    [403, 'unverifiable'],
    [429, 'unverifiable'],
    [500, 'unverifiable'],
  ])('classifies HTTP %i as %s', async (status, classification) => {
    const fetchFn = jest.fn(() => response(status))
    await expect(checkUrl('https://example.com/', { timeout: 1000, fetchFn })).resolves.toMatchObject({
      classification,
      status,
    })
  })

  test.each([405, 404, 403])('falls back to GET when HEAD returns %i', async (headStatus) => {
    const fetchFn = jest.fn((url, { method }) => response(method === 'HEAD' ? headStatus : 200))
    const verdict = await checkUrl('https://example.com/', { timeout: 1000, fetchFn })
    expect(verdict).toMatchObject({ classification: 'ok', status: 200 })
    expect(fetchFn.mock.calls.map(([, { method }]) => method)).toEqual(['HEAD', 'GET'])
  })

  test('retries GET once after network errors, then reports unverifiable', async () => {
    const fetchFn = jest.fn(() => Promise.reject(new Error('socket hang up')))
    const verdict = await checkUrl('https://example.com/', { timeout: 1000, fetchFn })
    expect(verdict).toMatchObject({ classification: 'unverifiable', status: null, reason: 'socket hang up' })
    expect(fetchFn).toHaveBeenCalledTimes(3) // HEAD, GET, GET retry
  })

  test('recovers when only the retry succeeds', async () => {
    const fetchFn = jest
      .fn()
      .mockRejectedValueOnce(new Error('reset'))
      .mockRejectedValueOnce(new Error('reset'))
      .mockImplementationOnce(() => response(200))
    await expect(checkUrl('https://example.com/', { timeout: 1000, fetchFn })).resolves.toMatchObject({
      classification: 'ok',
    })
  })
})

describe('register', () => {
  let originalFetch

  beforeEach(() => {
    originalFetch = checker._fetch
  })

  afterEach(() => {
    checker._fetch = originalFetch
  })

  async function run (catalog, config = {}) {
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    let handlerPromise
    const context = {
      getLogger: () => logger,
      on: jest.fn((event, handler) => {
        if (event === 'contentClassified') handlerPromise = handler({ contentCatalog: catalog })
      }),
    }
    checker.register.call(context, { config })
    await handlerPromise
    return logger
  }

  test('warns for broken links with referencing pages and logs a summary', async () => {
    checker._fetch = jest.fn((url) => response(url.includes('missing') ? 404 : 200))
    const catalog = makeCatalog([
      makePage('a.adoc', 'https://example.com/ok and https://example.com/missing'),
    ])
    const logger = await run(catalog)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Broken external link https://example.com/missing (HTTP 404) referenced in: a.adoc')
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Checked 2 external links: 1 ok, 1 broken, 0 unverifiable')
    )
  })

  test('escalates broken links to error level with fail_on_broken', async () => {
    checker._fetch = jest.fn(() => response(404))
    const catalog = makeCatalog([makePage('a.adoc', 'https://example.com/missing')])
    const logger = await run(catalog, { failOnBroken: true })
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Broken external link'))
    expect(logger.warn).not.toHaveBeenCalled()
  })

  test('logs bot-walled responses at info level', async () => {
    checker._fetch = jest.fn(() => response(403))
    const catalog = makeCatalog([makePage('a.adoc', 'https://example.com/walled')])
    const logger = await run(catalog)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Could not verify external link'))
    expect(logger.warn).not.toHaveBeenCalled()
  })

  test('does nothing when no external URLs exist', async () => {
    checker._fetch = jest.fn()
    const catalog = makeCatalog([makePage('a.adoc', 'Only https://docs.redpanda.com/internal/ links')])
    const logger = await run(catalog)
    expect(checker._fetch).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
  })
})
