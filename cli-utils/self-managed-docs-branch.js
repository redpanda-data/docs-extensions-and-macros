const yaml = require('js-yaml');
const { spawnSync } = require('child_process');
const { getGitHubApiToken } = require('./github-token');

const ANTORA_URL = 'https://raw.githubusercontent.com/redpanda-data/docs/main/antora.yml'

const TOKEN_HINT = ' The docs repository is private, so set GIT_CREDENTIALS (or GITHUB_TOKEN / REDPANDA_GITHUB_TOKEN / ACTIONS_BOT_TOKEN) so the fetch can authenticate.'
const REJECTED_HINT = ' A GitHub token was sent but rejected, so it may be expired or not grant access to the docs repository (the default Actions GITHUB_TOKEN is scoped to its own repository).'

/**
 * Retrieves the current Self-Managed documentation version from the remote antora.yml file.
 *
 * The docs repository is private, and raw.githubusercontent serves private
 * content as 404 rather than 401 when unauthenticated, so the fetch sends a
 * Bearer token when one is available. It also returns 404 (not 401) for a
 * REJECTED token, so a 404 with a token is retried once without
 * authentication before being treated as real.
 *
 * @param {object} [deps] - Injectable for tests: { fetchImpl, token }.
 * @returns {Promise<string>} Resolves with the version string (for example, "25.1").
 *
 * @throws {Error} If the antora.yml file cannot be fetched, parsed, or if the version field is missing.
 */
async function fetchRemoteAntoraVersion(deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch
  const ghToken = 'token' in deps ? deps.token : getGitHubApiToken()

  let resp = await fetchImpl(ANTORA_URL, ghToken ? { headers: { Authorization: `Bearer ${ghToken}` } } : undefined)
  const hint = ghToken ? REJECTED_HINT : TOKEN_HINT
  if (resp.status === 404 && ghToken) {
    await resp.body?.cancel().catch(() => {})
    resp = await fetchImpl(ANTORA_URL)
  }
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {})
    throw new Error(`Failed to fetch antora.yml: ${resp.status}${resp.status === 404 ? hint : ''}`)
  }
  const cfg = yaml.load(await resp.text())
  if (cfg.version == null) {
    throw new Error('version field missing')
  }
  return String(cfg.version).trim()
}

/**
 * Reports whether a branch exists in the docs repository.
 *
 * @param {string} branch - Branch name, such as "main" or "v/25.1".
 * @returns {boolean} True when `git ls-remote` finds the branch.
 */
function docsBranchExists(branch) {
  const repo = 'https://github.com/redpanda-data/docs.git'
  return spawnSync('git', ['ls-remote', '--exit-code', '--heads', repo, `refs/heads/${branch}`], {
    stdio: 'ignore'
  }).status === 0
}

/**
 * Determines the appropriate documentation branch for a given operator tag or branch based on the remote Antora version.
 *
 * Normalizes the input, extracts the major.minor version, and applies version-specific logic to select the correct branch. Verifies that the chosen branch exists in the remote repository.
 * A ref with no version, such as `main`, `dev`, or a feature branch, holds content for the next release, which the docs repository keeps on `main`.
 *
 * @param {string} operatorRef - The operator tag or branch to evaluate (for example, "operator/v25.1.2", "v25.1.2", "release/v25.1.x", or "main").
 * @param {object} [deps] - Injectable for tests: { antoraVersion, branchExists, fetchImpl, token }.
 * @returns {Promise<string>} The name of the documentation branch to use.
 *
 * @throws {Error} If the Antora version cannot be fetched or if the determined branch does not exist in the remote repository.
 */
async function determineDocsBranch(operatorRef, deps = {}) {
  const branchExists = deps.branchExists || docsBranchExists
  // Strip any "operator/" or "release/" prefix
  const TAG = operatorRef.replace(/^(?:operator|release)\//, '')
  // Extract v<major>.<minor>
  const mm = TAG.match(/^v(\d+\.\d+)/)
  const filtered = mm ? `v${mm[1]}` : null

  let branch
  if (!filtered) {
    branch = 'main'
  } else {
    // Pull in the remote Antora version
    const ANTORA = deps.antoraVersion || await fetchRemoteAntoraVersion(deps)
    // We started versioning the operator in line with Redpanda core versions. But when v2.4.x was the latest version, the docs were still on 25.1 and v25.1.x of the operator was still in beta. So we need to handle this special case.
    if (filtered === 'v2.4') {
      branch = ANTORA === '25.1' ? 'main' : 'v/24.3'
    // For all other versions use the v<major>.<minor> branch unless it is the current version, in which case we use 'main'.
    } else if (filtered === `v${ANTORA}`) {
      branch = 'main'
    } else {
      branch = `v/${filtered.slice(1)}`
    }
  }

  if (!branchExists(branch)) {
    throw new Error(`Docs branch ${branch} not found in https://github.com/redpanda-data/docs.git`)
  }

  return branch
}

module.exports = {
  fetchRemoteAntoraVersion,
  determineDocsBranch
}
