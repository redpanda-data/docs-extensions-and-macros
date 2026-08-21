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
        .filter(release => semver.valid(release.tag_name.replace(/^v/, '')))
        .sort((a, b) => semver.rcompare(
          a.tag_name.replace(/^v/, ''),
          b.tag_name.replace(/^v/, '')
        ));

      // Find latest non-RC release that is NOT a draft
      const latestRedpandaRelease = sortedReleases.find(
        release => !release.tag_name.includes('-rc') && !release.draft
      );

      // Find latest RC release (can be draft or not, adjust if needed)
      const latestRcRelease = sortedReleases.find(
        release => release.tag_name.includes('-rc')
      );

      // A release can exist before its tag is pushed, which is routine for draft
      // RCs, and GitHub answers the ref lookup with a 404. Losing the commit hash
      // must not cost us the version: an uncaught 404 here aborts the whole
      // lookup and every latest-redpanda-* attribute goes unset for the build.
      const resolveCommitHash = async (release) => {
        if (!release) return null;
        try {
          // Retry the ref lookup on its own. A rate limit or a 5xx is transient
          // and deserves the attempts; swallowing it immediately turned one
          // blip into a permanently unset commit attribute. Retrying HERE
          // rather than letting the error escape is what keeps a exhausted
          // retry from also costing us the version, which is strictly worse
          // than losing the commit hash.
          const commitData = await retryWithBackoff(
            () => github.rest.git.getRef({ owner, repo, ref: `tags/${release.tag_name}` }),
            { shouldRetry: isRetryableGitHubError, operationName: `getRef ${release.tag_name}` },
            logger
          );
          return commitData.data.object.sha.substring(0, 7);
        } catch (error) {
          const message = `Could not resolve the commit for ${release.tag_name}, so its commit attribute is unset: ${error.status || ''} ${error.message || error}`;
          if (logger) {
            logger.warn(message);
          } else {
            console.warn(message);
          }
          return null;
        }
      };

      const latestRedpandaReleaseCommitHash = await resolveCommitHash(latestRedpandaRelease);
      const latestRcReleaseCommitHash = await resolveCommitHash(latestRcRelease);

      return {
        latestRedpandaRelease: latestRedpandaRelease ? {
          version: latestRedpandaRelease.tag_name,
          commitHash: latestRedpandaReleaseCommitHash
        } : null,
        latestRcRelease: latestRcRelease ? {
          version: latestRcRelease.tag_name,
          commitHash: latestRcReleaseCommitHash
        } : null
      };
    },
    {
      maxRetries: 3,
      initialDelay: 1000,
      shouldRetry: isRetryableGitHubError,
      operationName: `Fetch Redpanda version from ${owner}/${repo}`
    },
    logger
  ).catch(error => {
    if (logger) {
      logger.error('Failed to fetch Redpanda release information after retries:', error);
    } else {
      console.error('Failed to fetch Redpanda release information after retries:', error);
    }
    return { latestRedpandaRelease: null, latestRcRelease: null };
  });
};
