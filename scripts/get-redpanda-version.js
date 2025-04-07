// Import the version fetcher module
const GetLatestRedpandaVersion = require('../extensions/version-fetcher/get-latest-redpanda-version.js');
const yaml = require('js-yaml');
const fs = require('fs');

// Fetch the latest release version from GitHub
const owner = 'redpanda-data';

// Parse command-line arguments
const args = process.argv.slice(2);
const betaFlag = args.includes('--beta');

function getPrereleaseFromAntora() {
  try {
    const fileContents = fs.readFileSync('../../antora.yml', 'utf8');
    const antoraConfig = yaml.load(fileContents);
    return antoraConfig.prerelease === true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error("Error reading antora.yml file:", error);
    }
    return undefined; // Fallback to --beta later
  }
}

// Try antora.yml, fallback to CLI flag
const antoraPrerelease = getPrereleaseFromAntora();
const beta = typeof antoraPrerelease === 'boolean' ? antoraPrerelease : betaFlag;

// Conditionally set DOCKER_REPO for subsequent test steps such as the Docker Compose file
if (beta) {
  REDPANDA_DOCKER_REPO = 'redpanda-unstable';
} else {
  REDPANDA_DOCKER_REPO = 'redpanda';
}
const repo = 'redpanda';

async function loadOctokit() {
  const { Octokit } = await import('@octokit/rest');
  if (!process.env.REDPANDA_GITHUB_TOKEN) {
    return new Octokit();
  }
  return new Octokit({
    auth: process.env.REDPANDA_GITHUB_TOKEN,
  });
}

(async () => {
  try {
    const github = await loadOctokit();
    const results = await Promise.allSettled([
      GetLatestRedpandaVersion(github, owner, repo),
    ]);

    const LatestRedpandaVersion = results[0].status === 'fulfilled' ? results[0].value : null;

    if (!LatestRedpandaVersion) {
      throw new Error('Failed to fetch the latest Redpanda version');
    }
    // Determine the release version based on the beta flag, with a fallback to stable release if RC is null
    const latestRedpandaReleaseVersion = beta
      ? (LatestRedpandaVersion.latestRcRelease && LatestRedpandaVersion.latestRcRelease.version
      ? LatestRedpandaVersion.latestRcRelease.version
      : `${LatestRedpandaVersion.latestRedpandaRelease.version}`)
    : `${LatestRedpandaVersion.latestRedpandaRelease.version}`;

    if (!LatestRedpandaVersion.latestRcRelease) REDPANDA_DOCKER_REPO = 'redpanda'

    // Print both version and Docker repo for Doc Detective to capture
    console.log(`REDPANDA_VERSION=${latestRedpandaReleaseVersion}`);
    console.log(`REDPANDA_DOCKER_REPO=${REDPANDA_DOCKER_REPO}`);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
