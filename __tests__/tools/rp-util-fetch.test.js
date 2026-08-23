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
  runSchemaFlag
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
    githubToken.getAuthenticatedGitHubUrl.mockReset()
  })

  test('throws when no GitHub token is available -- the repo is private', () => {
    githubToken.getGitHubToken.mockReturnValue(null)
    expect(() => cloneStreamingEnterprise('v26.2.2', '/tmp/whatever'))
      .toThrow(/No GitHub token available/)
    expect(spawnSync).not.toHaveBeenCalled()
  })

  test('clones shallow by branch/tag name when that succeeds', () => {
    githubToken.getGitHubToken.mockReturnValue('tok')
    githubToken.getAuthenticatedGitHubUrl.mockReturnValue('https://tok@github.com/redpanda-data/streaming-enterprise.git')
    spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' })

    cloneStreamingEnterprise('v26.2.2', '/tmp/dest')

    expect(spawnSync).toHaveBeenCalledTimes(1)
    const args = spawnSync.mock.calls[0][1]
    expect(args).toEqual(['clone', '-q', '--depth', '1', '--branch', 'v26.2.2',
      'https://tok@github.com/redpanda-data/streaming-enterprise.git', '/tmp/dest'])
  })

  test('falls back to a full clone + checkout when the ref is not a branch/tag at HEAD', () => {
    githubToken.getGitHubToken.mockReturnValue('tok')
    githubToken.getAuthenticatedGitHubUrl.mockReturnValue('https://tok@github.com/redpanda-data/streaming-enterprise.git')

    jest.spyOn(fs, 'rmSync').mockImplementation(() => {})
    spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'branch not found' }) // shallow clone fails
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }) // full clone
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }) // checkout

    cloneStreamingEnterprise('48fb6d6f93d8f16fb08c81a2802dc17f1df1d46d', '/tmp/dest')

    expect(spawnSync).toHaveBeenCalledTimes(3)
    expect(spawnSync.mock.calls[1][1]).toEqual(
      ['clone', '-q', 'https://tok@github.com/redpanda-data/streaming-enterprise.git', '/tmp/dest']
    )
    expect(spawnSync.mock.calls[2]).toEqual([
      'git', ['checkout', '-q', '48fb6d6f93d8f16fb08c81a2802dc17f1df1d46d'],
      expect.objectContaining({ cwd: '/tmp/dest' })
    ])
    fs.rmSync.mockRestore()
  })

  test('throws when both the shallow and full clone attempts fail', () => {
    githubToken.getGitHubToken.mockReturnValue('tok')
    githubToken.getAuthenticatedGitHubUrl.mockReturnValue('https://tok@github.com/redpanda-data/streaming-enterprise.git')

    jest.spyOn(fs, 'rmSync').mockImplementation(() => {})
    spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'branch not found' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'network unreachable' })

    expect(() => cloneStreamingEnterprise('bad-ref', '/tmp/dest'))
      .toThrow(/Failed to clone streaming-enterprise: network unreachable/)
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
  })

  afterEach(() => {
    fs.mkdtempSync.mockRestore()
    fs.rmSync.mockRestore()
  })

  test('uses an existing sourcePath as-is, never clones, and fetches every schema', () => {
    jest.spyOn(os, 'platform').mockReturnValue('linux')
    spawnSync.mockImplementation((cmd, args) => {
      if (args[0] === '--version') return { status: 0, stdout: 'bazel 7.0.0', stderr: '' }
      if (args[0] === 'build') return { status: 0, stdout: '', stderr: '' }
      // one of SCHEMA_FLAGS' --*_schema_json flags
      return { status: 0, stdout: JSON.stringify({ flag: args[0] }), stderr: '' }
    })

    const result = getRpUtilSchema('v26.2.2', { sourcePath: '/existing/checkout' })

    expect(result.sourcePath).toBe('/existing/checkout')
    for (const { key, flag } of SCHEMA_FLAGS) {
      expect(result[key]).toEqual({ flag })
    }
    expect(fs.mkdtempSync).not.toHaveBeenCalled()
    os.platform.mockRestore()
  })

  test('cleans up a clone it made unless keepSource is set', () => {
    jest.spyOn(os, 'platform').mockReturnValue('linux')
    githubToken.getGitHubToken.mockReturnValue('tok')
    githubToken.getAuthenticatedGitHubUrl.mockReturnValue('https://tok@github.com/redpanda-data/streaming-enterprise.git')
    spawnSync.mockReturnValue({ status: 0, stdout: '{}', stderr: '' })

    getRpUtilSchema('v26.2.2')

    expect(fs.rmSync).toHaveBeenCalledWith(tmpDirs[0], { recursive: true, force: true })
    os.platform.mockRestore()
  })
})
