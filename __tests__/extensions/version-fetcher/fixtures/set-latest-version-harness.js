'use strict';

// Test fixture for set-latest-version.test.js.
//
// The set-latest-version extension uses dynamic import() for @octokit/rest,
// @octokit/plugin-retry, and semver, which Jest cannot evaluate without
// --experimental-vm-modules. This harness runs the extension in a plain Node
// child process instead, mocking the version-fetcher modules via
// require.cache so no network requests are made.
//
// Usage: node set-latest-version-harness.js '<scenario JSON>'
// Prints a JSON result: { versionAttributes, latestAttributes, errors }

const path = require('path');

const scenario = JSON.parse(process.argv[2] || '{}');
const repoRoot = path.resolve(__dirname, '../../../..');
const extDir = path.join(repoRoot, 'extensions/version-fetcher');

function mock (modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

const defaults = {
  redpanda: {
    latestRedpandaRelease: { version: 'v26.2.1', commitHash: 'abc123' },
    latestRcRelease: { version: 'v26.3.1-rc1', commitHash: 'rc456' },
  },
  dockerTags: {
    console: { latestStableRelease: 'v3.2.5', latestBetaRelease: 'v3.3.0-beta.1' },
    'redpanda-operator': { latestStableRelease: 'v25.1.3', latestBetaRelease: null },
  },
  helmChart: { latestStableRelease: '5.10.1', latestBetaRelease: null },
  connect: '4.37.0',
  latestAttributes: {},
};
const config = { ...defaults, ...scenario };

mock(path.join(extDir, 'get-latest-redpanda-version.js'), async () => config.redpanda);
mock(path.join(extDir, 'fetch-latest-docker-tag.js'), async (namespace, repo) => config.dockerTags[repo] || null);
mock(path.join(extDir, 'get-latest-redpanda-helm-version-from-operator.js'), async () => config.helmChart);
mock(path.join(extDir, 'get-latest-connect.js'), async () => config.connect);
mock(path.join(repoRoot, 'cli-utils/github-token.js'), { getGitHubToken: () => 'fake-token' });

// Record what the extension actually requires, so a dead dependency cannot be
// reintroduced without a test noticing.
const Module = require('module');
const originalLoad = Module._load;
const requires = [];
Module._load = function (request, ...rest) {
  requires.push(request);
  return originalLoad.call(this, request, ...rest);
};

const errors = [];
const logger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: (message) => errors.push(String(message)),
};

const handlers = {};
const extensionContext = {
  getLogger: () => logger,
  on: (event, handler) => {
    handlers[event] = handler;
  },
};

require(path.join(extDir, 'set-latest-version.js')).register.call(extensionContext, { config: {} });

const versionEntry = { name: 'ROOT', version: '26.2', asciidoc: { attributes: { ...config.versionAttributes } } };
const component = {
  latestPrerelease: null,
  versions: [versionEntry],
  latest: { name: 'ROOT', version: '26.2', asciidoc: { attributes: { ...config.latestAttributes } } },
};
const contentCatalog = { getComponents: async () => [component] };

(async () => {
  await handlers.contentClassified({ contentCatalog });
  process.stdout.write(JSON.stringify({
    versionAttributes: versionEntry.asciidoc.attributes,
    latestAttributes: component.latest.asciidoc.attributes,
    errors,
    requires,
  }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
