module.exports = async (github, owner, repo) => {
  const semver = require('semver');
  try {
    // Fetch all the releases from the repository
    const releases = await github.rest.repos.listReleases({
      owner,
      repo,
      page: 1,
      per_page: 50
    });

    // Filter valid semver tags and sort them to find the highest version
    const sortedReleases = releases.data
      .map(release => release.tag_name)
      .filter(tag => semver.valid(tag.replace(/^v/, '')))
      .sort((a, b) => semver.rcompare(a.replace(/^v/, ''), b.replace(/^v/, '')));

    if (sortedReleases.length > 0) {
      // Find the highest versions for stable and beta releases
      const latestStableReleaseVersion = sortedReleases.find(tag => !tag.includes('-beta'));
      const latestBetaReleaseVersion = sortedReleases.find(tag => tag.includes('-beta'));

      return {
        latestStableRelease: latestStableReleaseVersion || null,
        latestBetaRelease: latestBetaReleaseVersion || null
      };
    } else {
      console.log("No valid semver releases found.");
      return { latestStableRelease: null, latestBetaRelease: null };
    }
  } catch (error) {
    console.error('Failed to fetch release information:', error);
    return { latestStableRelease: null, latestBetaRelease: null };
  }
};
