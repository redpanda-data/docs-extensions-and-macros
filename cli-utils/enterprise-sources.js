'use strict'

/**
 * Source loading for `doc-tools validate enterprise-features`.
 *
 * Assembles the raw text of every source of truth the validator compares
 * against: the enterprise features registry, the core headers, the connect
 * plugin list, and the disable-enterprise-features page. Extracted from
 * bin/doc-tools.js so the fetch wiring (auth, retries, --skip-connect
 * short-circuits) is testable without a network.
 */

const fs = require('fs')
const path = require('path')
const { getGitHubToken } = require('./github-token')

const RAW = 'https://raw.githubusercontent.com'

// Repos known to be private, so a 404 can legitimately mean "needs auth".
// Public sources (redpanda core headers, connect info.csv) 404 only when the
// file is genuinely missing, and suggesting credentials there sends the
// reader after a problem that does not exist (e.g. during a transient
// GitHub blip).
const PRIVATE_REPO_PREFIXES = [
  `${RAW}/redpanda-data/docs/`,
  `${RAW}/redpanda-data/rp-connect-docs/`,
]

const TOKEN_HINT = ' This source is in a private repository: set GIT_CREDENTIALS (or GITHUB_TOKEN / REDPANDA_GITHUB_TOKEN / ACTIONS_BOT_TOKEN) so the fetch can authenticate.'
const REJECTED_HINT = ' A GitHub token was sent but rejected, so it may be expired or not grant access to this repository (the default Actions GITHUB_TOKEN is scoped to its own repository).'

const TRANSIENT_RETRIES = 3
const TRANSIENT_RETRY_DELAY_MS = 2000

function isPrivateSource (url) {
  return PRIVATE_REPO_PREFIXES.some((prefix) => url.startsWith(prefix))
}

// The response body of a failed fetch is never read; cancel it so the
// underlying connection is released instead of lingering until GC.
async function discardBody (resp) {
  await resp.body?.cancel().catch(() => {})
}

/**
 * Build a fetchText function that authenticates raw.githubusercontent.com
 * requests and records failures for named sources.
 *
 * Some sources live in private repos (the docs repo), which
 * raw.githubusercontent serves as 404 rather than 401 when unauthenticated —
 * indistinguishable from a genuinely missing file. A token is sent when one
 * is available so those fetches resolve; public sources are unaffected.
 *
 * raw.githubusercontent also returns 404 (not 401) for a REJECTED token,
 * even on public files, so a stale token in any of the token env vars would
 * break fetches that work tokenless. On a 404 with a token, the fetch is
 * retried once without authentication before the 404 is treated as real.
 *
 * Transient failures (network errors, 429, 5xx) are retried a few times
 * with a delay — the same treatment the CGO test gives curl — because a
 * single blip on any source would otherwise fail the whole run, and the
 * check runs on a weekly cron where nobody is watching live.
 *
 * @param {object} [deps]
 * @param {string|null} [deps.token] - GitHub token (defaults to getGitHubToken())
 * @param {Function} [deps.fetchImpl] - fetch implementation (defaults to global fetch)
 * @param {Function} [deps.warn] - warning sink (defaults to console.warn)
 * @param {Function} [deps.sleep] - delay implementation, for tests
 * @returns {{fetchText: Function, failedSources: Array}} fetchText and the
 *   findings array it appends to. Sources that fail to load are reported as
 *   error-level findings rather than silently skipped, so CI cannot pass on a
 *   check that never ran. Failures without a sourceName throw instead.
 */
