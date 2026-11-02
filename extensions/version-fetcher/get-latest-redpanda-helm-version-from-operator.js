/**
 * Fetches the latest Helm chart version for an operator release line from the
 * redpanda-operator repository.
 *
 * A stable chart version comes from the newest stable `charts/redpanda/v<major>.<minor>.*`
 * tag, because a tag marks a chart that was actually published (what
 * `helm search repo` reports). A release branch's Chart.yaml can be bumped
 * ahead of the published chart, so it is only the fallback, and the only
 * source for beta versions.
 *
 * The chart has lived at more than one path over time (for example,
 * `charts/redpanda/Chart.yaml` on release/v25.1.x and
 * `charts/redpanda/chart/Chart.yaml` from release/v25.2.x on), so the fallback
 * tries each known path in order.
 *
 * @param {object} github - The GitHub API client.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name (redpanda-operator).
 * @param {string} stableDockerTag - The stable docker tag in format v<major>.<minor>.<patch>.
 * @param {string} betaDockerTag - Optional beta docker tag in format v<major>.<minor>.<patch>-beta.
 * @param {Object} logger - Optional Antora logger instance for logging
 * @returns {Promise<{ latestStableRelease: string|null, latestBetaRelease: string|null }>}
 */
module.exports = async (github, owner, repo, stableDockerTag, betaDockerTag, logger = null) => {
  const yaml = require('js-yaml');
  const semver = require('semver');
  const chartPaths = ['charts/redpanda/chart/Chart.yaml', 'charts/redpanda/Chart.yaml'];
  const warn = (message) => (logger ? logger.warn(message) : console.warn(message));
  const logError = (message) => (logger ? logger.error(message) : console.error(message));

  // Returns the newest stable published chart version of a release line, or
  // null when the line has no stable chart tag or the lookup fails.
  const getChartVersionFromTags = async (major, minor) => {
    if (!github.git?.listMatchingRefs) return null;
    const tagPrefix = 'charts/redpanda/v';
    const prefix = `${tagPrefix}${major}.${minor}.`;
    try {
      const { data } = await github.git.listMatchingRefs({ owner, repo, ref: `tags/${prefix}` });
      let newest = null;
      for (const { ref } of data || []) {
        const version = semver.valid(String(ref).slice(`refs/tags/${tagPrefix}`.length));
        if (!version || semver.prerelease(version)) continue;
        if (semver.major(version) !== Number(major) || semver.minor(version) !== Number(minor)) continue;
        if (!newest || semver.gt(version, newest)) newest = version;
      }
      return newest;
    } catch (error) {
      warn(`Could not list ${prefix}* tags in ${owner}/${repo}: ${error.message || error}`);
      return null;
    }
  };

  // Returns the chart version from the first known Chart.yaml path on a
  // branch, or null when none of the paths exist there.
  const getChartVersionFromBranch = async (dockerTag, branchName) => {
    for (const path of chartPaths) {
      try {
        const contentResponse = await github.repos.getContent({ owner, repo, path, ref: branchName });
        const contentDecoded = Buffer.from(contentResponse.data.content, 'base64').toString('utf8');
        return yaml.load(contentDecoded)?.version || null;
      } catch (error) {
        if (error.status === 404) continue;
        logError(`Failed to fetch ${path} from branch ${branchName}: ${error.message || error}`);
        return null;
      }
    }
    warn(`Fetched operator ${dockerTag} from Docker Hub but found no Helm chart for it: no ${chartPaths.join(' or ')} on branch ${branchName} (the branch may not exist yet)`);
    return null;
  };

  /**
   * Helper function to fetch chart version from a branch derived from a docker tag
   * @param {string} dockerTag - The docker tag to derive branch from
   * @returns {Promise<string|null>} - The chart version or null if not found
   */
  const getChartVersionFromTag = async (dockerTag) => {
    if (!dockerTag) return null;

    try {

      // Parse the docker tag to extract major and minor versions
      // Support both v2.4.2 format and v25.1.3 format
      const versionMatch = dockerTag.match(/^v(\d+)\.(\d+)(?:\.(\d+))?(?:-beta.*)?$/);

      if (!versionMatch) {
        if (logger) {
          logger.error(`Invalid docker tag format: ${dockerTag}`);
        } else {
          console.error(`Invalid docker tag format: ${dockerTag}`);
        }
        return null;
      }

      const [, major, minor] = versionMatch;
      const isBeta = /-beta/.test(dockerTag);

      if (!isBeta) {
        const published = await getChartVersionFromTags(major, minor);
        if (published) return published;
      }

      return await getChartVersionFromBranch(dockerTag, `release/v${major}.${minor}.x`);
    } catch (error) {
      if (logger) {
        logger.error(`Error processing docker tag ${dockerTag}:`, error.message);
      } else {
        console.error(`Error processing docker tag ${dockerTag}:`, error.message);
      }
      return null;
    }
  };
  try {
    // Get chart versions for both stable and beta tags in parallel
    const [stableChartVersion, betaChartVersion] = await Promise.all([
      getChartVersionFromTag(stableDockerTag),
      getChartVersionFromTag(betaDockerTag)
    ]);

    return {
      latestStableRelease: stableChartVersion,
      latestBetaRelease: betaChartVersion
    };
  } catch (error) {
    if (logger) {
      logger.error('Failed to fetch chart versions:', error.message);
    } else {
      console.error('Failed to fetch chart versions:', error.message);
    }
    return {
      latestStableRelease: null,
      latestBetaRelease: null
    };
  }
};
