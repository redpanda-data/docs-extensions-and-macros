const { describe, it, expect } = require('@jest/globals')
const fetchLatestDockerTag = require('../../../extensions/version-fetcher/fetch-latest-docker-tag')

// Serves Docker Hub tag pages from memory. Each page links to the next one
// the way the real API does, through `next`.
function fakeDockerHub (pages, { failPage } = {}) {
  const requested = []
  const fetch = async (url) => {
    requested.push(url)
    const index = requested.length - 1
    if (index + 1 === failPage) return { ok: false, status: 429 }
    return {
      ok: true,
      json: async () => ({
        results: pages[index].map((name) => ({ name })),
        next: index + 1 < pages.length ? `https://hub.docker.com/next?page=${index + 2}` : null,
      }),
    }
  }
  return { fetch, requested }
}

const silentLogger = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }

describe('fetch-latest-docker-tag', () => {
  it('reads one page by default and returns every stable tag it saw', async () => {
    const hub = fakeDockerHub([['v26.2.4', 'v26.1.12', 'v26.2.1-beta.3'], ['v25.1.4']])

    const result = await fetchLatestDockerTag('redpandadata', 'redpanda-operator', silentLogger, { fetch: hub.fetch })

    expect(hub.requested).toHaveLength(1)
    expect(result.latestStableRelease).toBe('v26.2.4')
    expect(result.latestBetaRelease).toBe('v26.2.1-beta.3')
    expect(result.stableReleases).toEqual(['v26.2.4', 'v26.1.12'])
  })

  it('follows next links up to maxPages, so older lines are still found', async () => {
    const hub = fakeDockerHub([['v26.2.4'], ['v25.3.10'], ['v25.1.4'], ['v24.3.1']])

    const result = await fetchLatestDockerTag('redpandadata', 'redpanda-operator', silentLogger, { fetch: hub.fetch, maxPages: 3 })

    expect(hub.requested).toHaveLength(3)
    expect(result.latestStableRelease).toBe('v26.2.4')
    expect(result.stableReleases).toEqual(['v26.2.4', 'v25.3.10', 'v25.1.4'])
  })

  it('stops when there is no next page', async () => {
    const hub = fakeDockerHub([['v26.2.4']])

    await fetchLatestDockerTag('redpandadata', 'redpanda-operator', silentLogger, { fetch: hub.fetch, maxPages: 3 })

    expect(hub.requested).toHaveLength(1)
  })

  it('keeps the first page when a later page fails, and warns', async () => {
    const warnings = []
    const hub = fakeDockerHub([['v26.2.4'], ['v25.3.10']], { failPage: 2 })

    const result = await fetchLatestDockerTag('redpandadata', 'redpanda-operator', { ...silentLogger, warn: (m) => warnings.push(m) }, { fetch: hub.fetch, maxPages: 3 })

    expect(result.latestStableRelease).toBe('v26.2.4')
    expect(result.stableReleases).toEqual(['v26.2.4'])
    expect(warnings.join('\n')).toMatch(/status 429 for page 2/)
  })

  it('returns no releases when the first page fails', async () => {
    const hub = fakeDockerHub([['v26.2.4']], { failPage: 1 })

    const result = await fetchLatestDockerTag('redpandadata', 'redpanda-operator', silentLogger, { fetch: hub.fetch, maxPages: 3 })

    expect(result).toEqual({ latestStableRelease: null, latestBetaRelease: null, stableReleases: [] })
  })
})