function createSourceFetcher (deps = {}) {
  const ghToken = deps.token !== undefined ? deps.token : getGitHubToken()
  const fetchImpl = deps.fetchImpl || ((...args) => fetch(...args))
  const warn = deps.warn || ((msg) => console.warn(msg))
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const failedSources = []
  let warnedRejectedToken = false

  // One HTTP attempt with transient-failure retries. Returns the final
  // response; network errors that persist through every retry are rethrown.
  async function attemptFetch (url, opts) {
    let lastError
    for (let attempt = 1; attempt <= TRANSIENT_RETRIES; attempt++) {
      let resp
      try {
        resp = await fetchImpl(url, opts)
      } catch (err) {
        lastError = err
        if (attempt < TRANSIENT_RETRIES) await sleep(TRANSIENT_RETRY_DELAY_MS)
        continue
      }
      if (resp.status === 429 || resp.status >= 500) {
        await discardBody(resp)
        lastError = null
        if (attempt < TRANSIENT_RETRIES) {
          await sleep(TRANSIENT_RETRY_DELAY_MS)
          continue
        }
        return resp
      }
      return resp
    }
    throw lastError
  }

  async function fetchText (url, sourceName) {
    let resp
    try {
      resp = await attemptFetch(url, ghToken ? { headers: { Authorization: `Bearer ${ghToken}` } } : undefined)
    } catch (err) {
      if (sourceName) {
        failedSources.push({ level: 'error', check: 'fetch', message: `Could not load ${sourceName} (${url}): ${err.message}. The related checks did not run.` })
        return undefined
      }
      throw new Error(`Failed to fetch ${url}: ${err.message}`)
    }
    if (resp.ok) return resp.text()
    await discardBody(resp)

    let hint = ''
    if (resp.status === 404 && ghToken) {
      const retry = await attemptFetch(url)
      if (retry.ok) {
        if (!warnedRejectedToken) {
          warnedRejectedToken = true
          warn('Warning: the configured GitHub token was rejected by raw.githubusercontent.com (it may be expired); fetching without authentication instead.')
        }
        return retry.text()
      }
      await discardBody(retry)
      if (isPrivateSource(url)) hint = REJECTED_HINT
    } else if (resp.status === 404 && isPrivateSource(url)) {
      // A tokenless 404 on a known-private repo is the signature of an
      // unauthenticated fetch, so say so instead of leaving it to look
      // like a missing file. Public sources get no credential hint: their
      // 404s mean the file is missing (or GitHub is having a bad moment).
      hint = TOKEN_HINT
    }

    if (sourceName) {
      failedSources.push({ level: 'error', check: 'fetch', message: `Could not load ${sourceName} (${url}): ${resp.status} ${resp.statusText}. The related checks did not run.${hint}` })
      return undefined
    }
    throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}.${hint}`)
  }

  return { fetchText, failedSources }
}

/**
 * Load every source the enterprise-features validation consumes.
 *
 * The rp-connect-docs antora.yml is deliberately NOT a source anymore:
 * rp-connect-docs#485 removed the enterprise-components list it carried, so
 * fetching it bought a cross-repo credential requirement in exchange for a
 * comparison against nothing. The connect check now validates the registry's
 * connect-plugin entries directly against info.csv.
 *
 * The connect ref defaults to 'latest', which resolves to the latest
 * published connect release tag. The registry documents released state, so
 * comparing it against main would flag plugins renamed or newly marked
 * enterprise ahead of any release. The core headers deliberately stay on
 * 'dev' for the opposite reason: their check exists to give early warning
 * of NEW license-gated features before they ship.
 *
 * @param {object} options - Parsed CLI options: registry, tag, connectRef,
 *   docsRef, disablePage, skipConnect.
 * @param {object} [deps] - Injectable dependencies for tests: token,
 *   fetchImpl, warn, sleep (see createSourceFetcher), and readLocal.
 * @returns {Promise<object>} { registryYaml, coreHeader, configurationHeader,
 *   infoCsv, connectRef, disablePage, failedSources }
 */
async function loadEnterpriseSources (options, deps = {}) {
  const { fetchText, failedSources } = createSourceFetcher(deps)
  const readLocal = deps.readLocal || ((p) => fs.readFileSync(path.resolve(p), 'utf8'))

  const registryYaml = options.registry
    ? readLocal(options.registry)
    : await fetchText(`${RAW}/redpanda-data/docs/${options.docsRef}/shared/modules/ROOT/partials/enterprise-features.yml`)
  const coreHeader = await fetchText(`${RAW}/redpanda-data/redpanda/${options.tag}/src/v/features/enterprise_features.h`, 'core enterprise_features.h')
  const configurationHeader = await fetchText(`${RAW}/redpanda-data/redpanda/${options.tag}/src/v/config/configuration.h`, 'core configuration.h')

  let connectRef = options.connectRef
  let infoCsv
  if (!options.skipConnect) {
    if (!connectRef || connectRef === 'latest') {
      const releaseJson = await fetchText('https://api.github.com/repos/redpanda-data/connect/releases/latest', 'connect latest release')
      if (releaseJson === undefined) {
        connectRef = undefined // resolution failed; already reported as an error finding
      } else {
        connectRef = JSON.parse(releaseJson).tag_name
        if (!connectRef) {
          failedSources.push({ level: 'error', check: 'fetch', message: 'Could not resolve the latest connect release: the GitHub API response has no tag_name. The connect check did not run.' })
        }
      }
    }
    if (connectRef) {
      infoCsv = await fetchText(`${RAW}/redpanda-data/connect/${connectRef}/internal/plugins/info.csv`, `connect info.csv (${connectRef})`)
    }
  }

  const disablePage = options.disablePage
    ? readLocal(options.disablePage)
    : await fetchText(`${RAW}/redpanda-data/docs/${options.docsRef}/modules/get-started/pages/licensing/disable-enterprise-features.adoc`, 'disable-enterprise-features.adoc')

  return { registryYaml, coreHeader, configurationHeader, infoCsv, connectRef, disablePage, failedSources }
}

module.exports = { createSourceFetcher, loadEnterpriseSources, RAW }
