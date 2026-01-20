'use strict'

const { Octokit } = require('@octokit/rest')
const { getGitHubToken } = require('./github-token')

/**
 * Shared Octokit client instance for GitHub API access
 * Configured with optional authentication and retry logic
 *
 * This singleton instance is shared across all doc-tools modules to:
 * - Avoid redundant initialization
 * - Share rate limit tracking
 * - Centralize GitHub API configuration
 */

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
const octokit = new Octokit(octokitOptions)

module.exports = octokit
