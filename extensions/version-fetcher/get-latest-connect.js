// Fetch the latest release version from GitHub
const { Octokit } = require("@octokit/rest");
const { retry } = require("@octokit/plugin-retry");
const OctokitWithRetries = Octokit.plugin(retry);
const owner = 'redpanda-data';
const repo = 'connect';

let githubOptions = {
  userAgent: 'Redpanda Docs',
  baseUrl: 'https://api.github.com',
};

if (process.env.REDPANDA_GITHUB_TOKEN) {
  githubOptions.auth = process.env.REDPANDA_GITHUB_TOKEN;
}

const github = new OctokitWithRetries(githubOptions);

module.exports = async () => {
  try {
    const release = await github.rest.repos.getLatestRelease({ owner, repo });
    tag = release.data.tag_name.replace(/^v/, '');
    return tag;
  } catch (error) {
    console.error(error);
    return null;
  }
};