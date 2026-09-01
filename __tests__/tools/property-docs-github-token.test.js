'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execSync } = require('child_process')

const cliPath = path.join(__dirname, '..', '..', 'bin', 'doc-tools.js')

/**
 * `doc-tools generate property-docs` resolves a GitHub token via
 * cli-utils/github-token.js (the same priority chain every other
 * GitHub-fetching command uses -- notably GIT_CREDENTIALS, the token
 * Antora/Netlify builds actually populate) and passes it to
 * tools/property-extractor/Makefile as GH_TOKEN, so the Makefile's own
 * narrower shell fallback (REDPANDA_GITHUB_TOKEN/GITHUB_TOKEN only) isn't
 * the only thing standing between a private-repo clone and an
 * unauthenticated one that 404s.
 *
 * These tests swap in a fake `make` on PATH that dumps its GH_TOKEN to a
 * file and exits immediately, so no real clone/build ever runs.
 */
describe('property-docs GitHub token passthrough to the Makefile', () => {
  let tempDir
  let outFile

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'property-docs-token-'))
    outFile = path.join(tempDir, 'gh-token-seen.txt')
    const fakeMake = path.join(tempDir, 'make')
    fs.writeFileSync(
      fakeMake,
      `#!/bin/sh\nprintf '%s' "$GH_TOKEN" > "${outFile}"\nexit 0\n`
    )
    fs.chmodSync(fakeMake, 0o755)
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function runPropertyDocs(env) {
    execSync(`node "${cliPath}" generate property-docs --tag v1.0.0 --no-cloud-support`, {
      env: { ...process.env, PATH: `${tempDir}:${process.env.PATH}`, ...env },
      stdio: 'pipe',
    })
  }

  it('passes GITHUB_TOKEN through to the Makefile as GH_TOKEN', () => {
    runPropertyDocs({
      GITHUB_TOKEN: 'test-github-token',
      GIT_CREDENTIALS: '',
      REDPANDA_GITHUB_TOKEN: '',
      ACTIONS_BOT_TOKEN: '',
      VBOT_GITHUB_API_TOKEN: '',
      GH_TOKEN: '',
    })
    expect(fs.readFileSync(outFile, 'utf8')).toBe('test-github-token')
  })

  it('passes a GIT_CREDENTIALS-derived token through -- the gap the Makefile alone could not see', () => {
    runPropertyDocs({
      GIT_CREDENTIALS: 'https://git-credentials-token:@github.com',
      GITHUB_TOKEN: '',
      REDPANDA_GITHUB_TOKEN: '',
      ACTIONS_BOT_TOKEN: '',
      VBOT_GITHUB_API_TOKEN: '',
      GH_TOKEN: '',
    })
    expect(fs.readFileSync(outFile, 'utf8')).toBe('git-credentials-token')
  })

  it('does not set GH_TOKEN at all when no token is available anywhere', () => {
    runPropertyDocs({
      GIT_CREDENTIALS: '',
      GITHUB_TOKEN: '',
      REDPANDA_GITHUB_TOKEN: '',
      ACTIONS_BOT_TOKEN: '',
      VBOT_GITHUB_API_TOKEN: '',
      GH_TOKEN: '',
    })
    expect(fs.readFileSync(outFile, 'utf8')).toBe('')
  })
})
