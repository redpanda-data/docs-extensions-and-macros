'use strict'

const { fetchRemoteAntoraVersion, determineDocsBranch } = require('../../cli-utils/self-managed-docs-branch')

const ANTORA_URL = 'https://raw.githubusercontent.com/redpanda-data/docs/main/antora.yml'

function okResponse (body) {
  return {
    ok: true,
    status: 200,
    text: jest.fn().mockResolvedValue(body),
    body: { cancel: jest.fn().mockResolvedValue(undefined) },
  }
}

function errorResponse (status) {
  return {
    ok: false,
    status,
    body: { cancel: jest.fn().mockResolvedValue(undefined) },
  }
}

describe('fetchRemoteAntoraVersion', () => {
  it('sends a Bearer token when one is available', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse('version: 25.2\n'))

    await expect(fetchRemoteAntoraVersion({ fetchImpl, token: 'tok123' })).resolves.toBe('25.2')
    expect(fetchImpl).toHaveBeenCalledWith(ANTORA_URL, { headers: { Authorization: 'Bearer tok123' } })
  })

  it('fetches without auth when no token is available', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse('version: 25.1\n'))

    await expect(fetchRemoteAntoraVersion({ fetchImpl, token: undefined })).resolves.toBe('25.1')
    expect(fetchImpl).toHaveBeenCalledWith(ANTORA_URL, undefined)
  })

  it('includes the private-repo token hint on a tokenless 404', async () => {
    const resp = errorResponse(404)
    const fetchImpl = jest.fn().mockResolvedValue(resp)

    await expect(fetchRemoteAntoraVersion({ fetchImpl, token: undefined }))
      .rejects.toThrow(/404.*set GIT_CREDENTIALS \(or GITHUB_TOKEN \/ REDPANDA_GITHUB_TOKEN \/ ACTIONS_BOT_TOKEN\)/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(resp.body.cancel).toHaveBeenCalled()
  })

  it('retries without auth when a 404 arrives with a token sent', async () => {
    const rejected = errorResponse(404)
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(okResponse('version: 25.2\n'))

    await expect(fetchRemoteAntoraVersion({ fetchImpl, token: 'stale' })).resolves.toBe('25.2')
    expect(fetchImpl).toHaveBeenNthCalledWith(1, ANTORA_URL, { headers: { Authorization: 'Bearer stale' } })
    expect(fetchImpl).toHaveBeenNthCalledWith(2, ANTORA_URL)
    expect(rejected.body.cancel).toHaveBeenCalled()
  })

  it('reports a rejected token when the tokenless retry also fails', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(errorResponse(404))
      .mockResolvedValueOnce(errorResponse(404))

    await expect(fetchRemoteAntoraVersion({ fetchImpl, token: 'stale' }))
      .rejects.toThrow(/token was sent but rejected/i)
  })

  it('does not retry or hint on non-404 failures', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(errorResponse(500))

    await expect(fetchRemoteAntoraVersion({ fetchImpl, token: 'tok' }))
      .rejects.toThrow(/Failed to fetch antora\.yml: 500$/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('throws when the version field is missing', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse('name: ROOT\n'))

    await expect(fetchRemoteAntoraVersion({ fetchImpl, token: undefined }))
      .rejects.toThrow('version field missing')
  })
})

describe('determineDocsBranch', () => {
  const exists = () => true

  it.each(['main', 'dev', 'jake/some-feature'])('maps the unversioned ref %s to docs main without fetching antora.yml', async (ref) => {
    const fetchImpl = jest.fn()
    const branchExists = jest.fn(exists)

    await expect(determineDocsBranch(ref, { fetchImpl, branchExists })).resolves.toBe('main')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(branchExists).toHaveBeenCalledWith('main')
  })

  it.each([
    ['operator/v26.2.4', '26.2', 'main'],
    ['v26.1.3', '26.2', 'v/26.1'],
    ['release/v25.3.x', '26.2', 'v/25.3'],
    ['operator/v2.4.5', '25.1', 'main'],
    ['operator/v2.4.5', '25.2', 'v/24.3'],
  ])('maps %s to the docs branch for version %s', async (ref, antoraVersion, expected) => {
    await expect(determineDocsBranch(ref, { antoraVersion, branchExists: exists })).resolves.toBe(expected)
  })

  it('throws when the docs branch does not exist', async () => {
    await expect(determineDocsBranch('operator/v23.1.0', { antoraVersion: '26.2', branchExists: () => false }))
      .rejects.toThrow('Docs branch v/23.1 not found')
  })
})
