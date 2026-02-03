'use strict'

const { getGitHubToken } = require('./github-token')

/**
 * Shared Octokit client instance for GitHub API access
 * Configured with optional authentication and retry logic
 *
 * This singleton instance is shared across all doc-tools modules to:
 * - Avoid redundant initialization
 * - Share rate limit tracking
 * - Centralize GitHub API configuration
 *
 * Uses lazy initialization with async import to support ESM-only @octokit/rest
 */

// Singleton instance cache
let octokitInstance = null

/**
 * Get or create the shared Octokit client instance
 * @returns {Promise<Octokit>} The Octokit client instance
 */
async function getOctokit() {
  if (!octokitInstance) {
    // Dynamic import for ESM-only @octokit/rest
    const { Octokit } = await import('@octokit/rest')

    // Get authentication token from environment
    const token = getGitHubToken()

    // Configure Octokit options
    const octokitOptions = {
      userAgent: 'redpanda-docs-tools',
      retry: {
        enabled: true,
        retries: 3
      }
    }

    // Only add auth if token is available
    if (token) {
      octokitOptions.auth = token
    }

    // Create singleton instance
    octokitInstance = new Octokit(octokitOptions)
  }

  return octokitInstance
}

module.exports = { getOctokit }
