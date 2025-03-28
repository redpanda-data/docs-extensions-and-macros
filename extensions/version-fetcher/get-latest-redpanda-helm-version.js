/**
 * Fetches the latest Helm chart version from GitHub releases.
 *
 * This function looks for releases with tags following these patterns:
 *   - Stable: "redpanda-5.9.21" or "25.1-k8s4" (without "beta" anywhere)
 *   - Beta: "redpanda-5.9.21-beta", "redpanda-5.9.21-beta.1", or "25.1-k8s4-beta"
 *
 * It selects the highest version for each category, fetches the file at the provided path
 * (typically Chart.yaml) using the tag as the Git ref, parses it, and returns an object with
 * the chart version from the highest stable release and the highest beta release.
 *
 * @param {object} github - The GitHub API client.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @param {string} path - The path to the Chart.yaml file in the repository.
 * @returns {Promise<{ latestStableRelease: string|null, latestBetaRelease: string|null }>}
 */
module.exports = async (github, owner, repo, path) => {
  const yaml = require('js-yaml');
  try {
    // Fetch up to 20 releases from GitHub.
    const releasesResponse = await github.repos.listReleases({
      owner,
      repo,
      per_page: 20,
    });
    const releases = releasesResponse.data;

    // Regex patterns:
    // Stable regex: "redpanda-" prefix, then major.minor with an optional patch,
    // and no "beta" anywhere in the tag.
    const stableRegex = /^(?:redpanda-)(\d+)\.(\d+)(?:\.(\d+))?(?!.*beta)/i;
    // Beta regex: "redpanda-" prefix, then major.minor with an optional patch,
    // and later somewhere "beta" with an optional numeric qualifier.
    const betaRegex = /^(?:redpanda-)(\d+)\.(\d+)(?:\.(\d+))?.*beta(?:\.(\d+))?$/i;

    // Filter releases into stable and beta arrays based on tag matching.
    const stableReleases = releases.filter(release => stableRegex.test(release.tag_name));
    const betaReleases = releases.filter(release => betaRegex.test(release.tag_name));

    // Sorting function for stable releases.
    const sortStable = (a, b) => {
      const aMatch = a.tag_name.match(stableRegex);
      const bMatch = b.tag_name.match(stableRegex);
      if (!aMatch || !bMatch) return 0;
      const aMajor = parseInt(aMatch[1], 10);
      const aMinor = parseInt(aMatch[2], 10);
      const aPatch = aMatch[3] ? parseInt(aMatch[3], 10) : 0;
      const bMajor = parseInt(bMatch[1], 10);
      const bMinor = parseInt(bMatch[2], 10);
      const bPatch = bMatch[3] ? parseInt(bMatch[3], 10) : 0;
      if (aMajor !== bMajor) return bMajor - aMajor;
      if (aMinor !== bMinor) return bMinor - aMinor;
      return bPatch - aPatch;
    };

    // Sorting function for beta releases.
    const sortBeta = (a, b) => {
      const aMatch = a.tag_name.match(betaRegex);
      const bMatch = b.tag_name.match(betaRegex);
      if (!aMatch || !bMatch) return 0;
      const aMajor = parseInt(aMatch[1], 10);
      const aMinor = parseInt(aMatch[2], 10);
      const aPatch = aMatch[3] ? parseInt(aMatch[3], 10) : 0;
      // Optional beta number; if not provided, assume 0.
      const aBeta = aMatch[4] ? parseInt(aMatch[4], 10) : 0;
      const bMajor = parseInt(bMatch[1], 10);
      const bMinor = parseInt(bMatch[2], 10);
      const bPatch = bMatch[3] ? parseInt(bMatch[3], 10) : 0;
      const bBeta = bMatch[4] ? parseInt(bMatch[4], 10) : 0;
      if (aMajor !== bMajor) return bMajor - aMajor;
      if (aMinor !== bMinor) return bMinor - aMinor;
      if (aPatch !== bPatch) return bPatch - aPatch;
      return bBeta - aBeta;
    };

    // Sort both arrays in descending order.
    stableReleases.sort(sortStable);
    betaReleases.sort(sortBeta);

    // Get the highest tag from each group, if available.
    const latestStableTag = stableReleases.length ? stableReleases[0].tag_name : null;
    const latestBetaTag = betaReleases.length ? betaReleases[0].tag_name : null;

    // Helper function to fetch and parse Chart.yaml from a given tag.
    const fetchChartVersion = async (tag) => {
      if (!tag) return null;
      try {
        const contentResponse = await github.repos.getContent({
          owner,
          repo,
          path,
          ref: tag,
        });
        const contentBase64 = contentResponse.data.content;
        const contentDecoded = Buffer.from(contentBase64, 'base64').toString('utf8');
        const chartYaml = yaml.load(contentDecoded);
        return chartYaml.version || null;
      } catch (error) {
        console.error(`Failed to fetch Chart.yaml for tag ${tag}:`, error.message);
        return null;
      }
    };

    const [latestStableReleaseVersion, latestBetaReleaseVersion] = await Promise.all([
      fetchChartVersion(latestStableTag),
      fetchChartVersion(latestBetaTag)
    ]);

    return {
      latestStableRelease: latestStableReleaseVersion,
      latestBetaRelease: latestBetaReleaseVersion
    };

  } catch (error) {
    console.error('Failed to fetch chart version:', error.message);
    return {
      latestStableRelease: null,
      latestBetaRelease: null
    };
  }
};
