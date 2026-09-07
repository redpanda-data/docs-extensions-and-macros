#!/usr/bin/env node

const GetLatestRedpandaVersion = require('../extensions/version-fetcher/get-latest-redpanda-version.js');
const { getPrereleaseFromAntora } = require('../cli-utils/antora-utils.js');
const { getGitHubToken } = require('../cli-utils/github-token');

/**
 * Fetches and prints the latest Redpanda version and Docker repository.
 * @param {Object} options
 * @param {boolean} options.beta - Whether to prefer RC (beta) releases
 * @param {boolean} options.fromAntora - Whether to derive beta flag from antora.yml
 */
module.exports = async function getRedpandaVersion({ beta = false, fromAntora = false }) {
  // streaming-enterprise, not the old public redpanda repo: the public repo
  // still answers API requests but froze at its 2026-08-20 state when the
  // source moved, so resolving "latest" from it silently pins to the last
  // pre-freeze release forever. streaming-enterprise is private, and
  // unauthenticated release listings 404 rather than fail loudly, so refuse
  // to guess without a token instead of quietly resolving nothing.
  const owner = 'redpanda-data';
  const repo = 'streaming-enterprise';

  if (!getGitHubToken()) {
    console.error(`❌ redpanda-data/${repo} is a private repository.`);
    console.error('   Set GH_TOKEN, REDPANDA_GITHUB_TOKEN, or GITHUB_TOKEN to a token with access.');
    process.exit(1);
  }

  // Determine whether to treat this as a beta (RC) release
  let useBeta = beta;
  if (fromAntora) {
    useBeta = getPrereleaseFromAntora();
  }

  // Use shared Octokit client
  const octokit = require('../cli-utils/octokit-client');

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

  if (!version) {
    console.error('Could not determine Redpanda version');
    process.exit(1);
  }

  // Determine the Docker repository
  const dockerRepo = (useBeta && rc) ? 'redpanda-unstable' : 'redpanda';

  // Output for downstream consumption
  console.log(`REDPANDA_VERSION=${version}`);
  console.log(`REDPANDA_DOCKER_REPO=${dockerRepo}`);
};
