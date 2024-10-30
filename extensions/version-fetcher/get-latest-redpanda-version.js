module.exports = async (github, owner, repo) => {
  const semver = require('semver')
  try {
    // Fetch all the releases from the repository
    const releases = await github.rest.repos.listReleases({
      owner,
      repo,
      page: 1,
      per_page: 50
    });

    // Filter valid semver tags, exclude drafts, and sort them to find the highest version
    const sortedReleases = releases.data
      .filter(release => !release.draft)
      .map(release => release.tag_name)
      .filter(tag => semver.valid(tag.replace(/^v/, '')))
      .sort((a, b) => semver.rcompare(a.replace(/^v/, ''), b.replace(/^v/, '')));

    if (sortedReleases.length > 0) {
      const latestRedpandaReleaseVersion = sortedReleases.find(tag => !tag.includes('rc'));
      const latestRcReleaseVersion = sortedReleases.find(tag => tag.includes('rc'));

      // Get the commit hash for the highest version tag
      const commitData = await github.rest.git.getRef({
        owner,
        repo,
        ref: `tags/${latestRedpandaReleaseVersion}`
      });
      const latestRedpandaReleaseCommitHash = commitData.data.object.sha;

      let latestRcReleaseCommitHash = null;
      if (latestRcReleaseVersion) {
        const rcCommitData = await github.rest.git.getRef({
          owner,
          repo,
          ref: `tags/${latestRcReleaseVersion}`
        });
        latestRcReleaseCommitHash = rcCommitData.data.object.sha;
      }

      return {
        latestRedpandaRelease: latestRedpandaReleaseVersion ? {
          version: latestRedpandaReleaseVersion,
          commitHash: latestRedpandaReleaseCommitHash.substring(0, 7)
        } : null ,
        latestRcRelease: latestRcReleaseVersion ? {
          version: latestRcReleaseVersion,
          commitHash: latestRcReleaseCommitHash.substring(0, 7)
        } : null
      };
    } else {
      console.log("No valid semver releases found for Redpanda.");
      return { latestRedpandaRelease: null, latestRcRelease: null };
    }
  } catch (error) {
    console.error('Failed to fetch Redpanda release information:', error);
    return { latestRedpandaRelease: null, latestRcRelease: null };
  }
};
