'use strict'

/**
 * rpk binary distribution on https://rpk.redpanda.com (DEVPROD-4723).
 *
 * rpk release binaries stopped shipping as GitHub Release assets in
 * September 2026 and are served from an S3-backed CDN instead. This module
 * is the single definition of that layout for every consumer in this
 * package (the rpk docs generator and install-test-dependencies.sh):
 *
 *   https://rpk.redpanda.com/v<tag>/rpk-<os>-<arch>.zip
 *   https://rpk.redpanda.com/v<tag>/rpk_<version>_checksums.txt   (sha256sum format)
 *   https://rpk.redpanda.com/latest/...                            (newest GA, copied at promote)
 *
 * Both GA (vX.Y.Z) and RC (vX.Y.Z-rcN) tags are published under v<tag>/.
 * No authentication is needed. The bucket has no listing, and a missing key
 * answers HTTP 403 (AccessDenied), not 404, so "is this version published"
 * is a request for its checksums file and both codes mean "not published".
 *
 * Runs as a CLI too (see usage() below) so the bash installer shares this
 * code instead of carrying its own copy of the URL layout.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const RPK_CDN_BASE = 'https://rpk.redpanda.com'
const RPK_CDN_LATEST_PREFIX = 'latest'
// GA and RC tags both have a build under v<tag>/
const RPK_RELEASE_TAG_RE = /^v\d+\.\d+\.\d+(-rc\d+)?$/
// Only GA tags are ever promoted to latest/
const RPK_GA_TAG_RE = /^v\d+\.\d+\.\d+$/
const RPK_OS_BY_PLATFORM = { darwin: 'darwin', linux: 'linux', win32: 'windows' }
const RPK_ARCH_BY_NODE_ARCH = { arm64: 'arm64', x64: 'amd64' }
// S3 without ListBucket answers 403 for a missing key; a 404 would mean the
// same thing if the distribution ever changes.
const NOT_PUBLISHED_HTTP_CODES = new Set([403, 404])

const TAGS_OWNER = 'redpanda-data'
const TAGS_REPO = 'streaming-enterprise'

/**
 * Normalise a version to the tag shape the CDN publishes under.
 * @param {string} version - "26.2.2", "v26.2.2" or "v26.3.0-rc1"
 * @returns {string|null} "v"-prefixed tag, or null when the shape is not a release tag
 */
function normalizeRpkTag(version) {
  if (typeof version !== 'string') return null
  const trimmed = version.trim()
  if (!trimmed) return null
  const tag = trimmed.startsWith('v') ? trimmed : `v${trimmed}`
  return RPK_RELEASE_TAG_RE.test(tag) ? tag : null
}

/**
 * Release asset name for a platform.
 * @param {Object} [opts]
 * @param {string} [opts.platform=process.platform]
 * @param {string} [opts.arch=process.arch]
 * @returns {string|null} e.g. "rpk-linux-amd64.zip", or null when unsupported
 */
function rpkAssetName({ platform = process.platform, arch = process.arch } = {}) {
  const osName = RPK_OS_BY_PLATFORM[platform]
  const archName = RPK_ARCH_BY_NODE_ARCH[arch]
  if (!osName || !archName) return null
  return `rpk-${osName}-${archName}.zip`
}

/**
 * goreleaser checksums file name for a tag.
 * @param {string} tag - e.g. "v26.2.2"
 * @returns {string} e.g. "rpk_26.2.2_checksums.txt"
 */
function rpkChecksumsName(tag) {
  return `rpk_${tag.replace(/^v/, '')}_checksums.txt`
}

/**
 * Build a CDN URL.
 * @param {string} prefix - "v26.2.2" or "latest"
 * @param {string} fileName
 */
function rpkCdnUrl(prefix, fileName) {
  return `${RPK_CDN_BASE}/${prefix}/${fileName}`
}

/**
 * All URLs for a tag on the current (or given) platform.
 * @param {string} tag - normalised tag
 * @param {Object} [opts] - platform/arch overrides (see rpkAssetName)
 * @returns {{ zip: string, checksums: string, assetName: string, checksumsName: string }|null}
 */
