module.exports = async (github, owner, repo) => {
  try {
    const release = await github.rest.repos.getLatestRelease({ owner, repo });
    latestOperatorReleaseVersion = release.data.tag_name;
    return latestOperatorReleaseVersion;
  } catch (error) {
    console.error(error);
    return null;
  }
};