'use strict'

// Reads the Redpanda Connect generated reference docs.
//
// Every connect release (vX.Y.Z, including prereleases) publishes a
// redpanda-connect-docs.tar.gz asset whose root is `modules/`: the tree that
// connect's docs generator writes under its docs/ directory. Only
// modules/components/partials/** and modules/components/examples/** belong to
// the reference. Releases from before the asset existed answer 404.
//
// The same tree can come from a local directory instead (a connect checkout's
// docs/ after running its generator), or from a local copy of the tarball.

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const OWNER = 'redpanda-data'
const REPO = 'connect'
const ASSET_NAME = 'redpanda-connect-docs.tar.gz'
const MODULE = 'components'
const FAMILY_DIRS = { partials: 'partial', examples: 'example' }
const DOWNLOAD_ATTEMPTS = 3
const DOWNLOAD_TIMEOUT_MS = 120000

function assetUrl (tag) {
  return `https://github.com/${OWNER}/${REPO}/releases/download/${encodeURIComponent(tag)}/${ASSET_NAME}`
}

// The Antora resource of a path inside the tree, or null for anything outside
// modules/components/partials and modules/components/examples.
function toResource (entryPath) {
  const p = String(entryPath || '').replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  const m = p.match(/^modules\/components\/(partials|examples)\/(.+)$/)
  if (!m || m[2].endsWith('/')) return null
  // A path that climbs out of its directory is not part of the tree.
  if (m[2].split('/').some((segment) => segment === '..' || segment === '')) return null
  return { family: FAMILY_DIRS[m[1]], relative: m[2], path: `modules/components/${m[1]}/${m[2]}` }
}

// Every regular file in a gzipped tar, as [{ path, contents }]. Throws on a
// corrupt or truncated archive rather than returning a partial list.
async function readTarGz (buffer) {
  let tarBuffer
  // The real asset unpacks to a few tens of MB. The cap turns a bad asset
  // into a clear error instead of running the build out of memory.
  const limit = module.exports.maxUnpackedBytes
  try {
    tarBuffer = zlib.gunzipSync(buffer, { maxOutputLength: limit })
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`the archive unpacks to more than ${limit} bytes, which no real reference docs asset does`)
    }
    throw new Error(`not a valid gzip archive: ${error.message}`)
  }
  // A complete tar ends with two zero blocks. Without them the archive was cut
  // short at an entry boundary, which the parser alone does not report.
  const end = tarBuffer.subarray(Math.max(0, tarBuffer.length - 1024))
  if (tarBuffer.length % 512 !== 0 || end.length < 1024 || end.some((b) => b !== 0)) {
    throw new Error('not a valid tar archive: missing the end-of-archive marker, so the archive is truncated')
  }
  const { Parser } = require('tar')
  return new Promise((resolve, reject) => {
    const files = []
    let failure = null
    const parser = new Parser({ strict: true })
    parser.on('entry', (entry) => {
      if (entry.type !== 'File' && entry.type !== 'OldFile' && entry.type !== 'ContiguousFile') {
        entry.resume()
        return
      }
      const chunks = []
      entry.on('data', (chunk) => chunks.push(chunk))
      entry.on('end', () => files.push({ path: entry.path, contents: Buffer.concat(chunks) }))
    })
    const fail = (error) => { if (!failure) failure = error }
    parser.on('warn', (code, message) => fail(new Error(`not a valid tar archive: ${message}`)))
    parser.on('error', (error) => fail(new Error(`not a valid tar archive: ${error.message}`)))
    parser.on('close', () => (failure ? reject(failure) : resolve(files)))
    try {
      parser.end(tarBuffer)
    } catch (error) {
      fail(new Error(`not a valid tar archive: ${error.message}`))
      reject(failure)
    }
  })
}

