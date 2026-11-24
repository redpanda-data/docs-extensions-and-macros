#!/usr/bin/env node

const GetLatestConnectTag = require('../extensions/version-fetcher/get-latest-connect.js');

/**
 * Fetches and prints the latest Redpanda Connect version, without the leading
 * `v`, the same form `update-connect-version` writes to antora.yml.
 */
module.exports = async function getConnectVersion() {
  // Use shared Octokit client
  const octokit = require('../cli-utils/octokit-client');

  const tag = await GetLatestConnectTag(octokit, 'redpanda-data', 'connect');
  if (!tag) {
    console.error('Could not determine the latest Redpanda Connect version');
    process.exit(1);
  }

  console.log(String(tag).replace(/^v/, ''));
};
