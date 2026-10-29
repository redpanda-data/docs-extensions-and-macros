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
  if (!data.inputs.every((c) => typeof c.cloudSupported === 'boolean' && typeof c.requiresCgo === 'boolean')) {
    throw new Error(`${attachmentPath(version)} has inputs without cloudSupported and requiresCgo flags`)
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
      if (!archive) return null
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
}

const arrayKeys = (data) => Object.keys(data).filter((k) => Array.isArray(data[k]))
const isExtra = (c) => c && (c.requiresCgo === true || c.cloudOnly === true)

/**
 * What the standard binary's `list --format json-full` prints for the release:
 * the attachment without cgo-only and cloud-only components and without the
 * platform flags. This is the same raw snapshot loadConnectorDataForVersion
 * would otherwise make from the downloaded OSS binary.
 */
function ossIndexFromAttachment (data) {
  const index = JSON.parse(JSON.stringify(data))
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

module.exports = {
  attachmentPath,
  attachmentFromFiles,
  validateAttachment,
  loadReleaseAttachment,
  clearAttachmentCache,
  ossIndexFromAttachment,
  binaryAnalysisFromAttachment
}
