'use strict'

/**
 * Unit tests for tools/property-extractor/rp-util-fetch.js.
 *
 * These mock child_process so no real git clone, Bazel build, or Docker
 * container ever runs -- that real build (network + ~12min cold Bazel
 * compile) is validated separately as an end-to-end check, not here.
 */

jest.mock('child_process')
jest.mock('../../cli-utils/github-token')

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const githubToken = require('../../cli-utils/github-token')
const {
  getRpUtilSchema,
  SCHEMA_FLAGS,
  cloneStreamingEnterprise,
  buildNative,
  runSchemaFlag,
  fetchPublishedSchema
} = require('../../tools/property-extractor/rp-util-fetch')

describe('runSchemaFlag', () => {
  beforeEach(() => spawnSync.mockReset())

  test('parses JSON stdout from the given flag', () => {
    spawnSync.mockReturnValue({ status: 0, stdout: '{"a":1}', stderr: '' })
    expect(runSchemaFlag('/bin/rp_util', '--config_schema_json')).toEqual({ a: 1 })
    expect(spawnSync).toHaveBeenCalledWith(
      '/bin/rp_util', ['--config_schema_json'], expect.any(Object)
    )
  })

  test('throws a descriptive error on non-zero exit', () => {
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'boom' })
    expect(() => runSchemaFlag('/bin/rp_util', '--node_config_schema_json'))
      .toThrow(/node_config_schema_json failed: boom/)
  })

  test('throws a descriptive error on invalid JSON', () => {
    spawnSync.mockReturnValue({ status: 0, stdout: 'not json', stderr: '' })
    expect(() => runSchemaFlag('/bin/rp_util', '--config_schema_json'))
      .toThrow(/did not print valid JSON/)
  })
})

describe('cloneStreamingEnterprise', () => {
  beforeEach(() => {
    spawnSync.mockReset()
    githubToken.getGitHubToken.mockReset()
  })

  // Basic auth header for x-access-token:tok, asserted against directly
  // rather than recomputed, so a broken encoding in the implementation
  // can't silently agree with itself.
  const AUTH_HEADER_TOK = 'http.https://github.com/.extraheader=AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46dG9r'

  test('throws when no GitHub token is available -- the repo is private', () => {
    githubToken.getGitHubToken.mockReturnValue(null)
    expect(() => cloneStreamingEnterprise('v26.2.2', '/tmp/whatever'))
      .toThrow(/No GitHub token available/)
    expect(spawnSync).not.toHaveBeenCalled()
  })

  test('clones shallow by branch/tag name when that succeeds, with the token passed as a per-invocation header, never in the URL', () => {
    githubToken.getGitHubToken.mockReturnValue('tok')
    spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' })

    cloneStreamingEnterprise('v26.2.2', '/tmp/dest')

    expect(spawnSync).toHaveBeenCalledTimes(1)
    const args = spawnSync.mock.calls[0][1]
    expect(args).toEqual(['-c', AUTH_HEADER_TOK, 'clone', '-q', '--depth', '1', '--branch', 'v26.2.2',
      'https://github.com/redpanda-data/streaming-enterprise.git', '/tmp/dest'])
    // The plain repo URL never carries the token in its userinfo.
    expect(args.some((a) => a.includes('@github.com'))).toBe(false)
  })

  test('falls back to a full clone + checkout when the ref is not a branch/tag at HEAD', () => {
    githubToken.getGitHubToken.mockReturnValue('tok')

    jest.spyOn(fs, 'rmSync').mockImplementation(() => {})
    spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'branch not found' }) // shallow clone fails
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }) // full clone
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }) // checkout

    cloneStreamingEnterprise('48fb6d6f93d8f16fb08c81a2802dc17f1df1d46d', '/tmp/dest')

    expect(spawnSync).toHaveBeenCalledTimes(3)
    expect(spawnSync.mock.calls[1][1]).toEqual(
      ['-c', AUTH_HEADER_TOK, 'clone', '-q', 'https://github.com/redpanda-data/streaming-enterprise.git', '/tmp/dest']
    )
    // Checkout runs against the already-cloned local repo -- no auth needed.
    expect(spawnSync.mock.calls[2]).toEqual([
      'git', ['checkout', '-q', '48fb6d6f93d8f16fb08c81a2802dc17f1df1d46d'],
      expect.objectContaining({ cwd: '/tmp/dest' })
    ])
    fs.rmSync.mockRestore()
  })

  test('throws when both the shallow and full clone attempts fail', () => {
    githubToken.getGitHubToken.mockReturnValue('tok')

    jest.spyOn(fs, 'rmSync').mockImplementation(() => {})
    spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'branch not found' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'network unreachable' })

    expect(() => cloneStreamingEnterprise('bad-ref', '/tmp/dest'))
      .toThrow(/Failed to clone streaming-enterprise: network unreachable/)
    fs.rmSync.mockRestore()
  })

  test('never embeds the token in the remote URL, for either the shallow or the full-clone fallback', () => {
    githubToken.getGitHubToken.mockReturnValue('super-secret-token')

    jest.spyOn(fs, 'rmSync').mockImplementation(() => {})
    spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'branch not found' }) // shallow clone fails
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }) // full clone
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }) // checkout

    cloneStreamingEnterprise('some-ref', '/tmp/dest')

    for (const call of spawnSync.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('super-secret-token')
    }
    fs.rmSync.mockRestore()
  })

  test('redacts a leaked authorization header from git stderr before throwing', () => {
    // Defense in depth: even though the token now travels only via the -c
    // extraheader flag (never the URL), redactCredentials still scrubs it
    // if git ever echoed a failing invocation's config back in stderr.
    githubToken.getGitHubToken.mockReturnValue('super-secret-token')

    jest.spyOn(fs, 'rmSync').mockImplementation(() => {})
    const leakedHeader = `AUTHORIZATION: basic ${Buffer.from('x-access-token:super-secret-token').toString('base64')}`
    spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'branch not found' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: `fatal: unable to access, config dump: http.extraheader=${leakedHeader}` })

    let thrown
    try {
      cloneStreamingEnterprise('bad-ref', '/tmp/dest')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeDefined()
    expect(thrown.message).not.toContain('super-secret-token')
    fs.rmSync.mockRestore()
  })
})

