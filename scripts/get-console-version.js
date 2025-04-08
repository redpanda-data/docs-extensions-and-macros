#!/usr/bin/env node

const GetLatestConsoleVersion = require('../extensions/version-fetcher/get-latest-console-version.js');
const yaml = require('js-yaml');
const fs = require('fs');

const owner = 'redpanda-data';
const repo = 'console';
const CONSOLE_DOCKER_REPO = 'console';

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
Usage: doc-tools get-console-version [options]

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
      GetLatestConsoleVersion(github, owner, repo),
    ]);

    const LatestConsoleVersion = results[0].status === 'fulfilled' ? results[0].value : null;
    if (!LatestConsoleVersion) {
      throw new Error('Failed to fetch the latest Console version');
    }

    const latestConsoleReleaseVersion = beta
      ? (LatestConsoleVersion.latestBetaRelease || LatestConsoleVersion.latestStableRelease)
      : LatestConsoleVersion.latestStableRelease;

    console.log(`CONSOLE_VERSION=${latestConsoleReleaseVersion}`);
    console.log(`CONSOLE_DOCKER_REPO=${CONSOLE_DOCKER_REPO}`);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
