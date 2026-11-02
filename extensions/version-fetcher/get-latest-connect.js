module.exports = async (github, owner, repo, logger = null) => {

  try {
    const release = await github.rest.repos.getLatestRelease({ owner, repo });
    return release.data.tag_name
  } catch (error) {
    if (logger) {
      logger.error(error);
    } else {
      console.error(error);
    }
    return null;
  }
};