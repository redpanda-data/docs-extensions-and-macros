'use strict'

// Reads a Connect release's connector data from its docs asset.
//
// From the release that includes redpanda-data/connect#4947, docs_gen writes
// modules/components/attachments/connect-<version>.json into the
// redpanda-connect-docs.tar.gz release asset. It is the
// `list --format json-full` schema with cloudSupported and requiresCgo on every
// component and config object, and cloudOnly on the components only Redpanda
// Cloud runs. That is everything the binary analyzer works out by downloading
// and diffing the standard, Cloud, and cgo binaries, so a release that has the
// file needs no binaries. Older releases (v4.115.x and earlier) have no such
// file, and their callers fall back to the binary analysis.

const asset = require('../../extensions/util/connect-docs-asset.js')
const { getGitHubApiToken } = require('../../cli-utils/github-token')

const PLATFORM_FLAGS = ['cloudSupported', 'requiresCgo', 'cloudOnly']

// `undocumented` is a list of components, not a component group.
const arrayKeys = (data) => Object.keys(data).filter((k) => k !== 'undocumented' && Array.isArray(data[k]))

function attachmentPath (version) {
  return `modules/components/attachments/connect-${version}.json`
}

// Throws when the file is not a connector index for this version, so a bad
// asset fails the run instead of publishing wrong platform data.
function validateAttachment (data, version) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${attachmentPath(version)} is not a connector index`)
  }
  if (data.version !== version) {
    throw new Error(`${attachmentPath(version)} reports version ${data.version}`)
  }
  if (!Array.isArray(data.inputs) || data.inputs.length === 0) {
    throw new Error(`${attachmentPath(version)} has no inputs`)
  }
  // Every component group and config carries the flags. Only the Bloblang
  // groups carry none, by design.
  const flagged = (c) => c && typeof c.cloudSupported === 'boolean' && typeof c.requiresCgo === 'boolean'
  const unflagged = arrayKeys(data).filter((k) => !k.startsWith('bloblang-') && !data[k].every(flagged))
  if (unflagged.length > 0) {
    throw new Error(`${attachmentPath(version)} has ${unflagged.join(', ')} without cloudSupported and requiresCgo flags`)
  }
  return data
}

// The parsed attachment from the files of a docs asset, or null when the
// asset has no attachment for this version.
function attachmentFromFiles (files, version) {
  const wanted = attachmentPath(version)
  const file = files.find((f) => String(f.path).replace(/^(\.\/)+/, '') === wanted)
  if (!file) return null
  let data
  try {
    data = JSON.parse(Buffer.from(file.contents).toString('utf8'))
  } catch (error) {
    throw new Error(`${wanted} in the v${version} ${asset.ASSET_NAME} is not valid JSON: ${error.message}`)
  }
  return validateAttachment(data, version)
}

const cache = new Map()
// Versions whose cached null means the release had no docs asset at all, as
// opposed to an asset without the attachment file.
const noAsset = new Set()

/**
 * Downloads the v<version> docs asset and returns its connect-<version>.json,
 * or null when the release has no asset or the asset has no such file.
 * Results are cached per version for the life of the process, so a
 * multi-release run downloads each asset once.
 *
 * @param {string} version - Connect version, such as 4.116.0
 * @param {Object} [options]
 * @param {Function} [options.fetchImpl] - fetch implementation (tests)
 * @param {string|null} [options.token] - GitHub token; defaults to the environment's
 * @returns {Promise<Object|null>}
 */
function loadReleaseAttachment (version, { fetchImpl, token = getGitHubApiToken(), logger = console } = {}) {
  if (!cache.has(version)) {
    const pending = (async () => {
      const archive = await asset.downloadAsset(`v${version}`, { fetchImpl, token, logger })
      if (!archive) {
        noAsset.add(version)
        return null
      }
      noAsset.delete(version)
      return attachmentFromFiles(await asset.readTarGz(archive), version)
    })()
    // A failed download is not cached, so a later call can retry it.
    pending.catch(() => cache.delete(version))
    cache.set(version, pending)
  }
  return cache.get(version)
}

function clearAttachmentCache () {
  cache.clear()
  noAsset.clear()
}

const minutes = (name, fallback) => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= 0 ? n * 60000 : fallback
}

/**
 * loadReleaseAttachment(), but for a release published in the last
 * `freshMs` whose docs asset is not attached yet, it checks again every
 * `pollMs` for up to `waitMs` before returning null. Connect attaches the
 * asset some minutes after it publishes the release, and a docs run that
 * starts in between would otherwise fall back to comparing the binaries.
 * An older release, or one whose asset is attached but has no attachment
 * file, returns null at once, as loadReleaseAttachment() does.
 *
 * RPCN_DOCS_ASSET_WAIT_MINUTES (default 15) and
 * RPCN_DOCS_ASSET_FRESH_MINUTES (default 120) override the limits; a wait
 * of 0 turns the wait off.
 */
async function waitForReleaseAttachment (version, {
  fetchImpl,
  token = getGitHubApiToken(),
  logger = console,
  waitMs = minutes('RPCN_DOCS_ASSET_WAIT_MINUTES', 15 * 60000),
  freshMs = minutes('RPCN_DOCS_ASSET_FRESH_MINUTES', 120 * 60000),
  pollMs = 60000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  // Through module.exports, so a test that stubs loadReleaseAttachment stubs this too.
  const data = await module.exports.loadReleaseAttachment(version, { fetchImpl, token, logger })
  if (data || waitMs <= 0) return data
  const tag = `v${version}`
  let state = await module.exports.releaseState(tag, { fetchImpl, token })
  if (state && state.hasAsset && noAsset.has(version)) {
    // Attached between the download and this lookup: read it now. An asset
    // that was there and lacks the file still falls back at once.
    cache.delete(version)
    return module.exports.loadReleaseAttachment(version, { fetchImpl, token, logger })
  }
  if (!state || state.hasAsset || !state.publishedAt) return null
  // Kept from the first read: a later poll can fail and return null.
  const publishedAt = state.publishedAt.getTime()
  if (now() - publishedAt > freshMs) return null
  const deadline = now() + waitMs
  while (now() < deadline) {
    logger.log(`ℹ️  ${tag} was published ${Math.round((now() - publishedAt) / 60000)} min ago and has no ${asset.ASSET_NAME} yet; checking again in ${Math.round(pollMs / 1000)}s (up to ${Math.round((deadline - now()) / 60000)} min more)`)
    await sleep(pollMs)
    state = await module.exports.releaseState(tag, { fetchImpl, token })
    if (state && state.hasAsset) {
      cache.delete(version)
      return module.exports.loadReleaseAttachment(version, { fetchImpl, token, logger })
    }
  }
  logger.log(`ℹ️  ${tag} still has no ${asset.ASSET_NAME} after ${Math.round(waitMs / 60000)} min`)
  return null
}

const isExtra = (c) => c && (c.requiresCgo === true || c.cloudOnly === true)

/**
 * What the standard binary's `list --format json-full` prints for the release:
 * the attachment without cgo-only and cloud-only components and without the
 * platform flags. This is the same raw snapshot loadConnectorDataForVersion
 * would otherwise make from the downloaded OSS binary.
 */
function ossIndexFromAttachment (data) {
  const index = JSON.parse(JSON.stringify(data))
  delete index.undocumented
  for (const key of arrayKeys(index)) {
    index[key] = index[key].filter((c) => !isExtra(c))
    for (const c of index[key]) {
      if (c && typeof c === 'object') for (const flag of PLATFORM_FLAGS) delete c[flag]
    }
  }
  return index
}

/**
 * The attachment's platform data in the shape analyzeAllBinaries() returns, so
 * augmentation, What's new, drafts, and the diff JSON read it unchanged.
 *
 * - comparison.inCloud: standard-build components Cloud runs
 * - comparison.notInCloud: standard-build components Cloud does not run
 * - comparison.cloudOnly: components only Cloud runs, with their full schema
 * - cgoOnly: components only cgo builds have, with their full schema
 *
 * Only the groups the attachment flags are covered (the component groups and
 * config). Bloblang functions and methods carry no platform flags, so unlike
 * the binary analysis this reports no Cloud support for them; coveredTypes
 * lists what is covered so a diff against an older binary analysis skips the
 * rest.
 */
function binaryAnalysisFromAttachment (data) {
  const inCloud = []
  const notInCloud = []
  const cloudOnly = []
  const cgoOnly = []
  const coveredTypes = []
  for (const type of arrayKeys(data)) {
    const flagged = data[type].filter((c) => c && c.name && typeof c.cloudSupported === 'boolean')
    if (flagged.length === 0) continue
    coveredTypes.push(type)
    for (const c of flagged) {
      const status = c.status || c.type || 'stable'
      if (c.cloudOnly === true) {
        cloudOnly.push({ ...c, type, name: c.name, status: c.status || 'stable', reason: 'cloud-only' })
      } else if (c.requiresCgo === true) {
        cgoOnly.push({ ...c, type, requiresCgo: true })
      } else if (c.cloudSupported) {
        inCloud.push({ type, name: c.name, status })
      } else {
        notInCloud.push({ type, name: c.name, status, reason: 'self-hosted-only' })
      }
    }
  }
  return {
    source: 'release-asset',
    ossVersion: data.version,
    cloudVersion: data.version,
    cgoVersion: data.version,
    comparison: {
      inCloud,
      notInCloud,
      cloudOnly,
      totalOss: inCloud.length + notInCloud.length,
      totalCloud: inCloud.length + cloudOnly.length
    },
    cloudIndex: null,
    cgoIndex: null,
    cgoOnly,
    coveredTypes
  }
}

/**
 * The components a Connect release build registers that docs_gen does not
 * document, so they have no docs page. redpanda-data/connect#4947 writes them
 * to the attachment's top-level `undocumented` list as
 * `{ type, name, builds }`. Assets from before that field have no list, which
 * reads as empty. Malformed entries are skipped with one warning; this never
 * throws, because a gap in the docs should not stop generation.
 *
 * @param {Object|null} data - The attachment
 * @param {Object} [options]
 * @param {Object} [options.logger] - console stand-in (tests)
 * @returns {Array<{type: string, name: string, builds: string[]}>}
 */
function undocumentedFromAttachment (data, { logger = console } = {}) {
  const list = data && data.undocumented
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) {
    logger.warn(`⚠️  Ignoring the attachment's undocumented field: expected a list, got ${typeof list}`)
    return []
  }
  const isText = (v) => typeof v === 'string' && v.length > 0
  const valid = list.filter((e) => e && isText(e.type) && isText(e.name) &&
    Array.isArray(e.builds) && e.builds.length > 0 && e.builds.every(isText))
  if (valid.length < list.length) {
    logger.warn(`⚠️  Skipped ${list.length - valid.length} malformed entr${list.length - valid.length === 1 ? 'y' : 'ies'} in the attachment's undocumented list`)
  }
  return valid.map((e) => ({ type: e.type, name: e.name, builds: [...e.builds] }))
}

function undocumentedWarning ({ type, name, builds }) {
  const plural = builds.length === 1 ? 'build' : 'builds'
  return `⚠️  ${type}/${name} ships in the ${builds.join(', ')} ${plural} but Connect's docs_gen doesn't document it, so it has no docs page. Add its package to cmd/tools/docs_gen/allcomponents in redpanda-data/connect.`
}

module.exports = {
  undocumentedFromAttachment,
  undocumentedWarning,
  attachmentPath,
  attachmentFromFiles,
  validateAttachment,
  loadReleaseAttachment,
  waitForReleaseAttachment,
  // Re-exported so tests can stub the release lookup.
  releaseState: (...args) => asset.releaseState(...args),
  clearAttachmentCache,
  ossIndexFromAttachment,
  binaryAnalysisFromAttachment
}
