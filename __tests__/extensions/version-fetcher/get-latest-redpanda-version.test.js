const { describe, it, expect } = require('@jest/globals')
const getLatestRedpandaVersion = require('../../../extensions/version-fetcher/get-latest-redpanda-version')

// Minimal Octokit stand-in. `refs` maps a tag name to a SHA; any tag that is not
// in the map answers with a 404, which is what GitHub really does for a release
// whose tag has not been pushed yet.
function fakeGitHub ({ releases, refs = {} }) {
  const calls = []
  return {
    calls,
    rest: {
      repos: {
        listReleases: async () => ({ data: releases }),
      },
      git: {
        getRef: async ({ ref }) => {
          calls.push(ref)
          const tag = ref.replace(/^tags\//, '')
          if (!(tag in refs)) {
            const error = new Error(`Not Found - ${ref}`)
            error.status = 404
            throw error
          }
          return { data: { object: { sha: refs[tag] } } }
        },
      },
    },
  }
}

const releases = [
  { tag_name: 'v26.2.2-rc2', draft: true },
  { tag_name: 'v26.2.1', draft: false },
  { tag_name: 'v26.1.9', draft: false },
]

function collectingLogger () {
  const warnings = []
  const errors = []
  return { warnings, errors, warn: (m) => warnings.push(String(m)), error: (m) => errors.push(String(m)) }
}

describe('get-latest-redpanda-version', () => {
  it('returns the newest GA and RC releases with short commit hashes', async () => {
    const github = fakeGitHub({
      releases,
      refs: { 'v26.2.1': 'abcdef1234567890', 'v26.2.2-rc2': '1234567890abcdef' },
    })
    const logger = collectingLogger()

    const result = await getLatestRedpandaVersion(github, 'redpanda-data', 'redpanda', logger)

    expect(result.latestRedpandaRelease).toEqual({ version: 'v26.2.1', commitHash: 'abcdef1' })
    expect(result.latestRcRelease).toEqual({ version: 'v26.2.2-rc2', commitHash: '1234567' })
    expect(logger.warnings).toEqual([])
  })

  it('keeps the versions when a release tag has no ref yet', async () => {
    // Live behavior on 2026-08-21: the newest RC release (v26.2.2-rc2) is a draft
    // with no pushed tag, so GET /git/ref/tags/v26.2.2-rc2 is a 404. That 404 used
    // to abort the whole lookup and leave every latest-redpanda-* attribute unset.
    const github = fakeGitHub({ releases, refs: { 'v26.2.1': 'abcdef1234567890' } })
    const logger = collectingLogger()

    const result = await getLatestRedpandaVersion(github, 'redpanda-data', 'redpanda', logger)

    expect(result.latestRedpandaRelease).toEqual({ version: 'v26.2.1', commitHash: 'abcdef1' })
    expect(result.latestRcRelease).toEqual({ version: 'v26.2.2-rc2', commitHash: null })
    expect(logger.warnings.join('\n')).toMatch(/Could not resolve the commit for v26.2.2-rc2/)
    expect(logger.errors).toEqual([])
  })

  it('still reports no releases when the release listing itself fails', async () => {
    const github = {
      rest: {
        repos: { listReleases: async () => { throw Object.assign(new Error('boom'), { status: 403 }) } },
        git: { getRef: async () => { throw new Error('should not be called') } },
      },
    }
    const logger = collectingLogger()

    const result = await getLatestRedpandaVersion(github, 'redpanda-data', 'redpanda', logger)

    expect(result).toEqual({ latestRedpandaRelease: null, latestRcRelease: null })
    expect(logger.errors.join('\n')).toMatch(/Failed to fetch Redpanda release information/)
  })
})

describe('resolveCommitHash error handling', () => {
  // Two failures that look alike and are not. A tag that is not yet pushed
  // answers 404 for good, so retrying is waste and the version must survive
  // without a commit. A rate limit or a 5xx is transient, so it has to get its
  // attempts, and must ALSO leave the version intact once they are exhausted:
  // losing the whole version to a blip is strictly worse than losing a commit
  // hash, which is why the retry lives on the ref lookup rather than around it.
  const releases = [
    { tag_name: 'v26.2.1', prerelease: false, published_at: '2026-08-01T00:00:00Z' },
  ]

  function throwingGitHub (error) {
    const state = { attempts: 0 }
    state.gh = {
      rest: {
        repos: { listReleases: async () => ({ data: releases }) },
        git: { getRef: async () => { state.attempts++; throw error } },
      },
    }
    return state
  }

  it('does not retry a 404, and keeps the version', async () => {
    const s = throwingGitHub(Object.assign(new Error('Not Found'), { status: 404 }))
    const result = await getLatestRedpandaVersion(s.gh)
    expect(s.attempts).toBe(1)
    expect(result.latestRedpandaRelease.version).toBe('v26.2.1')
    expect(result.latestRedpandaRelease.commitHash).toBeNull()
  })

  it.each([
    ['a rate limit', Object.assign(new Error('API rate limit exceeded'), { status: 403 })],
    ['a 502', Object.assign(new Error('Bad Gateway'), { status: 502 })],
    ['a connection reset', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
  ])('retries %s and still keeps the version', async (_label, err) => {
    const s = throwingGitHub(err)
    const result = await getLatestRedpandaVersion(s.gh)
    // More than one attempt is the point: swallowing the error immediately gave
    // exactly one, so this is what fails if the guard is widened again.
    expect(s.attempts).toBeGreaterThan(1)
    expect(result.latestRedpandaRelease.version).toBe('v26.2.1')
    expect(result.latestRedpandaRelease.commitHash).toBeNull()
  })
})
