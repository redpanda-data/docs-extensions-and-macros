/**
 * GitHub Token Utility
 *
 * Provides a consistent way to retrieve GitHub tokens from environment variables.
 * Supports multiple common token variable names with priority order.
 */

/**
 * Extract a GitHub token from the GIT_CREDENTIALS environment variable.
 *
 * GIT_CREDENTIALS is the variable Antora's own credential manager reads, so in
 * Antora builds (for example, Netlify) it is the source guaranteed to hold a
 * working credential for private content sources. Entries follow the git
 * credential store format and may be separated by commas or newlines:
 *
 *   https://<token>:@github.com
 *   https://<username>:<password>@github.com
 *   https://x-access-token:<token>@github.com
 *
 * @param {string} [credentials] - Credential contents (defaults to process.env.GIT_CREDENTIALS)
 * @returns {string|null} GitHub token or null if no github.com entry found
 */
function getTokenFromGitCredentials(credentials = process.env.GIT_CREDENTIALS) {
  if (!credentials) return null;

  for (const entry of credentials.split(/[,\n]/)) {
    const match = entry.trim().match(/^https?:\/\/([^@]+)@([^/]+)/);
    // Exact host match (optional port) so entries for lookalike hosts such as
    // github.com.evil.example or notgithub.com are never treated as GitHub.
    if (!match || !/^github\.com(:\d+)?$/i.test(match[2])) continue;

    const [username, ...passwordParts] = match[1].split(':');
    const password = passwordParts.join(':');

    // Token may sit in the username position (https://TOKEN:@github.com) or,
    // when a username such as x-access-token is present, in the password position.
    const token = password || username;
    if (!token) continue;

    try {
      return decodeURIComponent(token);
    } catch (err) {
      return token;
    }
  }

  return null;
}

const API_TOKEN_VARS = [
  'REDPANDA_GITHUB_TOKEN',
  'ACTIONS_BOT_TOKEN',
  'GITHUB_TOKEN',
  'VBOT_GITHUB_API_TOKEN',
  'GH_TOKEN'
];

function firstApiTokenVar() {
  for (const name of API_TOKEN_VARS) {
    if (process.env[name]) return process.env[name];
  }
  return null;
}

/**
 * Get the GitHub token for git operations (clone, fetch, authenticated URLs).
 *
 * Checks, in priority order:
 * 1. GIT_CREDENTIALS - Antora's credential store contents (github.com entry)
 * 2. REDPANDA_GITHUB_TOKEN - Custom Redpanda token
 * 3. ACTIONS_BOT_TOKEN - GitHub Actions bot token
 * 4. GITHUB_TOKEN - GitHub Actions default
 * 5. VBOT_GITHUB_API_TOKEN - Legacy bot token
 * 6. GH_TOKEN - GitHub CLI default
 *
 * GIT_CREDENTIALS wins here on purpose: it is the credential Antora itself
 * clones the content repos with, so anything else that clones in the same
 * build should use the same identity. It is a git credential, not an API
 * one; for REST calls use getGitHubApiToken().
 *
 * @returns {string|null} GitHub token or null if not found
 */
function getGitHubToken() {
  return getTokenFromGitCredentials() || firstApiTokenVar();
}

/**
 * Get the GitHub token for REST API calls (Octokit, api.github.com,
 * raw.githubusercontent.com).
 *
 * Same variables as getGitHubToken(), but GIT_CREDENTIALS comes LAST:
 *
 * 1. REDPANDA_GITHUB_TOKEN
 * 2. ACTIONS_BOT_TOKEN
 * 3. GITHUB_TOKEN
 * 4. VBOT_GITHUB_API_TOKEN
 * 5. GH_TOKEN
 * 6. GIT_CREDENTIALS
 *
 * Why the different order: on the Netlify Antora sites GIT_CREDENTIALS holds
 * a token scoped only to cloning the private docs content repos. Letting it
 * outrank REDPANDA_GITHUB_TOKEN meant the release lookup against the private
 * streaming-enterprise repo authenticated with a token that cannot see that
 * repo, got a 404, and every latest-redpanda-* attribute went unset in the
 * production build even though a token with access was sitting right there.
 * An explicitly named API token always beats the git credential; the git
 * credential remains a fallback so a build with only GIT_CREDENTIALS still
 * authenticates.
 *
 * @returns {string|null} GitHub token or null if not found
 */
function getGitHubApiToken() {
  return firstApiTokenVar() || getTokenFromGitCredentials();
}

/**
 * Get an authenticated GitHub URL by injecting the token
 * @param {string} url - The GitHub HTTPS URL (for example, https://github.com/owner/repo.git)
 * @returns {string} Authenticated URL with token, or original URL if no token available
 */
function getAuthenticatedGitHubUrl(url) {
  const token = getGitHubToken();

  if (!token || !url.includes('github.com')) {
    return url;
  }

  try {
    const urlObj = new URL(url);
    urlObj.username = token;
    return urlObj.toString();
  } catch (err) {
    // If URL parsing fails, return original
    return url;
  }
}

/**
 * Check if a GitHub token is available
 * @returns {boolean} True if a token is available
 */
function hasGitHubToken() {
  return getGitHubToken() !== null;
}

module.exports = {
  getGitHubToken,
  getGitHubApiToken,
  getTokenFromGitCredentials,
  getAuthenticatedGitHubUrl,
  hasGitHubToken
};
