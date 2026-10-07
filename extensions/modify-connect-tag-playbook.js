'use strict';

// Sources the Redpanda Connect generated reference docs (field reference,
// examples, metadata, descriptions, config snippets, Bloblang reference, and
// platforms/catalog.json) for the `connect` component.
//
// The default: the playbook has no connect content source. Every connect
// release publishes the generated tree as a redpanda-connect-docs.tar.gz
// release asset (util/connect-docs-asset). In contentClassified, the extension
// resolves the release to use, downloads that asset, and adds its partials and
// examples to the `connect` component that rp-connect-docs provides:
//
// - The latest stable vX.Y.Z release by default, so the docs never show fields
//   from unreleased code on connect's main branch.
// - The `tag` extension config key picks a specific release instead.
// - The REDPANDA_CONNECT_DOCS_DIR environment variable points at a local copy
//   of the tree (a directory that contains modules/, such as a connect
//   checkout's docs/ after running its generator, or a local copy of the
//   tarball) to preview unreleased connect changes. It wins over everything.
//
// Connect publishes a release first and attaches the asset later, in a
// separate job that can also fail. So when the latest release has no asset
// (404), the extension falls back to the newest older stable release that has
// one, and logs a warning that names both. It checks the asset lists from the
// GitHub releases API (at most FALLBACK_RELEASE_LIMIT releases), or, without
// the API, probes the downloads of the next FALLBACK_PROBE_LIMIT lower stable
// tags from git ls-remote. A release picked with the `tag` config never falls
// back. When no release has the asset, nothing is added, and the guard in
// generate-rp-connect-info stops the build if connector pages then have no
// field partials. Any other download or archive failure stops the build here.
// A file another source already provides (rp-connect-docs still commits its
// own copies until it migrates) is skipped.
//
// Backward compatibility: a playbook that still lists the connect repo as a
// content source keeps the previous behavior, and no asset is downloaded:
//
//   - url: https://github.com/redpanda-data/connect
//     tags: latest        # replaced with the latest release tag at build time
//     start_path: docs
//
// 1. A source with `tags: latest` as its only ref is pinned to the latest
//    connect release tag.
// 2. Only the generated modules/components/partials and
//    modules/components/examples trees of the `connect` component are kept
//    from that source, and any file another source already provides is
//    dropped, because Antora fails the build on a duplicate page or partial.
//
// Either way it shares the tag it resolves (util/connect-catalog), so
// generate-rp-connect-info reads info.csv and catalog.json from the same ref
// as the reference content.

const { raiseListenerLimit } = require('./util/raise-listener-limit')
const getLatestConnectTag = require('./version-fetcher/get-latest-connect')
const listConnectReleases = require('./version-fetcher/list-connect-releases')
const { createGitHub } = require('./util/connect-github')
const { isConnectSource, isConnectOrigin, githubRepoOf, setResolvedConnectRef } = require('./util/connect-catalog')
const asset = require('./util/connect-docs-asset')

const OWNER = 'redpanda-data'
const REPO = 'connect'
const COMPONENT = 'connect'
const KEPT_PATHS = ['modules/components/partials/', 'modules/components/examples/']
const CONNECT_URL = `https://github.com/${OWNER}/${REPO}`
const LOCAL_DIR_ENV = 'REDPANDA_CONNECT_DOCS_DIR'
// How many releases the API fallback looks at, and how many lower git tags
// the probe fallback tries, when the latest release has no asset yet.
const FALLBACK_RELEASE_LIMIT = 10
const FALLBACK_PROBE_LIMIT = 3

// HTTPS, SSH (ssh://), and scp-style (git@host:owner/repo) URLs are all
// remote content sources in Antora.
function isRemote (url) {
  return /^(https?|ssh):\/\//.test(url || '') || /^[\w.-]+@[\w.-]+:/.test(url || '')
}

// Only the redpanda-data/connect remote resolves to its own latest release.
// A fork with the same repo name would otherwise be pinned to a tag looked up
// on redpanda-data/connect.
function isUpstreamConnect (url) {
  const repo = githubRepoOf(url)
  return !!repo && repo.owner === OWNER && repo.repo === REPO
}

// Removes user info from every URL in the text, so credentials embedded in a
// content-source URL never reach the build log.
function redact (text) {
  return String(text || '').replace(/([a-z][a-z+.-]*:\/\/)[^@/\s]*@/gi, '$1')
}

// [major, minor, patch] of a stable vX.Y.Z tag, or null for anything else,
// such as a prerelease.
function stableVersion (tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag || '')
  return m ? m.slice(1).map(Number) : null
}

