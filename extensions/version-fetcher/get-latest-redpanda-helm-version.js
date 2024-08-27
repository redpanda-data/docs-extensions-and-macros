module.exports = async (github, owner, repo, path) => {
  const yaml = require('js-yaml');
  try {
    const response = await github.repos.getContent({
      owner: owner,
      repo: repo,
      path: path,
    });

    const contentBase64 = response.data.content;
    const contentDecoded = Buffer.from(contentBase64, 'base64').toString('utf8');
    const chartYaml = yaml.load(contentDecoded);
    return chartYaml.version;
  } catch (error) {
    console.error('Failed to fetch chart version:', error.message);
    return null
  }
};
