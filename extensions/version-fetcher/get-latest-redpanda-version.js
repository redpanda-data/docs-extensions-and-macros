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

      // Find latest RC release that is NOT a draft. The primary risk is a draft
      // outranking the real latest RC (a token with push access sees drafts;
      // unauthenticated CI does not, which is why this stays invisible there).
      // A draft's git tag usually already exists, but isn't guaranteed to --
      // when it's missing, the getRef below 404s, which the caller now handles
      // per-RC instead of letting it take down the whole lookup.
      const latestRcRelease = sortedReleases.find(
        release => release.tag_name.includes('-rc') && !release.draft
      );

      let latestRedpandaReleaseCommitHash = null;
      if (latestRedpandaRelease) {
        const commitData = await github.rest.git.getRef({
          owner,
          repo,
          ref: `tags/${latestRedpandaRelease.tag_name}`
        });
        latestRedpandaReleaseCommitHash = commitData.data.object.sha;
      }

      // Resolved separately from the stable release: an RC whose tag cannot be
      // resolved should cost us the RC, not the stable version the caller
      // probably asked for. Only a missing tag is tolerated; transient errors
      // still propagate so retryWithBackoff can retry them.
      let latestRcReleaseCommitHash = null;
      let resolvedRcRelease = latestRcRelease;
      if (latestRcRelease) {
        try {
          const rcCommitData = await github.rest.git.getRef({
            owner,
            repo,
            ref: `tags/${latestRcRelease.tag_name}`
          });
          latestRcReleaseCommitHash = rcCommitData.data.object.sha;
        } catch (error) {
          if (error.status !== 404) throw error;
          const message = `No git tag for RC release ${latestRcRelease.tag_name}; ignoring it.`;
          if (logger) {
            logger.warn(message);
          } else {
            console.error(`⚠️  ${message}`);
          }
          resolvedRcRelease = null;
        }
      }

      return {
        latestRedpandaRelease: latestRedpandaRelease ? {
          version: latestRedpandaRelease.tag_name,
          commitHash: latestRedpandaReleaseCommitHash.substring(0, 7)
        } : null,
        latestRcRelease: resolvedRcRelease ? {
          version: resolvedRcRelease.tag_name,
          commitHash: latestRcReleaseCommitHash.substring(0, 7)
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
