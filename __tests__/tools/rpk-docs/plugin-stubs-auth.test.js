'use strict'

/**
 * Unit tests for the docs-repo clone in tools/rpk-docs/generate-plugin-stubs.js.
 *
 * child_process is mocked so no real clone runs. The reconciler sparse-clones
 * redpanda-data/docs, which is private, so the clone has to authenticate with
 * whatever GitHub token the environment offers, and it has to do so without
 * putting the token in argv or in the remote URL.
 */

jest.mock('child_process')
jest.mock('../../../cli-utils/github-token')

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const githubToken = require('../../../cli-utils/github-token')
const {
  fetchPartialsDir,
  gitAuthEnv,
  redactCredentials
} = require('../../../tools/rpk-docs/generate-plugin-stubs.js')

const SPARSE = 'modules/reference/partials/rpk-ai'
const HELPER = '!f() { echo "username=x-access-token"; echo "password=$PLUGIN_STUBS_CLONE_TOKEN"; }; f'

// A git that succeeds: the clone creates the repo dir and the partials path
// so fetchPartialsDir's existence check passes without a network.
const okGit = (cmd, args) => {
  if (args[0] === 'clone') {
    fs.mkdirSync(path.join(args[args.length - 1], SPARSE), { recursive: true })
  }
  return { status: 0, stdout: '', stderr: '' }
}

const run = () => fetchPartialsDir({ docsRepo: 'redpanda-data/docs', docsRef: 'main', plugin: 'ai' })

describe('fetchPartialsDir authentication', () => {
  beforeEach(() => {
    spawnSync.mockReset()
    githubToken.getGitHubToken.mockReset()
  })

  test('with a token, both git invocations authenticate through the spawn env only', () => {
    githubToken.getGitHubToken.mockReturnValue('tok-123')
    spawnSync.mockImplementation(okGit)

    const dir = run()

    expect(dir.endsWith(SPARSE)).toBe(true)
    expect(spawnSync).toHaveBeenCalledTimes(2)
    expect(spawnSync.mock.calls[0][1].slice(0, 1)).toEqual(['clone'])
    // The sparse checkout pulls the deferred blobs, so it needs the helper too.
    expect(spawnSync.mock.calls[1][1].slice(0, 2)).toEqual(['sparse-checkout', 'set'])

    for (const [cmd, args, opts] of spawnSync.mock.calls) {
      expect(cmd).toBe('git')
      // argv never carries the token, an auth header, or a -c config.
      expect(JSON.stringify(args)).not.toContain('tok-123')
      expect(args.some((a) => /extraheader|authorization|@github\.com/i.test(a))).toBe(false)
      // The env carries the helper config and the token.
      expect(opts.env.PLUGIN_STUBS_CLONE_TOKEN).toBe('tok-123')
      expect(opts.env.GIT_CONFIG_COUNT).toBe('2')
      expect(opts.env.GIT_CONFIG_KEY_0).toBe('credential.helper')
      expect(opts.env.GIT_CONFIG_VALUE_0).toBe('')
      expect(opts.env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper')
      expect(opts.env.GIT_CONFIG_VALUE_1).toBe(HELPER)
    }
    // The remote URL stays the plain repo URL.
    expect(spawnSync.mock.calls[0][1]).toContain('https://github.com/redpanda-data/docs.git')
  })

  test('without a token, git runs with the inherited environment so local credential helpers and public repos keep working', () => {
    githubToken.getGitHubToken.mockReturnValue(null)
    spawnSync.mockImplementation(okGit)

    run()

    expect(spawnSync).toHaveBeenCalledTimes(2)
    for (const [, , opts] of spawnSync.mock.calls) {
      expect(opts.env).toBe(process.env)
    }
  })

  test('a failed anonymous clone names the token variables to set', () => {
    githubToken.getGitHubToken.mockReturnValue(null)
    spawnSync.mockReturnValue({
      status: 128, stdout: '', stderr: "fatal: could not read Username for 'https://github.com'"
    })

    expect(run).toThrow(/could not read Username[\s\S]*ACTIONS_BOT_TOKEN/)
  })

  test('a failed authenticated clone redacts credentials from git stderr', () => {
    githubToken.getGitHubToken.mockReturnValue('super-secret')
    spawnSync.mockReturnValue({
      status: 128,
      stdout: '',
      stderr: "fatal: unable to access 'https://x-access-token:super-secret@github.com/redpanda-data/docs.git/'"
    })

    let thrown
    try { run() } catch (e) { thrown = e }
    expect(thrown).toBeDefined()
    expect(thrown.message).not.toContain('super-secret')
    expect(thrown.message).toContain('//***@github.com')
  })
})

describe('gitAuthEnv', () => {
  test('returns the inherited env untouched when there is no token', () => {
    expect(gitAuthEnv(null)).toBe(process.env)
    expect(gitAuthEnv('')).toBe(process.env)
  })

  test('keeps the token out of the helper command string', () => {
    const env = gitAuthEnv('abc')
    expect(env.PLUGIN_STUBS_CLONE_TOKEN).toBe('abc')
    expect(env.GIT_CONFIG_VALUE_1).toBe(HELPER)
    expect(env.GIT_CONFIG_VALUE_1).not.toContain('abc')
  })
})

describe('redactCredentials', () => {
  test('scrubs URL userinfo and basic auth headers', () => {
    expect(redactCredentials('https://tok@github.com/x AUTHORIZATION: basic abc=='))
      .toBe('https://***@github.com/x AUTHORIZATION: basic ***')
    expect(redactCredentials(undefined)).toBe('')
  })
})
