module.exports = async () => {
  const { Octokit } = await import("@octokit/rest");
  const { retry } = await import("@octokit/plugin-retry");
  const semver = await import("semver");
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

  try {
    const releases = await github.rest.repos.listReleases({
      owner,
      repo,
      page: 1,
      per_page: 50
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
