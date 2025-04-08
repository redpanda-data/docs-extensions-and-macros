#!/usr/bin/env node

const GetLatestRedpandaVersion = require('../extensions/version-fetcher/get-latest-redpanda-version.js');
const yaml = require('js-yaml');
const fs = require('fs');

const owner = 'redpanda-data';
const repo = 'redpanda';

// Parse command-line arguments
const args = process.argv.slice(2);
const showHelp = args.includes('--help') || args.includes('-h');
const betaFlag = args.includes('--beta');
const useAntora = args.includes('--from-antora');
let beta = false;

if (useAntora) {
  beta = getPrereleaseFromAntora(); // true or false from antora.yml
} else if (betaFlag) {
  beta = true;
}

if (showHelp) {
  console.log(`
Usage: doc-tools get-redpanda-version [options]

Options:
  --beta            Prefer the latest beta (RC) version if available
  --from-antora     Use prerelease flag from antora.yml (if --beta not passed)
  --help            Show this help message
`);
  process.exit(0);
}


function getPrereleaseFromAntora() {
  try {
    const fileContents = fs.readFileSync('../../antora.yml', 'utf8');
    const antoraConfig = yaml.load(fileContents);
    return antoraConfig.prerelease === true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error("Error reading antora.yml file:", error);
    }
    return false;
  }
}

// Conditionally set DOCKER_REPO for subsequent test steps such as Docker Compose
let REDPANDA_DOCKER_REPO = beta ? 'redpanda-unstable' : 'redpanda';

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

    const latestRedpandaReleaseVersion = beta
      ? (LatestRedpandaVersion.latestRcRelease?.version || LatestRedpandaVersion.latestRedpandaRelease.version)
      : LatestRedpandaVersion.latestRedpandaRelease.version;

    // If no RC exists, use the stable docker repo
    if (!LatestRedpandaVersion.latestRcRelease) {
      REDPANDA_DOCKER_REPO = 'redpanda';
    }

    // Output version and Docker repo for Doc Detective to pick up
    console.log(`REDPANDA_VERSION=${latestRedpandaReleaseVersion}`);
    console.log(`REDPANDA_DOCKER_REPO=${REDPANDA_DOCKER_REPO}`);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
