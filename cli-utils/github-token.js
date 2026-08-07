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
    if (!match || !match[2].includes('github.com')) continue;

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

/**
 * Get GitHub token from environment variables
 * Checks multiple common variable names in priority order:
 * 1. GIT_CREDENTIALS - Antora's credential store contents (github.com entry)
 * 2. REDPANDA_GITHUB_TOKEN - Custom Redpanda token
 * 3. ACTIONS_BOT_TOKEN - GitHub Actions bot token
 * 4. GITHUB_TOKEN - GitHub Actions default
 * 5. VBOT_GITHUB_API_TOKEN - Legacy bot token
 * 6. GH_TOKEN - GitHub CLI default
 *
 * @returns {string|null} GitHub token or null if not found
 */
function getGitHubToken() {
  return getTokenFromGitCredentials() ||
         process.env.REDPANDA_GITHUB_TOKEN ||
         process.env.ACTIONS_BOT_TOKEN ||
         process.env.GITHUB_TOKEN ||
         process.env.VBOT_GITHUB_API_TOKEN ||
         process.env.GH_TOKEN ||
         null;
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
  getTokenFromGitCredentials,
  getAuthenticatedGitHubUrl,
  hasGitHubToken
};
