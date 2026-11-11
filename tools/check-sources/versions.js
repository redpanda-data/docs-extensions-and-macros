'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { latestStablePerLine, releaseLineOf, isOlderReleaseLine } = require('../../extensions/version-fetcher/release-lines')

/**
 * Version-aware refs for check-sources.
 *
 * A source comment without `@<ref>` is checked against the release the page
 * documents, resolved the way the docs build resolves it
 * (extensions/version-fetcher/set-latest-version.js):
 *
 *   streaming-enterprise  latest-redpanda-tag: the newest GA release for the
 *                         component's latest version, the antora.yml value for
 *                         an older version (the build leaves older versions on
 *                         their antora.yml), and redpanda-beta-tag (the newest
 *                         RC) when the component version is a prerelease
 *   console               latest-console-tag: the newest stable release, for
 *                         every version
 *   redpanda-operator     latest-operator-version: the newest stable release,
 *                         or for an older version the newest release of its own
 *                         line, else its antora.yml value. The git tag is
 *                         `operator/<tag>` (older releases: `<tag>`)
 *   connect               latest-connect-tag: the newest release, for every
 *                         version
 *
 * Any other repo (cloudv2 and the rest) has no release that docs track, so
 * it is checked on its default branch and reported as unversioned. The
 * antora.yml values are fallbacks, used only when the live lookup fails; that
 * is reported, because a seeded value can be far behind (rp-connect-docs
 * seeds full-version 24.1.4).
 *
 * A component version is "older" when the docs branch is a `v/*` branch
 * (--branch, then GITHUB_BASE_REF, GITHUB_REF_NAME, then the checked-out
 * branch). With no branch to go on, it is older when its release line is
 * below the newest GA line.
 */

const VERSIONED = Object.freeze({
  'streaming-enterprise': 'latest-redpanda-tag',
  console: 'latest-console-tag',
  'redpanda-operator': 'latest-operator-version',
  connect: 'latest-connect-tag'
})

