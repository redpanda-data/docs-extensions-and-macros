/**
 * Fetches the latest Helm chart version from the redpanda-operator repository
 * by converting docker tag format v<major>.<minor>.<patch> to release/v<major>.<minor>.x
 * and checking the Chart.yaml file in that branch.
 *
 * @param {object} github - The GitHub API client.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name (redpanda-operator).
 * @param {string} stableDockerTag - The stable docker tag in format v<major>.<minor>.<patch>.
 * @param {string} betaDockerTag - Optional beta docker tag in format v<major>.<minor>.<patch>-beta.
 * @returns {Promise<{ latestStableRelease: string|null, latestBetaRelease: string|null }>}
 */
module.exports = async (github, owner, repo, stableDockerTag, betaDockerTag) => {
  const yaml = require('js-yaml');
  const path = 'charts/redpanda/Chart.yaml';

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
        console.error(`Invalid docker tag format: ${dockerTag}`);
        return null;
      }

      const major = versionMatch[1];
      const minor = versionMatch[2];

      // Convert to release/v<major>.<minor>.x format
      const branchName = `release/v${major}.${minor}.x`;

      try {

        // Fetch Chart.yaml from the specified branch
        const contentResponse = await github.repos.getContent({
          owner,
          repo,
          path,
          ref: branchName,
        });

        const contentBase64 = contentResponse.data.content;
        const contentDecoded = Buffer.from(contentBase64, 'base64').toString('utf8');
        const chartYaml = yaml.load(contentDecoded);
        const version = chartYaml.version || null;
        return version;
      } catch (error) {
        console.error(`Failed to fetch Chart.yaml for branch ${branchName}:`, error.message);
        return null;
      }
    } catch (error) {
      console.error(`Error processing docker tag ${dockerTag}:`, error.message);
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
    console.error('Failed to fetch chart versions:', error.message);
    return {
      latestStableRelease: null,
      latestBetaRelease: null
    };
  }
};
