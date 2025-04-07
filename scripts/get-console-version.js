#!/usr/bin/env node

const GetLatestConsoleVersion = require('../extensions/version-fetcher/get-latest-console-version.js');
const yaml = require('js-yaml');
const fs = require('fs');

const owner = 'redpanda-data';
const repo = 'console';
const CONSOLE_DOCKER_REPO = 'console';

// Parse command-line arguments
const args = process.argv.slice(2);
console.log(args)
const betaFlag = args.includes('--beta');

function getPrereleaseFromAntora() {
  try {
    const fileContents = fs.readFileSync('../../antora.yml', 'utf8');
    const antoraConfig = yaml.load(fileContents);
    return antoraConfig.prerelease === true;
  } catch (error) {
    // Only log if file was expected but not found
    if (error.code !== 'ENOENT') {
      console.error("Error reading antora.yml file:", error);
    }
    return undefined; // So we can fallback to --beta later
  }
}

// Try antora.yml, fallback to CLI flag
const antoraPrerelease = getPrereleaseFromAntora();
const beta = typeof antoraPrerelease === 'boolean' ? antoraPrerelease : betaFlag;
console.log(beta)

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
