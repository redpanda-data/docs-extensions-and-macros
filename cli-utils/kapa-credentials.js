/**
 * Kapa API Credentials Utility
 *
 * Provides a consistent way to retrieve Kapa API credentials from environment
 * variables, so no generator reads process.env.KAPA_* directly. Mirrors
 * cli-utils/github-token.js: resolve here, return null when absent, and let the
 * calling command decide whether a missing credential is fatal.
 *
 * The variable names are not new. They are already the established pair in
 * redpanda-data/docs-site (netlify/functions/kapa-session.mjs) and in
 * docs-team-standards/scripts/docs_analytics/kapa_probe.py, so a third spelling
 * would just be a fourth place to get it wrong.
 */

// Kapa's public API. Both the ingestion and query endpoints live here, and both
// authenticate with the same project API key -- there is no separate ingestion
// key and no scope model.
const KAPA_API_BASE = 'https://api.kapa.ai';

// Kapa's OpenAPI schema spells the header X-API-KEY; their prose pages also use
// X-API-Key in places. HTTP header names are case-insensitive so either works,
// but pin the canonical spelling from the schema.
const KAPA_API_KEY_HEADER = 'X-API-KEY';

/**
 * Get the Kapa API key.
 *
 * @param {object} [env] - Environment to read (defaults to process.env)
 * @returns {string|null} The API key, or null when unset/blank
 */
function getKapaApiKey (env = process.env) {
  const key = (env.KAPA_API_KEY || '').trim()
  return key || null
}

/**
 * Get the Kapa project ID.
 *
 * @param {object} [env] - Environment to read (defaults to process.env)
 * @returns {string|null} The project ID, or null when unset/blank
 */
function getKapaProjectId (env = process.env) {
  const id = (env.KAPA_PROJECT_ID || '').trim()
  return id || null
}

/**
 * True when both credentials are present.
 *
 * @param {object} [env] - Environment to read (defaults to process.env)
 * @returns {boolean}
 */
function hasKapaCredentials (env = process.env) {
  return Boolean(getKapaApiKey(env) && getKapaProjectId(env))
}

/**
 * Resolve both credentials, or throw with a remediation hint naming exactly
 * what is missing.
 *
 * Generators that write published content call this and let it throw: an
 * unauthenticated run would otherwise produce an empty mapping that looks
 * identical to "Kapa has no source groups", and the drift check would then
 * report false drift forever. Fail loud, like cloud-regions does for its
 * GitHub token.
 *
 * @param {object} [env] - Environment to read (defaults to process.env)
 * @returns {{apiKey: string, projectId: string, apiBase: string, headerName: string}}
 * @throws {Error} When either credential is missing
 */
function requireKapaCredentials (env = process.env) {
  const apiKey = getKapaApiKey(env)
  const projectId = getKapaProjectId(env)

  const missing = []
  if (!apiKey) missing.push('KAPA_API_KEY')
  if (!projectId) missing.push('KAPA_PROJECT_ID')

  if (missing.length) {
    throw new Error(
      `Kapa credentials are required: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
      'Create an API key in the Kapa platform under Configuration > API Keys, and find the project ID ' +
      'in the dashboard URL (https://app.kapa.ai/<project-id>). ' +
      'In CI these come from AWS Secrets Manager via OIDC, not from GitHub secrets directly.'
    )
  }

  return { apiKey, projectId, apiBase: KAPA_API_BASE, headerName: KAPA_API_KEY_HEADER }
}

/**
 * Build the auth headers for a Kapa API request.
 *
 * @param {string} apiKey
 * @returns {object} Headers suitable for fetch()
 */
function kapaAuthHeaders (apiKey) {
  return { [KAPA_API_KEY_HEADER]: apiKey, Accept: 'application/json' }
}

module.exports = {
  KAPA_API_BASE,
  KAPA_API_KEY_HEADER,
  getKapaApiKey,
  getKapaProjectId,
  hasKapaCredentials,
  requireKapaCredentials,
  kapaAuthHeaders,
}
