/**
 * Fetches the latest version tag from Docker Hub for a given repository.
 *
 *
 * @param {string} dockerNamespace - The Docker Hub namespace (organization or username)
 * @param {string} dockerRepo - The repository name on Docker Hub
 * @returns {Promise<string|null>} The latest version tag or null if none is found.
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

    // Define a regular expression to capture the major and minor version numbers.
    // The regex /^v(\d+)\.(\d+)/ matches tags that start with "v", followed by digits (major),
    // a period, and more digits (minor). It works for tags like "v2.3.8-24.3.6" or "v25.1-k8s4".
    const versionRegex = /^v(\d+)\.(\d+)/;

    // Filter the list of tags to include only those that match our expected version pattern.
    // This helps ensure we work only with tags that represent valid version numbers.
    let versionTags = data.results.filter(tag => versionRegex.test(tag.name));

    // If the repository is "redpanda-operator", ignore any tags starting with "v23".
    if (dockerRepo === 'redpanda-operator') {
      versionTags = versionTags.filter(tag => !/^(v22|v23)/.test(tag.name));
    }

    if (versionTags.length === 0) {
      console.warn('No version tags found.');
      return null;
    }

    // Sort the filtered tags in descending order based on their major and minor version numbers.
    // This sorting ignores any additional patch or suffix details and focuses only on the major.minor value.
    versionTags.sort((a, b) => {
      const aMatch = a.name.match(versionRegex);
      const bMatch = b.name.match(versionRegex);
      const aMajor = parseInt(aMatch[1], 10);
      const aMinor = parseInt(aMatch[2], 10);
      const bMajor = parseInt(bMatch[1], 10);
      const bMinor = parseInt(bMatch[2], 10);

      // Compare by major version first; if equal, compare by minor version.
      if (aMajor !== bMajor) {
        return bMajor - aMajor;
      }
      return bMinor - aMinor;
    });

    // Return the name of the tag with the highest major.minor version.
    return versionTags[0].name;

  } catch (error) {
    console.error('Error fetching latest Docker tag:', error);
    return null;
  }
};