function rpkCdnUrls(tag, opts = {}) {
  const assetName = rpkAssetName(opts)
  if (!assetName) return null
  const checksumsName = rpkChecksumsName(tag)
  return {
    assetName,
    checksumsName,
    zip: rpkCdnUrl(tag, assetName),
    checksums: rpkCdnUrl(tag, checksumsName)
  }
}

function isNotPublished(httpCode) {
  return NOT_PUBLISHED_HTTP_CODES.has(httpCode)
}

function parseHttpCode(stdout) {
  const trimmed = String(stdout || '').trim()
  return parseInt(trimmed.slice(-3), 10) || 0
}

/**
 * Download a URL to a file with curl.
 *
 * The HTTP status travels through -w '%{http_code}' rather than curl's exit
 * code: with -f a 403 exits 22 on most builds but 56 on others, so callers
 * gate on the status. --retry alone only retries transient errors (timeouts,
 * 5xx, 429); --retry-all-errors is deliberately absent so a deterministic
 * 403 for an unpublished version is not retried for half a minute.
 *
 * @param {string} url
 * @param {string} dest - Output path; removed again on failure
 * @param {Object} [opts]
 * @param {number} [opts.maxTime=300] - curl --max-time in seconds
 * @param {number} [opts.retries=3]
 * @returns {{ ok: boolean, httpCode: number, status: number|null, stderr: string }}
 */
function curlToFile(url, dest, { maxTime = 300, retries = 3 } = {}) {
  const result = spawnSync('curl', [
    '-sSfL', '--retry', String(retries),
    '--connect-timeout', '30', '--max-time', String(maxTime),
    '-o', dest, '-w', '%{http_code}', url
  ], { encoding: 'utf8', timeout: (maxTime + 60) * 1000 })

  const httpCode = parseHttpCode(result.stdout)
  const ok = result.status === 0 && httpCode === 200
  if (!ok) {
    // A mid-transfer failure can leave a partial file behind even with -f
    fs.rmSync(dest, { force: true })
  }
  return { ok, httpCode, status: result.status, stderr: (result.stderr || '').trim() }
}

/**
 * HEAD a URL and return its HTTP status (0 when curl itself failed).
 * @param {string} url
 * @returns {number}
 */
function curlHead(url) {
  const result = spawnSync('curl', [
    '-sfIL', '--retry', '3',
    '--connect-timeout', '15', '--max-time', '30',
    '-o', os.devNull, '-w', '%{http_code}', url
  ], { encoding: 'utf8', timeout: 90000 })
  return parseHttpCode(result.stdout)
}

/**
 * Find the expected sha256 for an asset in a sha256sum-format checksums file.
 * @param {string} text - checksums file content
 * @param {string} assetName
 * @returns {string|null} lowercase hex digest, or null when the asset is not listed
 */
function parseChecksums(text, assetName) {
  const line = String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => l.endsWith(assetName))
  if (!line) return null
  const [digest] = line.split(/\s+/)
  return digest ? digest.toLowerCase() : null
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

/**
 * Download and verify the rpk release binary for a tag.
 *
 * Returns null whenever the CDN has no complete build for the tag (HTTP
 * 403/404 on the checksums file or the zip, network failure) so callers can
 * fall back to a source build. Throws only for a published build that is
 * wrong: a checksums file without this asset, a digest mismatch, or an
 * archive that does not extract to an rpk binary.
 *
 * @param {string} version - Release tag or bare version (GA or RC)
 * @param {string} destDir - Directory to download and extract into
 * @param {Object} [opts]
 * @param {string} [opts.platform=process.platform]
 * @param {string} [opts.arch=process.arch]
 * @param {{ log: Function, warn: Function }} [opts.log=console]
 * @returns {string|null} Path to the extracted binary, or null when not published
 */
