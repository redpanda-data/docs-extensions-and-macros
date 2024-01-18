// Fetch the latest release version from GitHub
const { Octokit } = require("@octokit/rest");
const { retry } = require("@octokit/plugin-retry");
const OctokitWithRetries = Octokit.plugin(retry);
const owner = 'redpanda-data';
const repo = 'console';

let githubOptions = {
  userAgent: 'Redpanda Docs',
  baseUrl: 'https://api.github.com',
};

if (process.env.REDPANDA_GITHUB_TOKEN) {
  githubOptions.auth = process.env.REDPANDA_GITHUB_TOKEN;
}

const github = new OctokitWithRetries(githubOptions);

var latestConsoleReleaseVersion;

module.exports = async () => {
  await github.rest.repos.getLatestRelease({
    owner,
    repo,
  }).then((release => {
    const tag = release.data.tag_name;
    latestConsoleReleaseVersion = tag.replace('v','');
  })).catch((error => {
    console.error(error)
    return null
  }))
  return latestConsoleReleaseVersion;
};