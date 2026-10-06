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
  try {
    tarBuffer = zlib.gunzipSync(buffer)
  } catch (error) {
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

// Downloads the asset of a release tag. Returns null when the release has no
// asset (404). Throws on any other failure, after retrying network errors and
// server errors.
async function downloadAsset (tag, { fetchImpl = globalThis.fetch, logger } = {}) {
  const url = assetUrl(tag)
  let lastError = null
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    let response
    let body
    try {
      response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), headers: { 'User-Agent': 'Redpanda Docs' } })
      // Read the body inside the try, so a connection that drops or times
      // out mid-download is retried like a failed request.
      if (response.ok) body = Buffer.from(await response.arrayBuffer())
    } catch (error) {
      response = undefined
      lastError = new Error(`could not download ${url}: ${error.message}`)
    }
    if (body) return body
    if (response) {
      if (response.status === 404) return null
      lastError = new Error(`could not download ${url}: HTTP ${response.status} ${response.statusText || ''}`.trim())
      // A client error other than 404 will not change on a retry.
      if (response.status < 500 && response.status !== 429) break
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
module.exports = { OWNER, REPO, ASSET_NAME, MODULE, retryDelayMs: 1000, assetUrl, toResource, readTarGz, downloadAsset, readLocal }