function downloadRpkBinary(version, destDir, { platform = process.platform, arch = process.arch, log = console } = {}) {
  const tag = normalizeRpkTag(version)
  if (!tag) {
    log.warn(`'${version}' is not a release tag (expected vX.Y.Z or vX.Y.Z-rcN); no rpk build to download`)
    return null
  }

  const urls = rpkCdnUrls(tag, { platform, arch })
  if (!urls) {
    log.warn(`No rpk release asset for platform ${platform}/${arch}`)
    return null
  }

  // The checksums file first: it is small, it is uploaded together with the
  // zips, and its absence is the cheapest "not published" signal.
  const checksumsPath = path.join(destDir, urls.checksumsName)
  const checksumsResult = curlToFile(urls.checksums, checksumsPath, { maxTime: 60 })
  if (!checksumsResult.ok) {
    if (isNotPublished(checksumsResult.httpCode)) {
      log.warn(`rpk ${tag} is not published on ${RPK_CDN_BASE} (HTTP ${checksumsResult.httpCode} for ${urls.checksums})`)
    } else {
      log.warn(`Could not fetch ${urls.checksums} (HTTP ${checksumsResult.httpCode}, curl exit ${checksumsResult.status}${checksumsResult.stderr ? `: ${checksumsResult.stderr}` : ''})`)
    }
    return null
  }

  log.log(`Downloading ${urls.assetName} for ${tag} from ${RPK_CDN_BASE}...`)
  const zipPath = path.join(destDir, urls.assetName)
  const zipResult = curlToFile(urls.zip, zipPath, { maxTime: 300 })
  if (!zipResult.ok) {
    if (isNotPublished(zipResult.httpCode)) {
      // Checksums present but zip missing: an upload in progress or a
      // platform the release skipped. Fall back rather than fail.
      log.warn(`rpk ${tag} has a checksums file but no ${urls.assetName} on ${RPK_CDN_BASE} (HTTP ${zipResult.httpCode} for ${urls.zip})`)
    } else {
      log.warn(`Could not download ${urls.zip} (HTTP ${zipResult.httpCode}, curl exit ${zipResult.status}${zipResult.stderr ? `: ${zipResult.stderr}` : ''})`)
    }
    return null
  }

  const expected = parseChecksums(fs.readFileSync(checksumsPath, 'utf8'), urls.assetName)
  if (!expected) {
    throw new Error(`${urls.checksumsName} for ${tag} lists no entry for ${urls.assetName}; refusing to install an unverified binary`)
  }
  const actual = sha256File(zipPath)
  if (expected !== actual) {
    throw new Error(
      `Checksum mismatch for ${urls.assetName} (${tag}):\n` +
      `  expected ${expected}\n  actual   ${actual}`
    )
  }
  log.log('Checksum verified')

  const unzipResult = spawnSync('unzip', ['-o', zipPath, '-d', destDir], {
    encoding: 'utf8',
    timeout: 60000
  })
  if (unzipResult.status !== 0) {
    throw new Error(`Failed to extract ${urls.assetName}: ${unzipResult.stderr}`)
  }

  const binPath = path.join(destDir, 'rpk')
  if (!fs.existsSync(binPath)) {
    throw new Error(`Extracted archive did not contain an rpk binary: ${zipPath}`)
  }
  fs.chmodSync(binPath, 0o755)
  return binPath
}

/**
 * Newest GA tag on streaming-enterprise that has a build on the CDN.
 * Tags, not releases: RC tags never had a GitHub Release, and GA releases
 * stopped being published with the S3 move.
 */
