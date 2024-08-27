module.exports = async (github, owner, repo) => {
  const semver = require('semver')
  try {
    const releases = await github.rest.repos.listReleases({
      owner,
      repo,
      page: 1,
      per_page: 50
    });

    // Filter valid semver tags and sort them
    const sortedReleases = releases.data
      .map(release => release.tag_name.replace(/^v/, ''))
      .filter(tag => semver.valid(tag))
      // Sort in descending order to get the highest version first
      .sort(semver.rcompare);

    if (sortedReleases.length > 0) {
      // Return the highest version
      return sortedReleases[0];
    } else {
      console.log("No valid semver releases found.");
      return null;
    }
  } catch (error) {
    console.error(error);
    return null;
  }
};
