'use strict'

const fs = require('fs')
const path = require('path')

const { scanContentUrls } = require('./util/scan-content-urls')
const { raiseListenerLimit } = require('./util/raise-listener-limit')

/**
 * External Link Checker Extension
 *
 * Collects every external http(s) URL referenced in page and partial content
 * and verifies it responds, reporting dead links in the build log. Internal
 * links are covered by the url-to-xref extension plus Antora's own xref
 * validation; this extension covers everything that points off-site.
 *
 * Because it performs network requests, register it only where that belongs
 * (for example a nightly build), not necessarily on every preview build:
 *
 * antora:
 *   extensions:
 *     - require: '@redpanda-data/docs-extensions-and-macros/extensions/external-link-checker'
 *       # internal_hostnames: ['docs.redpanda.com']  hosts to skip (default)
 *       # include: []          regex allowlist; when set, only matching URLs are checked
 *       # exclude: []          regex denylist
 *       # versions: 'latest'   'latest' checks only each component's latest
 *       #                      version (plus unversioned components); 'all'
 *       #                      checks every version in the build
 *       # concurrency: 10      simultaneous requests
 *       # timeout: 10000       per-request timeout in ms
 *       # fail_on_broken: false  log broken links at error level so a build
 *       #                        run with --log-failure-level=error fails
 *       # report_file: ''      path to write a machine-readable JSON report to
 *
 * Checking only happens when LINK_CHECK=true is set in the environment, so one
 * playbook can serve both a scheduled link-check build and ordinary preview
 * builds, which must not make network requests. It is an environment variable
 * rather than a config option because Antora does not interpolate environment
 * variables into playbook values, and because Antora consumes the playbook's
 * own `enabled` key itself (generator-context.js strips it before the config
 * reaches an extension), so that name is not available here.
 *
 * Classification:
 * - 2xx/3xx: ok
 * - 404/410: broken (warn, or error with fail_on_broken)
 * - 401/403/429: unverifiable (info) - bot-walled or rate-limited, not broken
 * - other statuses, network errors, timeouts (after one retry): unverifiable (warn)
 *
 * Why 'latest' is the default for versions: a site that publishes many
 * versions of the same component republishes the same dead link once per
 * branch, and the older branches are frozen content that nobody is going to
 * edit. Checking them turns the report into a list of findings that cannot be
 * acted on. Set versions: 'all' to see them anyway.
 */

const USER_AGENT = 'redpanda-docs-link-checker'

module.exports.register = function ({ config = {} }) {
  raiseListenerLimit(this)
  const logger = this.getLogger('external-link-checker-extension')
  // Inert unless asked for, so this can be registered in a playbook that
  // preview builds also use. See the note above on why this is an environment
  // variable and not a config option.
  if (process.env.LINK_CHECK !== 'true') return
  const internalHostnames = new Set(config.internalHostnames || ['docs.redpanda.com'])
  const include = (config.include || []).map((pattern) => new RegExp(pattern))
  const exclude = (config.exclude || []).map((pattern) => new RegExp(pattern))
  const versions = config.versions || 'latest'
  const concurrency = config.concurrency || 10
  const timeout = config.timeout || 10000
  const failOnBroken = Boolean(config.failOnBroken)
  const reportFile = config.reportFile || null

  this.on('contentClassified', async ({ contentCatalog }) => {
    const { urlReferences, unresolved } = collectExternalUrls(contentCatalog, {
      internalHostnames,
      include,
      exclude,
      versions,
    })
    // An unresolved attribute reference is not a broken link. This hook runs
    // before Asciidoctor substitutes attributes, so {latest-operator-version}
    // is still literal here while the published URL is fine. Report the count
    // so a genuinely undefined attribute is still visible, but never fetch.
    if (unresolved.size) {
      logger.info(
        `Skipped ${unresolved.size} URL(s) holding an unresolved attribute reference ` +
          '(attributes are substituted after this hook runs)'
      )
      for (const [url, refs] of unresolved) {
        logger.info(`Unchecked external link ${url} (unresolved attribute) referenced in: ${formatRefs(refs)}`)
      }
    }
    if (!urlReferences.size) return
    const counts = { ok: 0, broken: 0, unverifiable: 0 }
    const results = []
    await runWithConcurrency([...urlReferences.keys()], concurrency, async (url) => {
      const verdict = await checkUrl(url, { timeout })
      counts[verdict.classification]++
      const refs = urlReferences.get(url)
      results.push({
        url,
        classification: verdict.classification,
        status: verdict.status ?? null,
        reason: verdict.reason ?? null,
        refs: [...refs.values()],
      })
      const pages = formatRefs(refs)
      if (verdict.classification === 'broken') {
        const message = `Broken external link ${url} (HTTP ${verdict.status}) referenced in: ${pages}`
        failOnBroken ? logger.error(message) : logger.warn(message)
      } else if (verdict.classification === 'unverifiable') {
        const reason = verdict.status ? `HTTP ${verdict.status}` : verdict.reason
        const log = verdict.status && [401, 403, 429].includes(verdict.status) ? 'info' : 'warn'
        logger[log](`Could not verify external link ${url} (${reason}) referenced in: ${pages}`)
      }
    })
    logger.info(
      `Checked ${urlReferences.size} external links: ${counts.ok} ok, ${counts.broken} broken, ` +
        `${counts.unverifiable} unverifiable`
    )
    if (reportFile) writeReport(reportFile, { results, unresolved, counts, logger })
  })
}

