/**
 * Fetches the latest stable and beta version tags from Docker Hub for a given repository.
 *
 * The function separates tags into stable (tags not including "-beta") and beta (tags including "-beta"),
 * sorts each group by their major.minor version in descending order, and returns the top tag from each.
 *
 * @param {string} dockerNamespace - The Docker Hub namespace (organization or username)
 * @param {string} dockerRepo - The repository name on Docker Hub
 * @returns {Promise<{ latestStableRelease: string|null, latestBetaRelease: string|null }>}
 */
module.exports = async (dockerNamespace, dockerRepo) => {
  const { default: fetch } = await import('node-fetch');

  try {
    // Fetch a list of tags from Docker Hub.
    const url = `https://hub.docker.com/v2/repositories/${dockerNamespace}/${dockerRepo}/tags?page_size=100`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Docker Hub API responded with status ${response.status}`);
    }

    const data = await response.json();

    // Regex to capture major and minor version numbers (e.g. "v2.3")
    const versionRegex = /^v(\d+)\.(\d+)/;

    // Filter tags to include only those matching the version pattern.
    let tags = data.results.filter(tag => versionRegex.test(tag.name));

    // For specific repositories (e.g. "redpanda-operator"), you might want to filter out certain versions.
    if (dockerRepo === 'redpanda-operator') {
      tags = tags.filter(tag => !/^(v22|v23)/.test(tag.name));
    }

    // Separate stable and beta tags.
    const stableTags = tags.filter(tag => !tag.name.includes('-beta'));
    const betaTags = tags.filter(tag => tag.name.includes('-beta'));

    // Helper function to sort tags in descending order based on major and minor version numbers.
    const sortTags = (a, b) => {
      const aMatch = a.name.match(versionRegex);
      const bMatch = b.name.match(versionRegex);
      const aMajor = parseInt(aMatch[1], 10);
      const aMinor = parseInt(aMatch[2], 10);
      const bMajor = parseInt(bMatch[1], 10);
      const bMinor = parseInt(bMatch[2], 10);

      if (aMajor !== bMajor) {
        return bMajor - aMajor;
      }
      return bMinor - aMinor;
    };

    const sortedStable = stableTags.sort(sortTags);
    const sortedBeta = betaTags.sort(sortTags);

    const latestStableReleaseVersion = sortedStable.length ? sortedStable[0].name : null;
    const latestBetaReleaseVersion = sortedBeta.length ? sortedBeta[0].name : null;

    return {
      latestStableRelease: latestStableReleaseVersion || null,
      latestBetaRelease: latestBetaReleaseVersion || null
    };

  } catch (error) {
    console.error('Error fetching Docker tags:', error);
    return {
      latestStableRelease: null,
      latestBetaRelease: null
    };
  }
};
