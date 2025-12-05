/**
 * GitHub Token Utility
 *
 * Provides a consistent way to retrieve GitHub tokens from environment variables.
 * Supports multiple common token variable names with priority order.
 */

/**
 * Get GitHub token from environment variables
 * Checks multiple common variable names in priority order:
 * 1. REDPANDA_GITHUB_TOKEN - Custom Redpanda token
 * 2. GITHUB_TOKEN - GitHub Actions default
 * 3. GH_TOKEN - GitHub CLI default
 *
 * @returns {string|null} GitHub token or null if not found
 */
function getGitHubToken() {
  return process.env.REDPANDA_GITHUB_TOKEN ||
         process.env.GITHUB_TOKEN ||
         process.env.GH_TOKEN ||
         null;
}

/**
 * Get an authenticated GitHub URL by injecting the token
 * @param {string} url - The GitHub HTTPS URL (e.g., https://github.com/owner/repo.git)
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
  getAuthenticatedGitHubUrl,
  hasGitHubToken
};