/** The nearest antora.yml at or above the page, but not above root. */
function findAntoraYml (root, pageAbs) {
  let dir = path.dirname(path.resolve(pageAbs))
  const top = path.resolve(root)
  for (;;) {
    const candidate = path.join(dir, 'antora.yml')
    if (fs.existsSync(candidate)) return candidate
    if (dir === top || !dir.startsWith(top)) return null
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const componentCache = new Map()
/** { file, name, version, prerelease, attributes } of the page's component, or null. */
function readComponent (root, pageAbs) {
  const file = findAntoraYml(root, pageAbs)
  if (!file) return null
  if (!componentCache.has(file)) {
    let doc = {}
    try {
      doc = require('js-yaml').load(fs.readFileSync(file, 'utf8')) || {}
    } catch {
      doc = {}
    }
    const version = doc.version === null || doc.version === undefined || doc.version === false ? null : String(doc.version)
    componentCache.set(file, {
      file,
      name: doc.name || null,
      version,
      prerelease: Boolean(doc.prerelease),
      attributes: (doc.asciidoc && doc.asciidoc.attributes) || {}
    })
  }
  return componentCache.get(file)
}

function currentBranch (root, explicit, env = process.env) {
  if (explicit) return explicit
  if (env.GITHUB_BASE_REF) return env.GITHUB_BASE_REF
  if (env.GITHUB_REF_NAME && !/\/merge$/.test(env.GITHUB_REF_NAME)) return env.GITHUB_REF_NAME
  try {
    const r = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
  } catch {
    // not a git checkout
  }
  return null
}

const attr = (component, key) => {
  const v = component && component.attributes[key]
  return v === undefined || v === null || v === false || v === '' ? null : String(v)
}
const withV = (v) => (v && !/^v/.test(v) ? `v${v}` : v)

/**
 * Live latest releases, fetched once, with the same helpers the build uses.
 * Each field is null when its lookup failed.
 */
async function fetchLatestReleases ({ token } = {}) {
  const { Octokit } = await import('@octokit/rest')
  const github = new Octokit({ userAgent: 'redpanda-docs-tools', auth: token || undefined, log: { debug () {}, info () {}, warn () {}, error () {} } })
  const quiet = { debug () {}, info () {}, warn () {}, error () {} }
  const getRedpanda = require('../../extensions/version-fetcher/get-latest-redpanda-version')
  const getDockerTag = require('../../extensions/version-fetcher/fetch-latest-docker-tag')
  const getConnect = require('../../extensions/version-fetcher/get-latest-connect')
  const [redpanda, consoleTags, operatorTags, connect] = await Promise.all([
    getRedpanda(github, 'redpanda-data', 'streaming-enterprise', quiet).catch(() => null),
    getDockerTag('redpandadata', 'console', quiet).catch(() => null),
    getDockerTag('redpandadata', 'redpanda-operator', quiet, { maxPages: 3 }).catch(() => null),
    getConnect(github, 'redpanda-data', 'connect', quiet).catch(() => null)
  ])
  return {
    redpandaGa: (redpanda && redpanda.latestRedpandaRelease && redpanda.latestRedpandaRelease.version) || null,
    redpandaRc: (redpanda && redpanda.latestRcRelease && redpanda.latestRcRelease.version) || null,
    console: (consoleTags && consoleTags.latestStableRelease) || null,
    operator: (operatorTags && operatorTags.latestStableRelease) || null,
    operatorReleases: (operatorTags && operatorTags.stableReleases) || [],
    connect: connect || null
  }
}

/**
 * Build a resolver. `latest` is a function returning (a promise of) the
 * fetchLatestReleases() shape; it is called at most once. Returns
 * resolve(repo, component) -> Promise<{ refs, by, unversioned?, fallback? } | { error }>
 * where refs are the git refs to try in order (null = default branch).
 */
function createVersionResolver ({ latest = fetchLatestReleases, root = process.cwd(), branch = null, env = process.env } = {}) {
  let pending = null
  const live = () => {
    if (!pending) pending = Promise.resolve().then(latest).catch(() => ({}))
    return pending
  }
  const branchName = currentBranch(root, branch, env)

  return async function resolve (repo, component) {
    const key = VERSIONED[repo]
    if (!component) return { refs: [null], by: 'default branch (no antora.yml above this page)' }
    if (!key) return { refs: [null], by: 'default branch', unversioned: true }
    const l = await live()
    const fromYml = (k, why) => {
      const v = attr(component, k)
      return v ? { value: v, by: `${k} from ${path.basename(component.file)}${why ? ' (' + why + ')' : ''}`, fallback: Boolean(why) } : null
    }
    const line = releaseLineOf(component.version)
    const older = !component.prerelease && (branchName
      ? /^v\//.test(branchName)
      : Boolean(l.redpandaGa && line && isOlderReleaseLine(component.version, releaseLineOf(String(l.redpandaGa).replace(/^v/, '').split('.').slice(0, 2).join('.')))))

    let pick = null
    if (repo === 'streaming-enterprise') {
      if (component.prerelease) {
        pick = l.redpandaRc ? { value: l.redpandaRc, by: 'redpanda-beta-tag (newest RC, prerelease component version)' } : fromYml('redpanda-beta-tag', 'live lookup failed')
      } else if (older) {
        pick = fromYml('latest-redpanda-tag')
      } else {
        pick = l.redpandaGa ? { value: l.redpandaGa, by: 'latest-redpanda-tag (newest GA)' } : fromYml('latest-redpanda-tag', 'live lookup failed')
      }
    } else if (repo === 'console') {
      pick = l.console ? { value: l.console, by: 'latest-console-tag (newest stable)' } : fromYml('latest-console-tag', 'live lookup failed') || mapVersion(fromYml('latest-console-version', 'live lookup failed'))
    } else if (repo === 'redpanda-operator') {
      if (older) {
        const own = line && latestStablePerLine(l.operatorReleases).get(line)
        pick = own ? { value: own, by: `latest-operator-version (newest ${line} release)` } : fromYml('latest-operator-version', `no ${line} release found`)
      }
      if (!pick) pick = l.operator ? { value: l.operator, by: 'latest-operator-version (newest stable)' } : fromYml('latest-operator-version', 'live lookup failed')
    } else if (repo === 'connect') {
      pick = l.connect ? { value: l.connect, by: 'latest-connect-tag (newest release)' } : fromYml('latest-connect-tag', 'live lookup failed') || mapVersion(fromYml('latest-connect-version', 'live lookup failed'))
    }
    if (!pick) return { error: `could not resolve ${key} for ${component.name || 'this component'} ${component.version || ''}`.trim() + ': the live lookup failed and its antora.yml sets no fallback' }
    const tag = withV(pick.value)
    const refs = repo === 'redpanda-operator' ? [`operator/${tag}`, tag] : [tag]
    return { refs, by: pick.by, fallback: Boolean(pick.fallback) }
  }

  function mapVersion (p) {
    return p ? { ...p, value: withV(p.value) } : null
  }
}

module.exports = { VERSIONED, readComponent, findAntoraYml, currentBranch, fetchLatestReleases, createVersionResolver, _componentCache: componentCache }
