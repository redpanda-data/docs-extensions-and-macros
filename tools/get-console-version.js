#!/usr/bin/env node

const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const GetLatestConsoleVersion = require('../extensions/version-fetcher/get-latest-console-version.js');
const { getPrereleaseFromAntora } = require('../utils/beta-from-antora.js');

/**
 * Fetches and prints the latest Console version and Docker repo.
 * @param {Object} options
 * @param {boolean} options.beta - Return beta version if available
 * @param {boolean} options.fromAntora - Derive beta flag from antora.yml
 */
module.exports = async function getConsoleVersion({ beta = false, fromAntora = false }) {
  const owner = 'redpanda-data';
  const repo = 'console';
  const CONSOLE_DOCKER_REPO = repo;

  // Determine whether to use beta based on antora.yml or flag
  let useBeta = beta;
  if (fromAntora) {
    useBeta = getPrereleaseFromAntora();
  }

  // Initialize GitHub client
  const { Octokit } = await import('@octokit/rest');
  const octokit = process.env.REDPANDA_GITHUB_TOKEN
    ? new Octokit({ auth: process.env.REDPANDA_GITHUB_TOKEN })
    : new Octokit();

  // Fetch latest release info
  let data;
  try {
    data = await GetLatestConsoleVersion(octokit, owner, repo);
  } catch (err) {
    console.error('Failed to fetch Console version:', err.message);
    process.exit(1);
  }

  if (!data) {
    console.error('No version data returned for Console');
    process.exit(1);
  }

  // Select the version
  const version = useBeta
    ? (data.latestBetaRelease || data.latestStableRelease)
    : data.latestStableRelease;

  console.log(`CONSOLE_VERSION=${version}`);
  console.log(`CONSOLE_DOCKER_REPO=${CONSOLE_DOCKER_REPO}`);
};