function compareVersions (a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

// Stable vX.Y.Z tags from `git ls-remote` output, highest first.
function stableTags (lsRemoteOutput) {
  const tags = new Set()
  for (const line of String(lsRemoteOutput || '').split('\n')) {
    const m = line.match(/refs\/tags\/(v\d+\.\d+\.\d+)$/)
    if (m) tags.add(m[1])
  }
  return [...tags].sort((a, b) => compareVersions(stableVersion(b), stableVersion(a)))
}

// Highest stable vX.Y.Z tag from `git ls-remote` output. Used when the GitHub
// API is unavailable, for example when an unauthenticated build is rate limited.
function highestStableTag (lsRemoteOutput) {
  return stableTags(lsRemoteOutput)[0] || null
}

function gitTags (url) {
  const { execFileSync } = require('child_process')
  return execFileSync('git', ['ls-remote', '--tags', '--refs', url], { encoding: 'utf8', timeout: 60000 })
}

function latestTagFromGit (url) {
  return highestStableTag(gitTags(url))
}

function toTag (tagName) {
  if (!tagName) return null
  return tagName.startsWith('v') ? tagName : `v${tagName}`
}

// The upstream connect source asks to be pinned with `tags: latest` as its
// only ref. A source with any other refs, such as a fork or a PR branch used
// to preview a connect change, keeps what the playbook says.
function wantsLatest (source) {
  if (!isRemote(source.url) || !isConnectSource(source.url) || !isUpstreamConnect(source.url)) return false
  const tags = Array.isArray(source.tags) ? source.tags : [source.tags]
  const branches = source.branches == null ? [] : [].concat(source.branches)
  return tags.length === 1 && tags[0] === 'latest' && branches.length === 0
}

// Rewrites the connect content sources that ask for the latest release to
// use `tag`. Returns true when a source was updated.
function pinConnectSource (playbook, tag) {
  const sources = playbook && playbook.content && playbook.content.sources
  if (!Array.isArray(sources) || !tag) return false
  let updated = false
  for (const source of sources) {
    if (!wantsLatest(source)) continue
    source.tags = [tag]
    // Without this, Antora's default branch patterns also pull in main.
    source.branches = []
    updated = true
  }
  return updated
}

// Removes connect-sourced files that must not be published. Mutates the
// content aggregate and returns what it dropped.
function filterConnectContent (contentAggregate) {
  const report = { kept: 0, outsideGenerated: 0, providedElsewhere: 0, otherComponents: 0 }
  const fromConnect = (f) => isConnectOrigin(f.src && f.src.origin)
  for (const bucket of contentAggregate) {
    const files = bucket.files || []
    if (!files.some(fromConnect)) continue
    if (bucket.name !== COMPONENT) {
      // Older connect tags name the component redpanda-connect and ship full
      // pages. None of it belongs on the site.
      report.otherComponents += files.filter(fromConnect).length
      bucket.files = files.filter((f) => !fromConnect(f))
      continue
    }
    const provided = new Set(files.filter((f) => !fromConnect(f)).map((f) => f.path))
    bucket.files = files.filter((f) => {
      if (!fromConnect(f)) return true
      if (!KEPT_PATHS.some((p) => f.path.startsWith(p))) {
        report.outsideGenerated++
        return false
      }
      if (provided.has(f.path)) {
        report.providedElsewhere++
        return false
      }
      report.kept++
      return true
    })
  }
  // A bucket left with no files (an older connect tag's own component) would
  // still register an empty component.
  for (let i = contentAggregate.length - 1; i >= 0; i--) {
    const b = contentAggregate[i]
    if (!(b.files || []).length && (b.origins || []).every(isConnectOrigin)) contentAggregate.splice(i, 1)
  }
  return report
}

// True when the playbook lists the connect repo (or a local clone named
// connect) as a content source, which keeps the git source behavior.
function hasConnectSource (playbook) {
  const sources = (playbook && playbook.content && playbook.content.sources) || []
  return sources.some((source) => isConnectSource(source.url))
}

// The latest stable connect release tag: the GitHub API first, then the
// highest stable vX.Y.Z tag from git ls-remote. Null when both fail.
async function resolveLatestTag (url, logger) {
  let tag = null
  try {
    tag = toTag(await getLatestConnectTag(await createGitHub(), OWNER, REPO, logger))
  } catch (error) {
    logger.warn(`GitHub API lookup of the latest Redpanda Connect release failed: ${error.message}`)
  }
  if (!tag) {
    try {
      tag = latestTagFromGit(url)
      if (tag) logger.info(`Resolved the latest Redpanda Connect release from git tags: ${tag}`)
    } catch (error) {
      logger.warn(redact(`git ls-remote of ${url} failed: ${error.message}`))
    }
  }
  return tag
}

// Downloads the asset of a release. Null on a 404; throws on any other failure.
async function downloadRelease (tag, logger) {
  try {
    return await asset.downloadAsset(tag, { logger })
  } catch (error) {
    throw new Error(`Could not download the Redpanda Connect reference docs for ${tag}: ${error.message}`)
  }
}

// The newest stable release older than `latestTag` that has the asset, as
// { tag, archive }, or null when none has it. The GitHub releases API lists
// the most recent releases with their assets, so only the chosen release is
// downloaded. Without the API, it probes the downloads of the next few lower
// stable tags from git ls-remote instead.
async function findOlderReleaseWithAsset (latestTag, url, logger) {
  const latest = stableVersion(latestTag)
  const isOlder = (tag) => {
    const v = stableVersion(tag)
    return !!v && (!latest || compareVersions(v, latest) < 0)
  }
  let releases = null
  try {
    releases = await listConnectReleases(await createGitHub(), OWNER, REPO, FALLBACK_RELEASE_LIMIT)
  } catch (error) {
    logger.warn(`GitHub API listing of Redpanda Connect releases failed: ${error.message}; probing the next ${FALLBACK_PROBE_LIMIT} lower release tags from git instead`)
  }
  if (releases) {
    const found = releases
      .filter((r) => r && !r.draft && !r.prerelease && isOlder(r.tag_name))
      .sort((a, b) => compareVersions(stableVersion(b.tag_name), stableVersion(a.tag_name)))
      .find((r) => (r.assets || []).some((a) => a && a.name === asset.ASSET_NAME))
    if (!found) {
      logger.info(`None of the ${releases.length} most recent Redpanda Connect releases has a ${asset.ASSET_NAME} release asset`)
      return null
    }
    const archive = await downloadRelease(found.tag_name, logger)
    return archive ? { tag: found.tag_name, archive } : null
  }
  let tags
  try {
    tags = stableTags(gitTags(url)).filter(isOlder).slice(0, FALLBACK_PROBE_LIMIT)
  } catch (error) {
    logger.warn(redact(`git ls-remote of ${url} failed: ${error.message}`))
    return null
  }
  for (const tag of tags) {
    const archive = await downloadRelease(tag, logger)
    if (archive) return { tag, archive }
  }
  if (tags.length) logger.info(`None of the next ${tags.length} lower Redpanda Connect release tags (${tags.join(', ')}) has a ${asset.ASSET_NAME} release asset`)
  return null
}

// Adds the generated files to every version of the connect component.
// Mutates the content catalog and returns what it added and skipped.
function addConnectDocs (contentCatalog, files, origin) {
  const report = { added: 0, providedElsewhere: 0, outsideGenerated: 0, versions: [] }
  const component = contentCatalog.getComponent(COMPONENT)
  if (!component) return report
  report.versions = component.versions.map((v) => v.version)
  for (const entry of files) {
    const resource = asset.toResource(entry.path)
    if (!resource) {
      report.outsideGenerated++
      continue
    }
    for (const version of report.versions) {
      const src = { component: COMPONENT, version, module: asset.MODULE, family: resource.family, relative: resource.relative }
      if (contentCatalog.getById(src)) {
        report.providedElsewhere++
        continue
      }
      contentCatalog.addFile({
        path: resource.path,
        contents: Buffer.from(entry.contents),
        src: { ...src, path: resource.path, origin },
      })
      report.added++
    }
  }
  return report
}

module.exports.register = function ({ config }) {
  raiseListenerLimit(this)
  const logger = this.getLogger('modify-connect-tag-playbook-extension')
  const configuredTag = toTag(config && config.tag ? String(config.tag).trim() : null)
  // Set in contextStarted: true when the playbook still lists the connect repo
  // as a content source.
  let gitSourceMode = false

  this.on('contextStarted', async ({ playbook }) => {
    const sources = (playbook && playbook.content && playbook.content.sources) || []
    // Clear a ref left over from an earlier build in the same process.
    setResolvedConnectRef(null)
    gitSourceMode = hasConnectSource(playbook)
    if (!gitSourceMode) return
    if ((process.env[LOCAL_DIR_ENV] || '').trim()) {
      logger.warn(`${LOCAL_DIR_ENV} is ignored because the playbook lists the connect repo as a content source`)
    }
    const source = sources.find(wantsLatest)
    if (!source) return
    const tag = await resolveLatestTag(source.url, logger)
    if (!tag) {
      // Guessing would let Antora's default branch patterns pull in connect's
      // branches, whose docs are unreleased or missing, so stop the build.
      throw new Error('Could not resolve the latest Redpanda Connect release tag for the connect content source. Set a GitHub token or check network access.')
    }
    pinConnectSource(playbook, tag)
    setResolvedConnectRef(tag)
    this.updateVariables({ playbook })
    logger.info(`Sourcing Redpanda Connect reference content from ${tag}`)
  })

  this.on('contentAggregated', ({ contentAggregate }) => {
    if (!gitSourceMode) return
    const r = filterConnectContent(contentAggregate)
    if (r.kept + r.outsideGenerated + r.providedElsewhere + r.otherComponents === 0) return
    logger.info(
      `Redpanda Connect content: kept ${r.kept} generated files; skipped ${r.providedElsewhere} already provided by another source, ` +
      `${r.outsideGenerated} outside the generated partials and examples, and ${r.otherComponents} from other components`
    )
  })

  // Antora runs listeners of an event one at a time, in registration order,
  // which follows the order of the playbook's extension list. Prepending puts
  // this listener first wherever the extension is listed, so the files exist
  // before generate-rp-connect-info's guard and any other contentClassified
  // listener reads the connect partials.
  const subscribe = typeof this.prependListener === 'function' ? this.prependListener : this.on
  subscribe.call(this, 'contentClassified', async ({ contentCatalog }) => {
    if (gitSourceMode) return
    if (!contentCatalog.getComponent(COMPONENT)) return
    const localDir = (process.env[LOCAL_DIR_ENV] || '').trim()
    let files
    let origin
    let from
    if (localDir) {
      setResolvedConnectRef(configuredTag)
      try {
        files = await asset.readLocal(localDir)
      } catch (error) {
        throw new Error(`Could not read the Redpanda Connect reference docs from ${LOCAL_DIR_ENV} (${localDir}): ${error.message}`)
      }
      origin = { type: 'local', url: CONNECT_URL, startPath: 'docs', localDir }
      from = `${LOCAL_DIR_ENV} (${localDir})`
    } else {
      let tag = configuredTag || (await resolveLatestTag(`${CONNECT_URL}.git`, logger))
      if (!tag) {
        throw new Error(
          'Could not resolve the latest Redpanda Connect release, so the connect reference docs cannot be downloaded. ' +
          `Set a GitHub token, check network access, or set the \`tag\` config of this extension or ${LOCAL_DIR_ENV}.`
        )
      }
      setResolvedConnectRef(tag)
      let archive = await downloadRelease(tag, logger)
      // The latest release can be published before its asset is attached, or
      // its asset job can fail. An explicit `tag` means that release only.
      if (!archive && !configuredTag) {
        const older = await findOlderReleaseWithAsset(tag, `${CONNECT_URL}.git`, logger)
        if (older) {
          logger.warn(`Redpanda Connect ${tag} has no ${asset.ASSET_NAME} asset yet; using ${older.tag}`)
          tag = older.tag
          archive = older.archive
          setResolvedConnectRef(tag)
        }
      }
      if (!archive) {
        logger.info(`Redpanda Connect ${tag} has no ${asset.ASSET_NAME} release asset (404), so no generated reference docs were added from it`)
        return
      }
      try {
        files = await asset.readTarGz(archive)
      } catch (error) {
        throw new Error(`The ${asset.ASSET_NAME} release asset of Redpanda Connect ${tag} is corrupt: ${error.message}`)
      }
      origin = { type: 'release-asset', url: CONNECT_URL, startPath: 'docs', reftype: 'tag', refname: tag, tag, asset: asset.assetUrl(tag) }
      from = `the ${tag} ${asset.ASSET_NAME} release asset`
    }
    if (!files.some((f) => asset.toResource(f.path))) {
      throw new Error(`${from} has no files under modules/components/partials or modules/components/examples`)
    }
    const r = addConnectDocs(contentCatalog, files, origin)
    const versions = r.versions.filter(Boolean)
    logger.info(
      `Redpanda Connect reference docs from ${from}: added ${r.added} files to the ${COMPONENT} component` +
      `${versions.length ? ` (${versions.join(', ')})` : ''}; ` +
      `skipped ${r.providedElsewhere} already provided by another source and ${r.outsideGenerated} outside the generated partials and examples`
    )
  })
}

module.exports._internal = { isRemote, isUpstreamConnect, redact, isConnectSource, isConnectOrigin, toTag, highestStableTag, stableTags, findOlderReleaseWithAsset, resolveLatestTag, FALLBACK_RELEASE_LIMIT, FALLBACK_PROBE_LIMIT, wantsLatest, pinConnectSource, filterConnectContent, hasConnectSource, addConnectDocs, LOCAL_DIR_ENV }
