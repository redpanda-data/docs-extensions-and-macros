// Preloaded with `node -r` by update-connect-version.test.js: replaces the
// GitHub fetcher so the test needs no network. FAKE_CONNECT_TAG=null makes it
// return null, as the real fetcher does when the API call fails. It also
// replaces the Octokit client, which is ESM-only and cannot be required on
// Node 18, so the test runs on every Node version CI covers.
const path = require('path')
const root = path.join(__dirname, '..', '..', '..')
const stub = (mod, exports) => {
  const id = require.resolve(path.join(root, mod))
  require.cache[id] = { id, filename: id, loaded: true, exports }
}
stub(path.join('cli-utils', 'octokit-client'), { stub: true })
stub(path.join('extensions', 'version-fetcher', 'get-latest-connect'), async (github, owner, repo) => {
  if (!github || owner !== 'redpanda-data' || repo !== 'connect') throw new Error('fetcher called without its client, owner, and repo')
  return process.env.FAKE_CONNECT_TAG === 'null' ? null : process.env.FAKE_CONNECT_TAG
})
