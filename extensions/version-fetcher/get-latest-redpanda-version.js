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

      // The RC's tag is resolved separately, not through resolveCommitHash:
      // a missing tag must exclude the RC entirely (it's an unpublished
      // draft slipping through by version alone, the bug this guards
      // against), not just null out its commit hash while still reporting
      // the draft's version as latest. Only a missing tag (404) is
      // tolerated; any other error still propagates so retryWithBackoff can
      // retry it.
      let latestRcReleaseCommitHash = null;
      let resolvedRcRelease = latestRcRelease;
      if (latestRcRelease) {
        try {
          const rcCommitData = await github.rest.git.getRef({
            owner,
            repo,
            ref: `tags/${latestRcRelease.tag_name}`
          });
          latestRcReleaseCommitHash = rcCommitData.data.object.sha.substring(0, 7);
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
          commitHash: latestRedpandaReleaseCommitHash
        } : null,
        latestRcRelease: resolvedRcRelease ? {
          version: resolvedRcRelease.tag_name,
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
