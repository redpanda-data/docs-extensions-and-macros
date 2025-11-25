#!/usr/bin/env node

const GetLatestRedpandaVersion = require('../extensions/version-fetcher/get-latest-redpanda-version.js');
const { getPrereleaseFromAntora } = require('../cli-utils/antora-utils.js');

/**
 * Fetches and prints the latest Redpanda version and Docker repository.
 * @param {Object} options
 * @param {boolean} options.beta - Whether to prefer RC (beta) releases
 * @param {boolean} options.fromAntora - Whether to derive beta flag from antora.yml
 */
module.exports = async function getRedpandaVersion({ beta = false, fromAntora = false }) {
  const owner = 'redpanda-data';
  const repo = 'redpanda';

  // Determine whether to treat this as a beta (RC) release
  let useBeta = beta;
  if (fromAntora) {
    useBeta = getPrereleaseFromAntora();
  }

  // Load Octokit
  const { getGitHubToken } = require('../cli-utils/github-token');
  const { Octokit } = await import('@octokit/rest');
  const token = getGitHubToken();
  const octokit = token
    ? new Octokit({ auth: token })
    : new Octokit();

  // Fetch version data
  let data;
  try {
    data = await GetLatestRedpandaVersion(octokit, owner, repo);
  } catch (err) {
    console.error('Failed to fetch the latest Redpanda version:', err.message);
    process.exit(1);
  }

  if (!data) {
    console.error('No version data returned for Redpanda');
    process.exit(1);
  }

  // Determine the version string
  const stableVersion = data.latestRedpandaRelease.version;
  const rc = data.latestRcRelease;
  const version = useBeta && rc ? rc.version : stableVersion;

  // Determine the Docker repository
  const dockerRepo = (useBeta && rc) ? 'redpanda-unstable' : 'redpanda';

  // Output for downstream consumption
  console.log(`REDPANDA_VERSION=${version}`);
  console.log(`REDPANDA_DOCKER_REPO=${dockerRepo}`);
};
