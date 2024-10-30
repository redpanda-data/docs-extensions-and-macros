module.exports = async (github, owner, repo) => {
  const semver = require('semver');
  try {
    const releases = await github.rest.repos.listReleases({
      owner,
      repo,
      page: 1,
      per_page: 50
    });

    // Filter tags with valid semver format
    const sortedReleases = releases.data
      .map(release => release.tag_name)
      .filter(tag => semver.valid(tag.replace(/^v/, '')))
      .sort((a, b) => semver.rcompare(a.replace(/^v/, ''), b.replace(/^v/, '')));

    if (sortedReleases.length > 0) {
      // Return the highest version with "v" prefix
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
