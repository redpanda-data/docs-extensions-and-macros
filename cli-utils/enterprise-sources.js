'use strict'

/**
 * Source loading for `doc-tools validate enterprise-features`.
 *
 * Assembles the raw text of every source of truth the validator compares
 * against: the enterprise features registry, the core headers, the connect
 * plugin list, the disable-enterprise-features page, and the rp-connect-docs
 * antora.yml. Extracted from bin/doc-tools.js so the fetch wiring (auth,
 * retries, --skip-connect short-circuits) is testable without a network.
 */

const fs = require('fs')
const path = require('path')
const { getGitHubToken } = require('./github-token')

const RAW = 'https://raw.githubusercontent.com'

const TOKEN_HINT = ' If this source is in a private repository, set GIT_CREDENTIALS (or GITHUB_TOKEN / REDPANDA_GITHUB_TOKEN / ACTIONS_BOT_TOKEN) so the fetch can authenticate.'
const REJECTED_HINT = ' A GitHub token was sent but rejected, so it may be expired or not grant access to this repository if the repository is private (the default Actions GITHUB_TOKEN is scoped to its own repository).'

// The response body of a failed fetch is never read; cancel it so the
// underlying connection is released instead of lingering until GC.
async function discardBody (resp) {
  await resp.body?.cancel().catch(() => {})
}

/**
 * Build a fetchText function that authenticates raw.githubusercontent.com
 * requests and records failures for named sources.
 *
 * Some sources live in private repos (docs, rp-connect-docs), which
 * raw.githubusercontent serves as 404 rather than 401 when unauthenticated —
 * indistinguishable from a genuinely missing file. A token is sent when one
 * is available so those fetches resolve; public sources are unaffected.
 *
 * raw.githubusercontent also returns 404 (not 401) for a REJECTED token,
 * even on public files, so a stale token in any of the token env vars would
 * break fetches that work tokenless. On a 404 with a token, the fetch is
 * retried once without authentication before the 404 is treated as real.
 *
 * @param {object} [deps]
 * @param {string|null} [deps.token] - GitHub token (defaults to getGitHubToken())
 * @param {Function} [deps.fetchImpl] - fetch implementation (defaults to global fetch)
 * @param {Function} [deps.warn] - warning sink (defaults to console.warn)
 * @returns {{fetchText: Function, failedSources: Array}} fetchText and the
 *   findings array it appends to. Sources that fail to load are reported as
 *   error-level findings rather than silently skipped, so CI cannot pass on a
 *   check that never ran. Failures without a sourceName throw instead.
 */
function createSourceFetcher (deps = {}) {
  const ghToken = deps.token !== undefined ? deps.token : getGitHubToken()
  const fetchImpl = deps.fetchImpl || ((...args) => fetch(...args))
  const warn = deps.warn || ((msg) => console.warn(msg))
  const failedSources = []
  let warnedRejectedToken = false

  async function fetchText (url, sourceName) {
    const resp = await fetchImpl(url, ghToken ? { headers: { Authorization: `Bearer ${ghToken}` } } : undefined)
    if (resp.ok) return resp.text()
    await discardBody(resp)

    let hint = ''
    if (resp.status === 404 && ghToken) {
      const retry = await fetchImpl(url)
      if (retry.ok) {
        if (!warnedRejectedToken) {
          warnedRejectedToken = true
          warn('Warning: the configured GitHub token was rejected by raw.githubusercontent.com (it may be expired); fetching without authentication instead.')
        }
        return retry.text()
      }
      await discardBody(retry)
      hint = REJECTED_HINT
    } else if (resp.status === 404) {
      // A 404 with no token is the signature of an unauthenticated private
      // repo, so say so instead of leaving it to look like a missing file.
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
 * @param {object} options - Parsed CLI options: registry, tag, connectRef,
 *   docsRef, disablePage, antora, skipConnect.
 * @param {object} [deps] - Injectable dependencies for tests: token,
 *   fetchImpl, warn (see createSourceFetcher), and readLocal.
 * @returns {Promise<object>} { registryYaml, coreHeader, configurationHeader,
 *   infoCsv, disablePage, antoraYaml, failedSources }
 */
async function loadEnterpriseSources (options, deps = {}) {
  const { fetchText, failedSources } = createSourceFetcher(deps)
  const readLocal = deps.readLocal || ((p) => fs.readFileSync(path.resolve(p), 'utf8'))

  const registryYaml = options.registry
    ? readLocal(options.registry)
    : await fetchText(`${RAW}/redpanda-data/docs/${options.docsRef}/shared/modules/ROOT/partials/enterprise-features.yml`)
  const coreHeader = await fetchText(`${RAW}/redpanda-data/redpanda/${options.tag}/src/v/features/enterprise_features.h`, 'core enterprise_features.h')
  const configurationHeader = await fetchText(`${RAW}/redpanda-data/redpanda/${options.tag}/src/v/config/configuration.h`, 'core configuration.h')
  const infoCsv = options.skipConnect
    ? undefined
    : await fetchText(`${RAW}/redpanda-data/connect/${options.connectRef}/internal/plugins/info.csv`, 'connect info.csv')
  const disablePage = options.disablePage
    ? readLocal(options.disablePage)
    : await fetchText(`${RAW}/redpanda-data/docs/${options.docsRef}/modules/get-started/pages/licensing/disable-enterprise-features.adoc`, 'disable-enterprise-features.adoc')
  // Only checkConnect consumes this, so --skip-connect has to skip it too.
  // Fetching it anyway meant --skip-connect still reached a private repo
  // and failed the run on a source none of the enabled checks used.
  const antoraYaml = options.skipConnect
    ? undefined
    : options.antora
      ? readLocal(options.antora)
      : await fetchText(`${RAW}/redpanda-data/rp-connect-docs/main/antora.yml`, 'rp-connect-docs antora.yml')

  return { registryYaml, coreHeader, configurationHeader, infoCsv, disablePage, antoraYaml, failedSources }
}

module.exports = { createSourceFetcher, loadEnterpriseSources, RAW }
