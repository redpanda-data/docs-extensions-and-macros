module.exports = async (github, owner, repo) => {

  try {
    const release = await github.rest.repos.getLatestRelease({ owner, repo });
    tag = release.data.tag_name.replace(/^v/, '');
    return tag;
  } catch (error) {
    console.error(error);
    return null;
  }
};