describe('buildNative', () => {
  beforeEach(() => spawnSync.mockReset())

  test('throws a descriptive error when bazel is not on PATH', () => {
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' })
    expect(() => buildNative('/tmp/source'))
      .toThrow(/bazel .* required but was not found/)
  })

  test('runs bazel build with --lockfile_mode=off against the rp_util target', () => {
    spawnSync
      .mockReturnValueOnce({ status: 0, stdout: 'bazel 7.0.0', stderr: '' }) // version check
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }) // build

    const binaryPath = buildNative('/tmp/source')

    expect(spawnSync.mock.calls[1]).toEqual([
      'bazel',
      ['build', '--lockfile_mode=off', '//src/v/rp_util:rp_util'],
      expect.objectContaining({ cwd: '/tmp/source' })
    ])
    expect(binaryPath).toBe(path.join('/tmp/source', 'bazel-bin', 'src', 'v', 'rp_util', 'rp_util'))
  })

  test('throws a descriptive error when the build itself fails', () => {
    spawnSync
      .mockReturnValueOnce({ status: 0, stdout: 'bazel 7.0.0', stderr: '' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'compile error' })

    expect(() => buildNative('/tmp/source')).toThrow(/Failed to build rp_util: compile error/)
  })
})

describe('fetchPublishedSchema', () => {
  beforeEach(() => {
    githubToken.getGitHubToken.mockReset()
  })

  afterEach(() => {
    delete global.fetch
  })

  test('returns null when no release exists for this tag', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 404, ok: false })

    const result = await fetchPublishedSchema('v0.0.0-not-a-real-tag')

    expect(result).toBeNull()
  })

  test('downloads and maps every recognized asset to its schema key', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          assets: [
            { name: 'cluster-config-schema.json', url: 'https://api.github.com/asset/1' },
            { name: 'node-config-schema.json', url: 'https://api.github.com/asset/2' },
            { name: 'pandaproxy-config-schema.json', url: 'https://api.github.com/asset/3' },
            { name: 'kafka-client-config-schema.json', url: 'https://api.github.com/asset/4' },
            { name: 'schema-registry-config-schema.json', url: 'https://api.github.com/asset/5' },
            { name: 'README.md', url: 'https://api.github.com/asset/6' }
          ]
        })
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ a: 1 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ b: 2 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ c: 3 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ d: 4 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ e: 5 }) })

    const result = await fetchPublishedSchema('v26.2.2')

    expect(result).toEqual({
      clusterSchema: { a: 1 },
      nodeSchema: { b: 2 },
      pandaproxySchema: { c: 3 },
      kafkaClientSchema: { d: 4 },
      schemaRegistrySchema: { e: 5 }
    })
    // The unrecognized README.md asset must not trigger a 6th download.
    expect(global.fetch).toHaveBeenCalledTimes(6)
  })

  test('sends the GitHub token as a bearer header when available', async () => {
    githubToken.getGitHubToken.mockReturnValue('tok')
    global.fetch = jest.fn().mockResolvedValue({ status: 404, ok: false })

    await fetchPublishedSchema('v26.2.2')

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      { headers: { Authorization: 'Bearer tok' } }
    )
  })

  test('throws a descriptive error on a non-404 failure', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 500, ok: false, statusText: 'Internal Server Error' })

    await expect(fetchPublishedSchema('v26.2.2')).rejects.toThrow(/500/)
  })
})

