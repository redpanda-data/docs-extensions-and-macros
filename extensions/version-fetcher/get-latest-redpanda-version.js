const { Octokit } = require("@octokit/rest");
const { retry } = require("@octokit/plugin-retry");
const semver = require("semver");
const OctokitWithRetries = Octokit.plugin(retry);

const owner = 'redpanda-data';
const repo = 'redpanda';

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
    // Fetch all the releases from the repository
    const releases = await github.rest.repos.listReleases({
      owner,
      repo,
      page: 1,
      per_page: 50
    });

    // Filter valid semver tags and sort them to find the highest version
    const sortedReleases = releases.data
      .map(release => release.tag_name.replace(/^v/, ''))
      .filter(tag => semver.valid(tag) && !tag.match(/rc-\d+$/))  // Exclude 'rc-{number}' suffixes
      // Sort in descending order to get the highest version first
      .sort(semver.rcompare);

    if (sortedReleases.length > 0) {
      const latestRedpandaReleaseVersion = sortedReleases[0];

      // Get the commit hash for the highest version tag
      const commitData = await github.rest.git.getRef({
        owner,
        repo,
        ref: `tags/v${latestRedpandaReleaseVersion}`
      });
      const latestRedpandaReleaseCommitHash = commitData.data.object.sha;

      return [latestRedpandaReleaseVersion, latestRedpandaReleaseCommitHash.substring(0, 7)];
    } else {
      console.log("No valid semver releases found for Redpanda.");
      return [null, null];
    }
  } catch (error) {
    console.error('Failed to fetch Redpanda release information:', error);
    return [null, null];
  }
};
