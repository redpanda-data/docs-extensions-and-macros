'use strict'

// The most recent releases of a repository, newest first, as the GitHub API
// lists them (the requested page of at most `limit` releases). Each release carries its
// assets, so a caller can check for an asset without downloading it. Throws
// when the API is unavailable, so the caller can fall back to git tags.
module.exports = async (github, owner, repo, limit, page = 1) => {
  const { data } = await github.rest.repos.listReleases({ owner, repo, per_page: limit, page })
  return Array.isArray(data) ? data.slice(0, limit) : []
}
