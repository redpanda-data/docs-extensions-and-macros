'use strict'

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
 *       # concurrency: 10      simultaneous requests
 *       # timeout: 10000       per-request timeout in ms
 *       # fail_on_broken: false  log broken links at error level so a build
 *       #                        run with --log-failure-level=error fails
 *
 * Classification:
 * - 2xx/3xx: ok
 * - 404/410: broken (warn, or error with fail_on_broken)
 * - 401/403/429: unverifiable (info) — bot-walled or rate-limited, not broken
 * - other statuses, network errors, timeouts (after one retry): unverifiable (warn)
 */

const USER_AGENT = 'redpanda-docs-link-checker'

module.exports.register = function ({ config = {} }) {
  raiseListenerLimit(this)
  const logger = this.getLogger('external-link-checker-extension')
  const internalHostnames = new Set(config.internalHostnames || ['docs.redpanda.com'])
  const include = (config.include || []).map((pattern) => new RegExp(pattern))
  const exclude = (config.exclude || []).map((pattern) => new RegExp(pattern))
  const concurrency = config.concurrency || 10
  const timeout = config.timeout || 10000
  const failOnBroken = Boolean(config.failOnBroken)

  this.on('contentClassified', async ({ contentCatalog }) => {
    const urlReferences = collectExternalUrls(contentCatalog, { internalHostnames, include, exclude })
    if (!urlReferences.size) return
    const counts = { ok: 0, broken: 0, unverifiable: 0 }
    await runWithConcurrency([...urlReferences.keys()], concurrency, async (url) => {
      const verdict = await checkUrl(url, { timeout })
      counts[verdict.classification]++
      const pages = [...urlReferences.get(url)].join(', ')
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
  })
}

function collectExternalUrls (contentCatalog, { internalHostnames, include, exclude }) {
  const urlReferences = new Map()
  const files = contentCatalog
    .getPages((page) => page.out)
    .concat(contentCatalog.findBy({ family: 'partial' }))
  for (const file of files) {
    if (!file.contents) continue
    for (const match of scanContentUrls(file.contents.toString())) {
      let url
      try {
        url = new URL(match.url)
      } catch {
        continue
      }
      if (internalHostnames.has(url.hostname)) continue
      if (include.length && !include.some((pattern) => pattern.test(match.url))) continue
      if (exclude.some((pattern) => pattern.test(match.url))) continue
      if (!urlReferences.has(match.url)) urlReferences.set(match.url, new Set())
      urlReferences.get(match.url).add(file.path)
    }
  }
  return urlReferences
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
