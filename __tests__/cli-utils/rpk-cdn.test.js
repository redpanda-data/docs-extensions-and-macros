'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

// rpk-cdn.js destructures spawnSync at load time, so child_process has to be
// mocked before the module is required.
jest.mock('child_process')
const { spawnSync } = require('child_process')
const realSpawnSync = jest.requireActual('child_process').spawnSync

const MODULE_PATH = path.resolve(__dirname, '../../cli-utils/rpk-cdn.js')
const {
  RPK_CDN_BASE,
  normalizeRpkTag,
  rpkAssetName,
  rpkChecksumsName,
  rpkCdnUrls,
  isNotPublished,
  curlToFile,
  parseChecksums,
  resolveLatestRpkTag
} = require(MODULE_PATH)

// The real v26.2.2 checksums file as served on 2026-09-11
const REAL_CHECKSUMS = [
  '530c9a2ae8f99269c92785a9133919b5a5e83f96fa8f47cb5e742f53e8b1d6df  rpk-darwin-amd64.zip',
  'c9313e2ede62c95d05c6a627eaa6d0d89b12e819c5e487025de0275170620f14  rpk-darwin-arm64.zip',
  'e4d5fa4b4a3ce8f773226ab8e87de1f71394a702aa955e2b2093012fe13f761e  rpk-linux-amd64.zip',
  '111be6e5005d106cb760615d0fa8df0d5963303ac13195daca52cce7c711fcf1  rpk-linux-arm64.zip',
  '50db4983d1ff9586870c976f3b64aa0c4f2bc58e6ff1b6666756f99092e22f99  rpk-windows-amd64.zip',
  '8618bde935942e1424138d2b1af02d21d4c23fb73162f66e1f1f393d63ee1d9d  rpk-windows-arm64.zip'
].join('\n') + '\n'

