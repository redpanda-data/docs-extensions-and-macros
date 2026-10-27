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
  let argsFile

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'property-docs-token-'))
    outFile = path.join(tempDir, 'gh-token-seen.txt')
    // The CLI's own dependency check shells out to `make` before anything
    // else, so the fake being called at all says nothing about whether the
    // build ran. Record each invocation's arguments to tell the two apart.
    argsFile = path.join(tempDir, 'make-args.txt')
    const fakeMake = path.join(tempDir, 'make')
    fs.writeFileSync(
      fakeMake,
      `#!/bin/sh\nprintf '%s' "$GH_TOKEN" > "${outFile}"\nprintf '%s\\n' "$*" >> "${argsFile}"\nexit 0\n`
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

  it('fails before invoking make when no token is available anywhere', () => {
    // streaming-enterprise is private, so the extractor's clone needs a token
    // whether or not Cloud metadata is requested. Failing here rather than
    // letting the Makefile die mid-build keeps the remedy accurate:
    // --no-cloud-support drops the cloudv2 read, not the token requirement,
    // so it must not be offered as a way out of having no token.
    let err
    try {
      runPropertyDocs({
        GIT_CREDENTIALS: '',
        GITHUB_TOKEN: '',
        REDPANDA_GITHUB_TOKEN: '',
        ACTIONS_BOT_TOKEN: '',
        VBOT_GITHUB_API_TOKEN: '',
        GH_TOKEN: '',
      })
    } catch (e) {
      err = e
    }

    expect(err).toBeDefined()
    expect(err.status).toBe(1)
    const stderr = err.stderr.toString()
    expect(stderr).toMatch(/requires a GitHub token/)
    expect(stderr).not.toMatch(/disable cloud support/)
    // The dependency check's own `make` probe may have run; the build must
    // not have.
    const invocations = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8') : ''
    expect(invocations).not.toMatch(/build/)
  })
})