/**
 * Where a URL was found, in enough detail to act on it: which repository,
 * which branch, and the path within that repository. A report line carrying
 * only the Antora-relative path ('modules/reference/pages/x.adoc') is
 * ambiguous across the several repositories and many version branches an
 * aggregated site builds from, which makes it unusable for anything that has
 * to open a pull request against the right one.
 */
function fileReference (file) {
  const src = file.src || {}
  const origin = src.origin || {}
  const repo = repoSlug(origin.url)
  const startPath = origin.startPath || ''
  const repoPath = startPath ? `${startPath}/${file.path}` : file.path
  const refname = origin.refname || origin.branch || origin.tag || ''
  const ref = {
    repo,
    refname,
    component: src.component || '',
    version: src.version || '',
    path: repoPath,
  }
  // Without origin metadata (a synthetic catalog, or a local content source
  // with no git remote) the path is all there is to report.
  const label = repo ? `${repo}${refname ? `@${refname}` : ''}:${repoPath}` : repoPath
  return { label, ref }
}

/** 'https://github.com/redpanda-data/docs.git' -> 'redpanda-data/docs' */
function repoSlug (url) {
  if (!url || typeof url !== 'string') return ''
  const match = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/)
  return match ? `${match[1]}/${match[2]}` : ''
}

function formatRefs (refs) {
  return [...refs.keys()].join(', ')
}

/**
 * Maps each component to its latest version, so non-latest content can be
 * skipped. Catalogs without getComponents (unit-test doubles) fall back to
 * checking everything.
 */
function latestVersions (contentCatalog) {
  if (typeof contentCatalog.getComponents !== 'function') return null
  const latest = new Map()
  for (const component of contentCatalog.getComponents()) {
    latest.set(component.name, component.latest ? component.latest.version : '')
  }
  return latest
}

function collectExternalUrls (contentCatalog, { internalHostnames, include, exclude, versions = 'all' }) {
  const urlReferences = new Map()
  const unresolved = new Map()
  const latest = versions === 'latest' ? latestVersions(contentCatalog) : null
  const files = contentCatalog
    .getPages((page) => page.out)
    .concat(contentCatalog.findBy({ family: 'partial' }))
  for (const file of files) {
    if (!file.contents) continue
    const src = file.src || {}
    // An unversioned component has an empty version and is always current.
    if (latest && src.version && latest.has(src.component) && latest.get(src.component) !== src.version) continue
    const { label, ref } = fileReference(file)
    for (const match of scanContentUrls(file.contents.toString())) {
      const target = match.hasAttributeReference ? unresolved : urlReferences
      if (!match.hasAttributeReference) {
        let url
        try {
          url = new URL(match.url)
        } catch {
          continue
        }
        if (internalHostnames.has(url.hostname)) continue
        if (include.length && !include.some((pattern) => pattern.test(match.url))) continue
        if (exclude.some((pattern) => pattern.test(match.url))) continue
      }
      if (!target.has(match.url)) target.set(match.url, new Map())
      target.get(match.url).set(label, ref)
    }
  }
  return { urlReferences, unresolved }
}

function writeReport (reportFile, { results, unresolved, counts, logger }) {
  const report = {
    generatedAt: new Date().toISOString(),
    counts,
    // Broken first, then unverifiable, so a consumer reading the head of the
    // list gets the actionable findings.
    results: results.sort((a, b) => rank(a.classification) - rank(b.classification) || a.url.localeCompare(b.url)),
    unresolvedAttributeReferences: [...unresolved].map(([url, refs]) => ({ url, refs: [...refs.values()] })),
  }
  try {
    const dir = path.dirname(reportFile)
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`)
    logger.info(`Wrote link check report to ${reportFile}`)
  } catch (error) {
    // The report is an aid for downstream automation; failing the build over
    // it would hide the link findings the build just produced.
    logger.warn(`Could not write link check report to ${reportFile}: ${error.message}`)
  }
}

function rank (classification) {
  return classification === 'broken' ? 0 : classification === 'unverifiable' ? 1 : 2
}

async function checkUrl (url, { timeout, fetchFn = module.exports._fetch }) {
  let lastError
  for (const attempt of [{ method: 'HEAD' }, { method: 'GET' }, { method: 'GET', retry: true }]) {
    try {
      const response = await fetchFn(url, {
        method: attempt.method,
        redirect: 'follow',
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(timeout),
      })
      const status = response.status
      // HEAD rejected or unsupported: many CDNs and bot walls refuse HEAD
      // (403, 404, ...) but answer GET normally, so confirm any HEAD failure
      // with GET before classifying
      if (attempt.method === 'HEAD' && status >= 400) continue
      if (status < 400) return { classification: 'ok', status }
      if (status === 404 || status === 410) return { classification: 'broken', status }
      return { classification: 'unverifiable', status }
    } catch (error) {
      lastError = error
      if (attempt.retry) break
    }
  }
  return { classification: 'unverifiable', status: null, reason: lastError ? lastError.message : 'request failed' }
}

async function runWithConcurrency (items, limit, task) {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await task(queue.shift())
  })
  await Promise.all(workers)
}

// Indirection so tests can stub the HTTP layer without a network.
module.exports._fetch = (...args) => fetch(...args)
module.exports.checkUrl = checkUrl
module.exports.collectExternalUrls = collectExternalUrls
module.exports.repoSlug = repoSlug
