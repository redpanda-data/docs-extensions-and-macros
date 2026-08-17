const yaml = require('js-yaml');
const { spawnSync } = require('child_process');
const { getGitHubToken } = require('./github-token');

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
  const ghToken = 'token' in deps ? deps.token : getGitHubToken()

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
 * Determines the appropriate documentation branch for a given operator tag based on the remote Antora version.
 *
 * Normalizes the input tag, extracts the major.minor version, and applies version-specific logic to select the correct branch. Verifies that the chosen branch exists in the remote repository.
 *
 * @param {string} operatorTag - The operator tag to evaluate (for example, "operator/v25.1.2" or "v25.1.2").
 * @returns {Promise<string>} The name of the documentation branch to use.
 *
 * @throws {Error} If the tag cannot be parsed or if the determined branch does not exist in the remote repository.
 */
async function determineDocsBranch(operatorTag) {
  // Strip any "operator/" prefix
  const TAG = operatorTag.replace(/^(?:operator|release)\//, '')
  // Pull in the remote Antora version
  const ANTORA = await fetchRemoteAntoraVersion()
  // Extract v<major>.<minor>
  const mm = TAG.match(/^v(\d+\.\d+)/)
  const filtered = mm ? `v${mm[1]}` : null

  if (!filtered) {
    throw new Error(`Could not parse major.minor from ${TAG}`)
  }
  // We started versioning the operator in line with Redpanda core versions. But when v2.4.x was the latest version, the docs were still on 25.1 and v25.1.x of the operator was still in beta. So we need to handle this special case.
  let branch
  if (filtered === 'v2.4') {
    if (ANTORA === '25.1') {
      branch = 'main'
    } else {
      branch = 'v/24.3'
    }
  // For all other versions use the v<major>.<minor> branch unless it is the current version, in which case we use 'main'.
  } else if (filtered === `v${ANTORA}`) {
    branch = 'main'
  } else {
    branch = `v/${filtered.slice(1)}`
  }

  // Verify branch exists
  const repo = 'https://github.com/redpanda-data/docs.git'
  const ref  = `refs/heads/${branch}`
  const ok = spawnSync('git', ['ls-remote', '--exit-code', '--heads', repo, ref], {
    stdio: 'ignore'
  }).status === 0

  if (!ok) {
    throw new Error(`Docs branch ${branch} not found in ${repo}`)
  }

  return branch
}

module.exports = {
  fetchRemoteAntoraVersion,
  determineDocsBranch
}
