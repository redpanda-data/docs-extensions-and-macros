'use strict'

// The GitHub API client the Redpanda Connect extensions use for release
// lookups: authenticated when a token is available, retrying transient
// failures but not rate limits or missing resources.

const { getGitHubApiToken } = require('../../cli-utils/github-token')

async function createGitHub () {
  const { Octokit } = await import('@octokit/rest')
  const { retry } = await import('@octokit/plugin-retry')
  const token = getGitHubApiToken()
  return new (Octokit.plugin(retry))({ userAgent: 'Redpanda Docs', auth: token || undefined, retry: { doNotRetry: [403, 404, 429] } })
}

module.exports = { createGitHub }