// One download attempt: { status } on an HTTP error, { body } on success.
// With a token it goes through the releases API, which works whether or not
// the connect repo is public. The asset endpoint redirects to a short-lived
// signed URL, which is fetched without the token.
async function fetchAssetOnce (tag, { fetchImpl, token }) {
  const timeout = () => AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  const ua = { 'User-Agent': 'Redpanda Docs' }
  if (!token) {
    const response = await fetchImpl(assetUrl(tag), { redirect: 'follow', signal: timeout(), headers: ua })
    // Read the body here, so a connection that drops or times out
    // mid-download is retried like a failed request.
    return response.ok ? { body: Buffer.from(await response.arrayBuffer()) } : { status: response.status, statusText: response.statusText }
  }
  const auth = { ...ua, Authorization: `Bearer ${token}` }
  const api = `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`
  const release = await fetchImpl(api, { signal: timeout(), headers: { ...auth, Accept: 'application/vnd.github+json' } })
  // A token that is expired or lacks access must not break a build that the
  // public download would serve.
  if (release.status === 401 || release.status === 403) return fetchAssetOnce(tag, { fetchImpl, token: null })
  if (!release.ok) return { status: release.status, statusText: release.statusText }
  const found = ((await release.json()).assets || []).find((a) => a.name === ASSET_NAME)
  if (!found) return { status: 404, statusText: 'Not Found' }
  let response = await fetchImpl(found.url, { redirect: 'manual', signal: timeout(), headers: { ...auth, Accept: 'application/octet-stream' } })
  if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
    response = await fetchImpl(response.headers.get('location'), { redirect: 'follow', signal: timeout(), headers: ua })
  }
  return response.ok ? { body: Buffer.from(await response.arrayBuffer()) } : { status: response.status, statusText: response.statusText }
}

// Downloads the asset of a release tag. Returns null when the release has no
// asset (404). Throws on any other failure, after retrying network errors and
// server errors. Pass the GitHub token when there is one: an unauthenticated
// download only works while the connect repo is public.
async function downloadAsset (tag, { fetchImpl = globalThis.fetch, logger, token = null } = {}) {
  const url = token ? `the ${tag} release asset ${ASSET_NAME} through the GitHub API` : assetUrl(tag)
  let lastError = null
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    let result
    try {
      result = await fetchAssetOnce(tag, { fetchImpl, token })
    } catch (error) {
      lastError = new Error(`could not download ${url}: ${error.message}`)
    }
    if (result && result.body) return result.body
    if (result) {
      if (result.status === 404) return null
      lastError = new Error(`could not download ${url}: HTTP ${result.status} ${result.statusText || ''}`.trim())
      // A client error other than 404 will not change on a retry.
      if (result.status < 500 && result.status !== 429) break
    }
    if (attempt < DOWNLOAD_ATTEMPTS) {
      if (logger) logger.warn(`${lastError.message}; retrying (${attempt}/${DOWNLOAD_ATTEMPTS - 1})`)
      await new Promise((resolve) => setTimeout(resolve, module.exports.retryDelayMs * attempt))
    }
  }
  throw lastError
}

function walk (dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) walk(abs, rel, out)
    else if (entry.isFile()) out.push({ path: rel, abspath: abs })
  }
  return out
}

// The files of a local copy of the tree: a directory that contains modules/
// (or a connect checkout whose docs/ does), or a local .tar.gz of the asset.
async function readLocal (location) {
  const resolved = path.resolve(location)
  let stat
  try {
    stat = fs.statSync(resolved)
  } catch (error) {
    throw new Error(`${resolved} does not exist`)
  }
  if (stat.isFile()) return readTarGz(fs.readFileSync(resolved))
  let root = resolved
  if (!fs.existsSync(path.join(root, 'modules')) && fs.existsSync(path.join(root, 'docs', 'modules'))) root = path.join(root, 'docs')
  if (!fs.existsSync(path.join(root, 'modules', MODULE))) {
    throw new Error(`${resolved} has no modules/${MODULE} directory`)
  }
  return walk(path.join(root, 'modules', MODULE), `modules/${MODULE}`, [])
    .map((f) => ({ path: f.path, contents: fs.readFileSync(f.abspath) }))
}

// retryDelayMs is a property so tests can shorten the backoff.
module.exports = { OWNER, REPO, ASSET_NAME, MODULE, retryDelayMs: 1000, maxUnpackedBytes: 512 * 1024 * 1024, assetUrl, toResource, readTarGz, downloadAsset, readLocal }