describe('getRpUtilSchema', () => {
  let tmpDirs

  beforeEach(() => {
    spawnSync.mockReset()
    githubToken.getGitHubToken.mockReset()
    githubToken.getAuthenticatedGitHubUrl.mockReset()
    tmpDirs = []
    jest.spyOn(fs, 'mkdtempSync').mockImplementation(prefix => {
      const dir = `${prefix}fake`
      tmpDirs.push(dir)
      return dir
    })
    jest.spyOn(fs, 'rmSync').mockImplementation(() => {})
    // A sourcePath is passed in most of these tests, which already skips the
    // published-release check -- but the "no sourcePath" test below needs a
    // 404 so it falls through to the from-source path exercised elsewhere.
    global.fetch = jest.fn().mockResolvedValue({ status: 404, ok: false })
  })

  afterEach(() => {
    fs.mkdtempSync.mockRestore()
    fs.rmSync.mockRestore()
    delete global.fetch
  })

  test('uses an existing sourcePath as-is, never clones, and fetches every schema', async () => {
    jest.spyOn(os, 'platform').mockReturnValue('linux')
    spawnSync.mockImplementation((cmd, args) => {
      if (args[0] === '--version') return { status: 0, stdout: 'bazel 7.0.0', stderr: '' }
      if (args[0] === 'build') return { status: 0, stdout: '', stderr: '' }
      // one of SCHEMA_FLAGS' --*_schema_json flags
      return { status: 0, stdout: JSON.stringify({ flag: args[0] }), stderr: '' }
    })

    const result = await getRpUtilSchema('v26.2.2', { sourcePath: '/existing/checkout' })

    expect(result.sourcePath).toBe('/existing/checkout')
    for (const { key, flag } of SCHEMA_FLAGS) {
      expect(result[key]).toEqual({ flag })
    }
    expect(fs.mkdtempSync).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
    os.platform.mockRestore()
  })

  test('cleans up a clone it made unless keepSource is set', async () => {
    jest.spyOn(os, 'platform').mockReturnValue('linux')
    githubToken.getGitHubToken.mockReturnValue('tok')
    githubToken.getAuthenticatedGitHubUrl.mockReturnValue('https://tok@github.com/redpanda-data/streaming-enterprise.git')
    spawnSync.mockReturnValue({ status: 0, stdout: '{}', stderr: '' })

    await getRpUtilSchema('v26.2.2')

    expect(fs.rmSync).toHaveBeenCalledWith(tmpDirs[0], { recursive: true, force: true })
    os.platform.mockRestore()
  })

  test('skips the published-release check when sourcePath is given', async () => {
    jest.spyOn(os, 'platform').mockReturnValue('linux')
    spawnSync.mockReturnValue({ status: 0, stdout: '{}', stderr: '' })

    await getRpUtilSchema('v26.2.2', { sourcePath: '/existing/checkout' })

    expect(global.fetch).not.toHaveBeenCalled()
    os.platform.mockRestore()
  })

  test('uses a published release instead of building when one exists', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          assets: [
            { name: 'cluster-config-schema.json', url: 'https://api.github.com/asset/1' },
            { name: 'node-config-schema.json', url: 'https://api.github.com/asset/2' }
          ]
        })
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cluster: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ node: true }) })

    const result = await getRpUtilSchema('v26.2.2')

    expect(result.clusterSchema).toEqual({ cluster: true })
    expect(result.nodeSchema).toEqual({ node: true })
    expect(result.sourcePath).toBeNull()
    expect(spawnSync).not.toHaveBeenCalled()
  })

  test('preferPublished: false always builds from source, even if a release exists', async () => {
    jest.spyOn(os, 'platform').mockReturnValue('linux')
    githubToken.getGitHubToken.mockReturnValue('tok')
    githubToken.getAuthenticatedGitHubUrl.mockReturnValue('https://tok@github.com/redpanda-data/streaming-enterprise.git')
    spawnSync.mockReturnValue({ status: 0, stdout: '{}', stderr: '' })

    await getRpUtilSchema('v26.2.2', { preferPublished: false })

    expect(global.fetch).not.toHaveBeenCalled()
    os.platform.mockRestore()
  })
})
