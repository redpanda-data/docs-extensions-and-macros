const { retryWithBackoff, isRetryableGitHubError } = require('./retry-util');

module.exports = async (github, owner, repo, logger = null) => {
  const semver = require('semver');

  return retryWithBackoff(
    async () => {
      // Fetch all the releases from the repository
      const releases = await github.rest.repos.listReleases({
        owner,
        repo,
        page: 1,
        per_page: 50
      });

      // Filter valid semver tags and sort them to find the highest version
      const sortedReleases = releases.data
        .map(release => release.tag_name)
        .filter(tag => semver.valid(tag.replace(/^v/, '')))
        .sort((a, b) => semver.rcompare(a.replace(/^v/, ''), b.replace(/^v/, '')));

      if (sortedReleases.length > 0) {
        // Find the highest versions for stable and beta releases
        const latestStableReleaseVersion = sortedReleases.find(tag => !tag.includes('-beta'));
        const latestBetaReleaseVersion = sortedReleases.find(tag => tag.includes('-beta'));

        return {
          latestStableRelease: latestStableReleaseVersion || null,
          latestBetaRelease: latestBetaReleaseVersion || null
        };
      } else {
        if (logger) {
          logger.warn("No valid semver releases found.");
        } else {
          console.log("No valid semver releases found.");
        }
        return { latestStableRelease: null, latestBetaRelease: null };
      }
    },
    {
      maxRetries: 3,
      initialDelay: 1000,
      shouldRetry: isRetryableGitHubError,
      operationName: `Fetch Console version from ${owner}/${repo}`
    },
    logger
  ).catch(error => {
    if (logger) {
      logger.error('Failed to fetch release information after retries:', error);
    } else {
      console.error('Failed to fetch release information after retries:', error);
    }
    return { latestStableRelease: null, latestBetaRelease: null };
  });
};
