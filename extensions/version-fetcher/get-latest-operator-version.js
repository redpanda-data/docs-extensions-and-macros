module.exports = async () => {
  // Fetch the latest release version from GitHub
  const { Octokit } = await import("@octokit/rest");
  const { retry } = await import("@octokit/plugin-retry");
  const OctokitWithRetries = Octokit.plugin(retry);
  const owner = 'redpanda-data';
  const repo = 'redpanda-operator';

  let githubOptions = {
    userAgent: 'Redpanda Docs',
    baseUrl: 'https://api.github.com',
  };

  if (process.env.REDPANDA_GITHUB_TOKEN) {
    githubOptions.auth = process.env.REDPANDA_GITHUB_TOKEN;
  }

  const github = new OctokitWithRetries(githubOptions);
  try {
    const release = await github.rest.repos.getLatestRelease({ owner, repo });
    latestOperatorReleaseVersion = release.data.tag_name;
    return latestOperatorReleaseVersion;
  } catch (error) {
    console.error(error);
    return null;
  }
};