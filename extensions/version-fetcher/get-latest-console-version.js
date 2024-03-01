const { Octokit } = require("@octokit/rest");
const { retry } = require("@octokit/plugin-retry");
const semver = require("semver");
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

module.exports = async () => {
  try {
    // Fetch the latest 10 releases
    const releases = await github.rest.repos.listReleases({
      owner,
      repo,
      per_page: 10,
    });

    // Filter valid semver tags and sort them
    const sortedReleases = releases.data
      .map(release => release.tag_name.replace(/^v/, ''))
      .filter(tag => semver.valid(tag))
      // Sort in descending order to get the highest version first
      .sort(semver.rcompare);

    if (sortedReleases.length > 0) {
      // Return the highest version
      return sortedReleases[0];
    } else {
      console.log("No valid semver releases found.");
      return null;
    }
  } catch (error) {
    console.error(error);
    return null;
  }
};
