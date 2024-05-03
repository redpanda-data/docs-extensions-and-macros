const { Octokit } = require("@octokit/rest");
const { retry } = require("@octokit/plugin-retry");
const yaml = require('js-yaml');
const OctokitWithRetries = Octokit.plugin(retry);

const githubOptions = {
  userAgent: 'Redpanda Docs',
  baseUrl: 'https://api.github.com',
  auth: process.env.REDPANDA_GITHUB_TOKEN
};

const github = new OctokitWithRetries(githubOptions);
const owner = 'redpanda-data';
const repo = 'helm-charts';
const path = 'charts/redpanda/Chart.yaml';

module.exports = async () => {
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
