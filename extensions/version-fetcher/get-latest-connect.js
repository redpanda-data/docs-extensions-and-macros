module.exports = async (github, owner, repo) => {

  try {
    const release = await github.rest.repos.getLatestRelease({ owner, repo });
    return release.data.tag_name
  } catch (error) {
    console.error(error);
    return null;
  }
};