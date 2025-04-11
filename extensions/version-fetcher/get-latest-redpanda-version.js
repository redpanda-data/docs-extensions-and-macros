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
      .filter(release => semver.valid(release.tag_name.replace(/^v/, '')))
      .sort((a, b) => semver.rcompare(
        a.tag_name.replace(/^v/, ''),
        b.tag_name.replace(/^v/, '')
      ));

    // Find latest non-RC release that is NOT a draft
    const latestRedpandaRelease = sortedReleases.find(
      release => !release.tag_name.includes('-rc') && !release.draft
    );

    // Find latest RC release (can be draft or not, adjust if needed)
    const latestRcRelease = sortedReleases.find(
      release => release.tag_name.includes('-rc')
    );

    let latestRedpandaReleaseCommitHash = null;
    if (latestRedpandaRelease) {
      const commitData = await github.rest.git.getRef({
        owner,
        repo,
        ref: `tags/${latestRedpandaRelease.tag_name}`
      });
      latestRedpandaReleaseCommitHash = commitData.data.object.sha;
    }

    let latestRcReleaseCommitHash = null;
    if (latestRcRelease) {
      const rcCommitData = await github.rest.git.getRef({
        owner,
        repo,
        ref: `tags/${latestRcRelease.tag_name}`
      });
      latestRcReleaseCommitHash = rcCommitData.data.object.sha;
    }

    return {
      latestRedpandaRelease: latestRedpandaRelease ? {
        version: latestRedpandaRelease.tag_name,
        commitHash: latestRedpandaReleaseCommitHash.substring(0, 7)
      } : null,
      latestRcRelease: latestRcRelease ? {
        version: latestRcRelease.tag_name,
        commitHash: latestRcReleaseCommitHash.substring(0, 7)
      } : null
    };
  } catch (error) {
    console.error('Failed to fetch Redpanda release information:', error);
    return { latestRedpandaRelease: null, latestRcRelease: null };
  }
};
