'use strict'

const checker = require('../../extensions/external-link-checker')
const { checkUrl, collectExternalUrls } = checker

function makeCatalog (pages, partials = []) {
  return {
    getPages: (filter) => (filter ? pages.filter(filter) : pages),
    findBy: ({ family }) => (family === 'partial' ? partials : []),
  }
}

function makePage (path, contents) {
  return { out: {}, path, contents: Buffer.from(contents), src: { family: 'page' } }
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
    const refs = collectExternalUrls(catalog, options)
    expect([...refs.keys()]).toEqual(['https://example.com/x'])
    expect([...refs.get('https://example.com/x')]).toEqual(['a.adoc', 'b.adoc'])
  })

  test('applies include and exclude filters', () => {
    const catalog = makeCatalog([
      makePage('a.adoc', 'https://one.example/x https://two.example/y https://two.example/skip'),
    ])
    const refs = collectExternalUrls(catalog, {
      internalHostnames: new Set(),
      include: [/two\.example/],
      exclude: [/skip/],
    })
    expect([...refs.keys()]).toEqual(['https://two.example/y'])
  })

  test('scans partials too', () => {
    const catalog = makeCatalog(
      [],
      [{ path: 'p.adoc', contents: Buffer.from('https://example.com/from-partial'), src: { family: 'partial' } }]
    )
    const refs = collectExternalUrls(catalog, options)
    expect([...refs.keys()]).toEqual(['https://example.com/from-partial'])
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

  test('falls back to GET when HEAD returns 405', async () => {
    const fetchFn = jest.fn((url, { method }) => response(method === 'HEAD' ? 405 : 200))
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