const TOKEN_VARS = ['GIT_CREDENTIALS', 'REDPANDA_GITHUB_TOKEN', 'ACTIONS_BOT_TOKEN', 'GITHUB_TOKEN', 'VBOT_GITHUB_API_TOKEN', 'GH_TOKEN']
const savedEnv = {}
const clearTokens = () => {
  for (const name of TOKEN_VARS) {
    savedEnv[name] = process.env[name]
    delete process.env[name]
  }
}
const restoreTokens = () => {
  for (const name of TOKEN_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
}

describe('rpk-cdn', () => {
  describe('rpkAssetName', () => {
    test.each([
      ['linux', 'x64', 'rpk-linux-amd64.zip'],
      ['linux', 'arm64', 'rpk-linux-arm64.zip'],
      ['darwin', 'x64', 'rpk-darwin-amd64.zip'],
      ['darwin', 'arm64', 'rpk-darwin-arm64.zip'],
      ['win32', 'x64', 'rpk-windows-amd64.zip'],
      ['win32', 'arm64', 'rpk-windows-arm64.zip']
    ])('%s/%s -> %s', (platform, arch, expected) => {
      expect(rpkAssetName({ platform, arch })).toBe(expected)
    })

    test.each([['freebsd', 'x64'], ['linux', 'ia32']])('%s/%s is unsupported', (platform, arch) => {
      expect(rpkAssetName({ platform, arch })).toBeNull()
    })
  })

  describe('normalizeRpkTag', () => {
    test.each([
      ['26.2.2', 'v26.2.2'],
      ['v26.2.2', 'v26.2.2'],
      ['v26.3.0-rc1', 'v26.3.0-rc1'],
      ['26.3.0-rc12', 'v26.3.0-rc12'],
      [' v26.2.2 ', 'v26.2.2']
    ])('%s -> %s', (input, expected) => {
      expect(normalizeRpkTag(input)).toBe(expected)
    })

    test.each(['dev', 'vdev', 'v26.2', 'v26.2.2-beta1', 'v26.2.2-rc', '', undefined])('%s is not a release tag', (input) => {
      expect(normalizeRpkTag(input)).toBeNull()
    })
  })

  describe('rpkCdnUrls', () => {
    test('GA layout', () => {
      expect(rpkCdnUrls('v26.2.2', { platform: 'linux', arch: 'x64' })).toEqual({
        assetName: 'rpk-linux-amd64.zip',
        checksumsName: 'rpk_26.2.2_checksums.txt',
        zip: 'https://rpk.redpanda.com/v26.2.2/rpk-linux-amd64.zip',
        checksums: 'https://rpk.redpanda.com/v26.2.2/rpk_26.2.2_checksums.txt'
      })
    })

    test('RC layout keeps the -rcN suffix in both the prefix and the checksums name', () => {
      const urls = rpkCdnUrls('v26.3.0-rc1', { platform: 'darwin', arch: 'arm64' })
      expect(urls.zip).toBe('https://rpk.redpanda.com/v26.3.0-rc1/rpk-darwin-arm64.zip')
      expect(urls.checksums).toBe('https://rpk.redpanda.com/v26.3.0-rc1/rpk_26.3.0-rc1_checksums.txt')
      expect(rpkChecksumsName('v26.3.0-rc1')).toBe('rpk_26.3.0-rc1_checksums.txt')
    })

    test('unsupported platform gives null', () => {
      expect(rpkCdnUrls('v26.2.2', { platform: 'freebsd', arch: 'x64' })).toBeNull()
    })

    test('base URL is the documented host', () => {
      expect(RPK_CDN_BASE).toBe('https://rpk.redpanda.com')
    })
  })

  describe('parseChecksums', () => {
    test('finds each asset in the real six-line file', () => {
      expect(parseChecksums(REAL_CHECKSUMS, 'rpk-linux-amd64.zip')).toBe('e4d5fa4b4a3ce8f773226ab8e87de1f71394a702aa955e2b2093012fe13f761e')
      expect(parseChecksums(REAL_CHECKSUMS, 'rpk-windows-arm64.zip')).toBe('8618bde935942e1424138d2b1af02d21d4c23fb73162f66e1f1f393d63ee1d9d')
    })

    test('null for an asset that is not listed', () => {
      expect(parseChecksums(REAL_CHECKSUMS, 'rpk-freebsd-amd64.zip')).toBeNull()
    })

    test('tolerates CRLF and a trailing newline', () => {
      const crlf = REAL_CHECKSUMS.replace(/\n/g, '\r\n')
      expect(parseChecksums(crlf, 'rpk-darwin-arm64.zip')).toBe('c9313e2ede62c95d05c6a627eaa6d0d89b12e819c5e487025de0275170620f14')
    })
  })

  describe('isNotPublished', () => {
    test.each([403, 404])('%i means not published', (code) => expect(isNotPublished(code)).toBe(true))
    test.each([200, 500, 0])('%i does not', (code) => expect(isNotPublished(code)).toBe(false))
  })

  describe('curlToFile', () => {
    let tempDir
    beforeEach(() => {
      spawnSync.mockReset()
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-cdn-curl-'))
    })
    afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }))

    test('argv reads the status from -w and never retries deterministic errors or sends auth', () => {
      spawnSync.mockReturnValue({ status: 0, stdout: '200', stderr: '' })
      const dest = path.join(tempDir, 'out')

      const result = curlToFile('https://rpk.redpanda.com/v26.2.2/x', dest, { maxTime: 42 })

      expect(result).toEqual({ ok: true, httpCode: 200, status: 0, stderr: '' })
      const [cmd, args, opts] = spawnSync.mock.calls[0]
      expect(cmd).toBe('curl')
      expect(args).toEqual(expect.arrayContaining(['-w', '%{http_code}', '-o', dest, '--max-time', '42', '--retry', '3']))
      expect(args[args.length - 1]).toBe('https://rpk.redpanda.com/v26.2.2/x')
      expect(args).not.toContain('--retry-all-errors')
      expect(args).not.toContain('--config')
      expect(args.join(' ')).not.toContain('Authorization')
      expect(opts.input).toBeUndefined()
    })

    test('a 403 is reported through httpCode regardless of the curl exit code', () => {
      spawnSync.mockReturnValue({ status: 56, stdout: '403', stderr: 'The requested URL returned error: 403' })

      const result = curlToFile('https://rpk.redpanda.com/v0.0.0/x', path.join(tempDir, 'out'))

      expect(result.ok).toBe(false)
      expect(result.httpCode).toBe(403)
      expect(result.status).toBe(56)
    })

    test('a connection failure has httpCode 0', () => {
      spawnSync.mockReturnValue({ status: 6, stdout: '', stderr: 'Could not resolve host' })

      expect(curlToFile('https://rpk.redpanda.com/v0.0.0/x', path.join(tempDir, 'out'))).toMatchObject({ ok: false, httpCode: 0, status: 6 })
    })

    test('removes a partial file on failure', () => {
      const dest = path.join(tempDir, 'partial')
      fs.writeFileSync(dest, 'half')
      spawnSync.mockReturnValue({ status: 18, stdout: '200', stderr: 'transfer closed' })

      expect(curlToFile('https://rpk.redpanda.com/v26.2.2/x', dest).ok).toBe(false)
      expect(fs.existsSync(dest)).toBe(false)
    })
  })

  describe('resolveLatestRpkTag', () => {
    const quiet = { log: jest.fn(), warn: jest.fn() }
    const fakeOctokit = (tags) => ({
      rest: { git: { listMatchingRefs: 'listMatchingRefs' } },
      paginate: jest.fn(async () => tags.map(t => ({ ref: `refs/tags/${t}` })))
    })

    beforeEach(() => {
      spawnSync.mockReset()
      clearTokens()
    })
    afterEach(restoreTokens)

    test('RPK_VERSION wins without touching the network', async () => {
      const probe = jest.fn()
      await expect(resolveLatestRpkTag({ env: { RPK_VERSION: '26.2.1' }, probe, log: quiet })).resolves.toBe('v26.2.1')
      expect(probe).not.toHaveBeenCalled()
      expect(spawnSync).not.toHaveBeenCalled()
    })

    test('an invalid RPK_VERSION throws naming the accepted shape', async () => {
      await expect(resolveLatestRpkTag({ env: { RPK_VERSION: 'latest' }, probe: jest.fn(), log: quiet }))
        .rejects.toThrow(/RPK_VERSION='latest' is not a release tag; expected vX\.Y\.Z or vX\.Y\.Z-rcN/)
    })

    test('with a token, picks the newest GA tag that actually has a build on the CDN', async () => {
      process.env.GH_TOKEN = 'test-token-202'
      const octokit = fakeOctokit(['v26.2.3-rc1', 'v26.2.3', 'v26.2.2', 'v26.1.9', 'v9.0.0', 'v26.3.0-dev'])
      const probe = jest.fn((url) => url.includes('/v26.2.2/') ? 200 : 403)

      await expect(resolveLatestRpkTag({ env: {}, octokit, probe, platform: 'linux', arch: 'x64', log: quiet })).resolves.toBe('v26.2.2')

      expect(octokit.paginate).toHaveBeenCalledWith('listMatchingRefs', expect.objectContaining({
        owner: 'redpanda-data', repo: 'streaming-enterprise', ref: 'tags/v'
      }))
      // Probed in semver order, skipping RC/dev tags entirely
      expect(probe.mock.calls.map(([u]) => u)).toEqual([
        'https://rpk.redpanda.com/v26.2.3/rpk_26.2.3_checksums.txt',
        'https://rpk.redpanda.com/v26.2.2/rpk_26.2.2_checksums.txt'
      ])
      // The latest/ probe is never needed
      expect(spawnSync).not.toHaveBeenCalled()
    })

    test('without a token and with an empty latest/, throws pointing at RPK_VERSION', async () => {
      const probe = jest.fn(() => 403)

      await expect(resolveLatestRpkTag({ env: {}, probe, platform: 'linux', arch: 'x64', log: quiet }))
        .rejects.toThrow(/Set RPK_VERSION=vX\.Y\.Z/)
      expect(probe).toHaveBeenCalledWith('https://rpk.redpanda.com/latest/rpk-linux-amd64.zip')
      expect(spawnSync).not.toHaveBeenCalled()
    })

    test('without a token and a populated latest/, learns the version from the binary', async () => {
      const probe = jest.fn(() => 200)
      spawnSync.mockImplementation((cmd, args) => {
        if (cmd === 'curl') {
          fs.writeFileSync(args[args.indexOf('-o') + 1], 'zip bytes')
          return { status: 0, stdout: '200', stderr: '' }
        }
        if (cmd === 'unzip') {
          fs.writeFileSync(path.join(args[args.indexOf('-d') + 1], 'rpk'), '#!/bin/sh\n')
          return { status: 0, stdout: '', stderr: '' }
        }
        // the extracted rpk --version
        return { status: 0, stdout: 'Version:     v26.2.5\nGit ref:     abc123\n', stderr: '' }
      })

      await expect(resolveLatestRpkTag({ env: {}, probe, platform: 'linux', arch: 'x64', log: quiet })).resolves.toBe('v26.2.5')
      expect(spawnSync.mock.calls[0][1][spawnSync.mock.calls[0][1].length - 1]).toBe('https://rpk.redpanda.com/latest/rpk-linux-amd64.zip')
    })
  })

  describe('CLI', () => {
    test('url prints the zip and checksums URLs for a tag', () => {
      const result = realSpawnSync('node', [MODULE_PATH, 'url', '--tag', 'v26.2.2', '--platform', 'linux', '--arch', 'x64'], { encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(
        'https://rpk.redpanda.com/v26.2.2/rpk-linux-amd64.zip\n' +
        'https://rpk.redpanda.com/v26.2.2/rpk_26.2.2_checksums.txt\n'
      )
    })

    test('url exits 2 for a non-release tag and keeps stdout clean', () => {
      const result = realSpawnSync('node', [MODULE_PATH, 'url', '--tag', 'dev'], { encoding: 'utf8' })
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/not a release tag/)
    })

    test('install exits 2 for a non-release --version before any download', () => {
      const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-cdn-cli-'))
      try {
        const result = realSpawnSync('node', [MODULE_PATH, 'install', '--dest', dest, '--version', 'feature-branch'], { encoding: 'utf8' })
        expect(result.status).toBe(2)
        expect(fs.readdirSync(dest)).toEqual([])
      } finally {
        fs.rmSync(dest, { recursive: true, force: true })
      }
    })
  })
})