async function newestPublishedGaTagFromGitHub(octokit, probe, { platform, arch, log }) {
  const semver = require('semver')
  const refs = await octokit.paginate(octokit.rest.git.listMatchingRefs, {
    owner: TAGS_OWNER,
    repo: TAGS_REPO,
    ref: 'tags/v',
    per_page: 100
  })
  const gaTags = refs
    .map(r => r.ref.replace(/^refs\/tags\//, ''))
    .filter(t => RPK_GA_TAG_RE.test(t))
  const versions = semver.rsort(gaTags.map(t => t.slice(1)))
  // A tag can exist a few minutes before its build lands, so walk down a
  // handful of candidates instead of trusting the newest tag blindly.
  for (const v of versions.slice(0, 5)) {
    const tag = `v${v}`
    const urls = rpkCdnUrls(tag, { platform, arch })
    const code = probe(urls.checksums)
    if (code === 200) return tag
    log.warn(`Newest tag ${tag} has no build on ${RPK_CDN_BASE} yet (HTTP ${code}); trying the previous GA`)
  }
  return null
}

/**
 * Identify the version behind latest/ by downloading it and asking the
 * binary. The CDN has no listing and no version marker, so this is the only
 * tokenless way to learn what latest/ holds. The caller then installs that
 * tag through downloadRpkBinary so the installed bytes are checksum-verified;
 * this probe only guards integrity (same origin as the checksums), not
 * provenance.
 */
function versionBehindLatest(probe, { platform, arch, log }) {
  const assetName = rpkAssetName({ platform, arch })
  if (!assetName) return null
  const latestZipUrl = rpkCdnUrl(RPK_CDN_LATEST_PREFIX, assetName)
  const code = probe(latestZipUrl)
  if (code !== 200) {
    log.warn(`${RPK_CDN_LATEST_PREFIX}/ is not populated on ${RPK_CDN_BASE} (HTTP ${code} for ${latestZipUrl})`)
    return null
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-latest-'))
  try {
    const zipPath = path.join(tmpDir, assetName)
    const dl = curlToFile(latestZipUrl, zipPath, { maxTime: 300 })
    if (!dl.ok) {
      log.warn(`Could not download ${latestZipUrl} (HTTP ${dl.httpCode})`)
      return null
    }
    const unzip = spawnSync('unzip', ['-o', zipPath, '-d', tmpDir], { encoding: 'utf8', timeout: 60000 })
    const binPath = path.join(tmpDir, 'rpk')
    if (unzip.status !== 0 || !fs.existsSync(binPath)) {
      log.warn(`Could not extract ${assetName} from ${RPK_CDN_LATEST_PREFIX}/`)
      return null
    }
    fs.chmodSync(binPath, 0o755)
    const ver = spawnSync(binPath, ['--version'], { encoding: 'utf8', timeout: 30000 })
    const match = `${ver.stdout || ''}\n${ver.stderr || ''}`.match(/v\d+\.\d+\.\d+(-rc\d+)?/)
    if (!match) {
      log.warn(`Could not read a version from the ${RPK_CDN_LATEST_PREFIX}/ rpk binary`)
      return null
    }
    return match[0]
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

/**
 * Resolve the tag to install when the caller wants "the latest rpk".
 *
 * Order:
 *   1. RPK_VERSION in the environment (pin; invalid shapes throw)
 *   2. With a GitHub token: newest GA tag on streaming-enterprise whose
 *      build exists on the CDN (verified before anything runs)
 *   3. latest/ on the CDN, identified by running the binary once
 *   4. throw with a message that names the RPK_VERSION escape hatch
 *
 * @param {Object} [opts]
 * @param {Object} [opts.env=process.env]
 * @param {Object} [opts.octokit] - Octokit instance; defaults to the shared client when a token exists
 * @param {Function} [opts.probe=curlHead] - url -> http status, injectable for tests
 * @param {string} [opts.platform], [opts.arch]
 * @param {{ log: Function, warn: Function }} [opts.log=console]
 * @returns {Promise<string>} normalised tag
 */
async function resolveLatestRpkTag({
  env = process.env,
  octokit,
  probe = curlHead,
  platform = process.platform,
  arch = process.arch,
  log = console
} = {}) {
  if (env.RPK_VERSION) {
    const pinned = normalizeRpkTag(env.RPK_VERSION)
    if (!pinned) {
      throw new Error(`RPK_VERSION='${env.RPK_VERSION}' is not a release tag; expected vX.Y.Z or vX.Y.Z-rcN`)
    }
    return pinned
  }

  const { getGitHubApiToken } = require('./github-token')
  if (getGitHubApiToken()) {
    const client = octokit || require('./octokit-client')
    try {
      const tag = await newestPublishedGaTagFromGitHub(client, probe, { platform, arch, log })
      if (tag) return tag
    } catch (err) {
      log.warn(`Could not list ${TAGS_OWNER}/${TAGS_REPO} tags: ${err.message}`)
    }
  }

  const fromLatest = versionBehindLatest(probe, { platform, arch, log })
  if (fromLatest) return fromLatest

  throw new Error(
    `Could not resolve the latest rpk release: ${RPK_CDN_LATEST_PREFIX}/ is empty on ${RPK_CDN_BASE} ` +
    `and no GitHub token is available to list ${TAGS_OWNER}/${TAGS_REPO} tags. ` +
    'Set RPK_VERSION=vX.Y.Z or provide a token (GH_TOKEN, GITHUB_TOKEN, or REDPANDA_GITHUB_TOKEN).'
  )
}

// --- CLI ----------------------------------------------------------------------
// stdout carries only the result so shell callers can capture it; everything
// else goes to stderr. Exit 0 ok, 2 not published / unresolvable, 1 unexpected.

const EXIT_NOT_PUBLISHED = 2

function usage() {
  return [
    'Usage:',
    '  node rpk-cdn.js install --dest <dir> [--version <tag>] [--platform <p>] [--arch <a>]',
    '      Download and verify rpk; prints the binary path. Without --version, resolves the',
    '      latest release (RPK_VERSION, then GitHub tags with a token, then latest/).',
    '  node rpk-cdn.js resolve-latest [--platform <p>] [--arch <a>]',
    '      Prints the tag "install" would use.',
    '  node rpk-cdn.js url --tag <tag> [--platform <p>] [--arch <a>]',
    '      Prints the zip and checksums URLs for a tag.'
  ].join('\n')
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const opts = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument '${arg}'\n${usage()}`)
    const key = arg.slice(2)
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value\n${usage()}`)
    opts[key] = value
    i++
  }
  return { command, opts }
}

async function main(argv) {
  const stderrLog = { log: (...a) => console.error(...a), warn: (...a) => console.error(...a) }
  const { command, opts } = parseArgs(argv)
  const platformOpts = {
    platform: opts.platform || process.platform,
    arch: opts.arch || process.arch,
    log: stderrLog
  }

  switch (command) {
    case 'url': {
      const tag = normalizeRpkTag(opts.tag || '')
      if (!tag) {
        console.error(`'${opts.tag}' is not a release tag; expected vX.Y.Z or vX.Y.Z-rcN`)
        return EXIT_NOT_PUBLISHED
      }
      const urls = rpkCdnUrls(tag, platformOpts)
      if (!urls) {
        console.error(`No rpk release asset for platform ${platformOpts.platform}/${platformOpts.arch}`)
        return EXIT_NOT_PUBLISHED
      }
      process.stdout.write(`${urls.zip}\n${urls.checksums}\n`)
      return 0
    }
    case 'resolve-latest': {
      const tag = await resolveLatestRpkTag(platformOpts)
      process.stdout.write(`${tag}\n`)
      return 0
    }
    case 'install': {
      if (!opts.dest) throw new Error(`install requires --dest <dir>\n${usage()}`)
      const tag = opts.version
        ? normalizeRpkTag(opts.version)
        : await resolveLatestRpkTag(platformOpts)
      if (!tag) {
        console.error(`'${opts.version}' is not a release tag; expected vX.Y.Z or vX.Y.Z-rcN`)
        return EXIT_NOT_PUBLISHED
      }
      fs.mkdirSync(opts.dest, { recursive: true })
      const binPath = downloadRpkBinary(tag, opts.dest, platformOpts)
      if (!binPath) return EXIT_NOT_PUBLISHED
      process.stdout.write(`${binPath}\n`)
      return 0
    }
    default:
      throw new Error(`Unknown command '${command || ''}'\n${usage()}`)
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    err => {
      console.error(err.message)
      // Unresolvable "latest" is a not-published condition, not a bug
      process.exit(/Could not resolve the latest rpk release/.test(err.message) ? EXIT_NOT_PUBLISHED : 1)
    }
  )
}

module.exports = {
  RPK_CDN_BASE,
  RPK_CDN_LATEST_PREFIX,
  RPK_RELEASE_TAG_RE,
  RPK_GA_TAG_RE,
  RPK_OS_BY_PLATFORM,
  RPK_ARCH_BY_NODE_ARCH,
  normalizeRpkTag,
  rpkAssetName,
  rpkChecksumsName,
  rpkCdnUrl,
  rpkCdnUrls,
  isNotPublished,
  curlToFile,
  curlHead,
  parseChecksums,
  sha256File,
  downloadRpkBinary,
  resolveLatestRpkTag
}
