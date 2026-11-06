// Preloaded with `node -r` by update-connect-version.test.js: replaces the
// GitHub fetcher so the test needs no network. FAKE_CONNECT_TAG=null makes it
// return null, as the real fetcher does when the API call fails.
const path = require('path')
const target = require.resolve(path.join(__dirname, '..', '..', '..', 'extensions', 'version-fetcher', 'get-latest-connect'))
require.cache[target] = {
  id: target,
  filename: target,
  loaded: true,
  exports: async (github, owner, repo) => {
    if (!github || owner !== 'redpanda-data' || repo !== 'connect') throw new Error('fetcher called without its client, owner, and repo')
    return process.env.FAKE_CONNECT_TAG === 'null' ? null : process.env.FAKE_CONNECT_TAG
  },
}
