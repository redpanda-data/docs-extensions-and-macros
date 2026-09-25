'use strict';

// Sources the Redpanda Connect reference partials from the connect repo.
//
// A playbook lists the connect repo as a content source:
//
//   - url: https://github.com/redpanda-data/connect
//     tags: latest        # replaced with the latest release tag at build time
//     start_path: docs
//
// The extension does two things:
//
// 1. Pins the source to the latest connect release tag, so the docs never
//    show fields from unreleased code on connect's main branch.
// 2. Filters what the source contributes: only the generated
//    modules/components/partials and modules/components/examples trees of the
//    `connect` component are kept, and any file another source (rp-connect-docs)
//    already provides is dropped. Antora fails the build on a duplicate page or
//    partial, so this makes it safe to add the source to a playbook before or
//    after rp-connect-docs stops committing its own generated copies, and it
//    ignores the full pages that older connect tags still carry.

const { raiseListenerLimit } = require('./util/raise-listener-limit')
const getLatestConnectTag = require('./version-fetcher/get-latest-connect')
const { getGitHubApiToken } = require('../cli-utils/github-token')

const OWNER = 'redpanda-data'
const REPO = 'connect'
const COMPONENT = 'connect'
const KEPT_PATHS = ['modules/components/partials/', 'modules/components/examples/']

// Matches the GitHub URL (with or without .git) and a local clone whose
// directory is named connect, which is how the source looks in local builds.
function isConnectSource (url) {
  return typeof url === 'string' && /(^|[/:])(redpanda-data\/)?connect(\.git)?\/?$/.test(url)
}

function isConnectOrigin (origin) {
  return !!origin && (isConnectSource(origin.url) || isConnectSource(origin.worktree))
}

function isRemote (url) {
  return /^https?:\/\//.test(url || '')
}

// Highest stable vX.Y.Z tag from `git ls-remote` output. Used when the GitHub
// API is unavailable, for example when an unauthenticated build is rate limited.
function highestStableTag (lsRemoteOutput) {
  const newer = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  let best = null
  for (const line of String(lsRemoteOutput || '').split('\n')) {
    const m = line.match(/refs\/tags\/(v(\d+)\.(\d+)\.(\d+))$/)
    if (!m) continue
    const v = m.slice(2, 5).map(Number)
    if (!best || newer(v, best.v) > 0) best = { tag: m[1], v }
  }
  return best && best.tag
}

function latestTagFromGit (url) {
  const { execFileSync } = require('child_process')
  return highestStableTag(execFileSync('git', ['ls-remote', '--tags', '--refs', url], { encoding: 'utf8', timeout: 60000 }))
}

function toTag (tagName) {
  if (!tagName) return null
  return tagName.startsWith('v') ? tagName : `v${tagName}`
}

// A remote connect source asks to be pinned with `tags: latest`. A source
// with any other refs, such as a fork or a PR branch used to preview a
// connect change, keeps what the playbook says.
function wantsLatest (source) {
  if (!isRemote(source.url) || !isConnectSource(source.url)) return false
  const tags = Array.isArray(source.tags) ? source.tags : [source.tags]
  return tags.includes('latest')
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

module.exports.register = function () {
  raiseListenerLimit(this)
  const logger = this.getLogger('modify-connect-tag-playbook-extension')

  this.on('contextStarted', async ({ playbook }) => {
    const sources = (playbook && playbook.content && playbook.content.sources) || []
    const source = sources.find(wantsLatest)
    if (!source) return
    let tag = null
    try {
      const { Octokit } = await import('@octokit/rest')
      const { retry } = await import('@octokit/plugin-retry')
      const token = getGitHubApiToken()
      const github = new (Octokit.plugin(retry))({ userAgent: 'Redpanda Docs', auth: token || undefined, retry: { doNotRetry: [403, 404, 429] } })
      tag = toTag(await getLatestConnectTag(github, OWNER, REPO, logger))
    } catch (error) {
      logger.warn(`GitHub API lookup of the latest Redpanda Connect release failed: ${error.message}`)
    }
    if (!tag) {
      try {
        tag = latestTagFromGit(source.url)
        if (tag) logger.info(`Resolved the latest Redpanda Connect release from git tags: ${tag}`)
      } catch (error) {
        logger.warn(`git ls-remote of ${source.url} failed: ${error.message}`)
      }
    }
    if (!tag) {
      // Guessing would let Antora's default branch patterns pull in connect's
      // branches, whose docs are unreleased or missing, so stop the build.
      throw new Error('Could not resolve the latest Redpanda Connect release tag for the connect content source. Set a GitHub token or check network access.')
    }
    pinConnectSource(playbook, tag)
    this.updateVariables({ playbook })
    logger.info(`Sourcing Redpanda Connect reference content from ${tag}`)
  })

  this.on('contentAggregated', ({ contentAggregate }) => {
    const r = filterConnectContent(contentAggregate)
    if (r.kept + r.outsideGenerated + r.providedElsewhere + r.otherComponents === 0) return
    logger.info(
      `Redpanda Connect content: kept ${r.kept} generated files; skipped ${r.providedElsewhere} already provided by another source, ` +
      `${r.outsideGenerated} outside the generated partials and examples, and ${r.otherComponents} from other components`
    )
  })
}

module.exports._internal = { isConnectSource, isConnectOrigin, toTag, highestStableTag, wantsLatest, pinConnectSource, filterConnectContent }
