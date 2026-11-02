'use strict'

/**
 * Unit tests for cli-utils/git-credential-env.js, the single implementation
 * of how doc-tools hands a GitHub token to the git CLI.
 *
 * Everything that clones a private Redpanda repo goes through gitAuthEnv, so
 * the guarantee asserted here -- the token reaches git only through the
 * subprocess environment, never through argv, a URL, or .git/config -- is the
 * guarantee for every one of those call sites at once.
 */

const fs = require('fs')
const path = require('path')
const { gitAuthEnv, redactCredentials, TOKEN_ENV_VAR } = require('../../cli-utils/git-credential-env')

const HELPER = `!f() { echo "username=x-access-token"; echo "password=$${TOKEN_ENV_VAR}"; }; f`

describe('gitAuthEnv', () => {
  test('registers a github.com-scoped credential helper that reads the token from the environment', () => {
    const env = gitAuthEnv('tok-123', {})

    expect(env[TOKEN_ENV_VAR]).toBe('tok-123')
    expect(env.GIT_CONFIG_COUNT).toBe('2')
    // Entry 0 clears inherited helpers so a system credential manager cannot
    // intercept (or prompt) before ours answers.
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper')
    expect(env.GIT_CONFIG_VALUE_0).toBe('')
    // Entry 1 is scoped to github.com, so no other host is offered the token.
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper')
    expect(env.GIT_CONFIG_VALUE_1).toBe(HELPER)
  })

  test('the helper command string is a static literal that never contains the token', () => {
    for (const token of ['tok-123', 'ghp_' + 'x'.repeat(36), 'a b"c$d\'e']) {
      const env = gitAuthEnv(token, {})
      expect(env.GIT_CONFIG_VALUE_1).toBe(HELPER)
      expect(env.GIT_CONFIG_VALUE_1).not.toContain(token)
      // A token with shell metacharacters stays a plain value, never
      // interpolated into the helper, so there is nothing to quote wrong.
      expect(env[TOKEN_ENV_VAR]).toBe(token)
    }
  })

  test('extends the given base environment instead of replacing it', () => {
    const env = gitAuthEnv('tok', { GIT_TERMINAL_PROMPT: '0', PATH: '/usr/bin' })
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.GIT_CONFIG_COUNT).toBe('2')
  })

  test('defaults to process.env as the base', () => {
    const env = gitAuthEnv('tok')
    expect(env.PATH).toBe(process.env.PATH)
    expect(env).not.toBe(process.env)
    // The caller's own environment is never mutated.
    expect(process.env[TOKEN_ENV_VAR]).toBeUndefined()
    expect(process.env.GIT_CONFIG_COUNT).toBeUndefined()
  })

  test('returns the base environment untouched when there is no token', () => {
    // Not half-configured: git falls back to the host credential helpers,
    // which is what a local run relies on and all a public repo needs.
    expect(gitAuthEnv(null)).toBe(process.env)
    expect(gitAuthEnv(undefined)).toBe(process.env)
    expect(gitAuthEnv('')).toBe(process.env)

    const base = { GIT_TERMINAL_PROMPT: '0' }
    expect(gitAuthEnv(null, base)).toBe(base)
  })

  test('replaces GIT_CONFIG_* entries inherited from the base environment', () => {
    // A stale count or key from an outer invocation must not survive and
    // change which config entries git reads.
    const env = gitAuthEnv('tok', {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: 'osxkeychain'
    })
    expect(env.GIT_CONFIG_COUNT).toBe('2')
    expect(env.GIT_CONFIG_VALUE_0).toBe('')
    expect(env.GIT_CONFIG_VALUE_1).toBe(HELPER)
  })
})

describe('redactCredentials', () => {
  test('scrubs userinfo out of a URL git echoed back', () => {
    expect(redactCredentials("fatal: unable to access 'https://x-access-token:ghp_secret@github.com/redpanda-data/docs.git/'"))
      .toBe("fatal: unable to access 'https://***@github.com/redpanda-data/docs.git/'")
  })

  test('scrubs a basic auth header regardless of case', () => {
    expect(redactCredentials('AUTHORIZATION: Basic Z2g6c2VjcmV0')).toBe('AUTHORIZATION: Basic ***')
    expect(redactCredentials('authorization: basic abc==')).toBe('authorization: basic ***')
  })

  test('scrubs every occurrence, not just the first', () => {
    const out = redactCredentials('https://a@github.com and https://b@github.com')
    expect(out).toBe('https://***@github.com and https://***@github.com')
  })

  test('leaves credential-free text alone and makes nullish input safe to interpolate', () => {
    expect(redactCredentials('fatal: could not read Username')).toBe('fatal: could not read Username')
    expect(redactCredentials(undefined)).toBe('')
    expect(redactCredentials(null)).toBe('')
  })
})

describe('every git-CLI credential path goes through this helper', () => {
  // The five copies of this pattern that used to exist drifted (each had its
  // own token variable name, only some redacted stderr). Nothing should
  // hand-roll GIT_CONFIG_* credential config again.
  const SOURCE_DIRS = ['cli-utils', 'extensions', 'tools', 'macros', 'mcp', 'bin']
  const MODULE = path.join('cli-utils', 'git-credential-env.js')

  const jsFiles = (dir) => {
    const root = path.join(__dirname, '..', '..', dir)
    if (!fs.existsSync(root)) return []
    const out = []
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'venv') continue
      const rel = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...jsFiles(rel))
      else if (entry.name.endsWith('.js')) out.push(rel)
    }
    return out
  }

  test('no source file outside the helper sets GIT_CONFIG_COUNT itself', () => {
    const offenders = SOURCE_DIRS
      .flatMap(jsFiles)
      .filter((rel) => rel !== MODULE)
      .filter((rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8').includes('GIT_CONFIG_COUNT'))

    expect(offenders).toEqual([])
  })
})
