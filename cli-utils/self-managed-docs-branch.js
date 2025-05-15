const https = require('https');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');

/**
 * Fetches the latest documented Self-Managed version from the remote docs repo's antora.yml
 * @returns {Promise<string>} example: "25.1"
 */
function fetchRemoteAntoraVersion() {
  const url = 'https://raw.githubusercontent.com/redpanda-data/docs/main/antora.yml'
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to fetch antora.yml: ${res.statusCode}`))
      }
      let body = ''
      res.on('data', chunk => (body += chunk))
      res.on('end', () => {
        try {
          const cfg = yaml.load(body)
          if (typeof cfg.version == null) {
            throw new Error('version field missing')
          }
          const version = String(cfg.version).trim()
          resolve(version)
        } catch (err) {
          reject(err)
        }
      })
    }).on('error', reject)
  })
}

/**
 * Given an operator tag (such as "operator/v25.1.2" or "v25.1.2") and
 * the remote Antora version (such as "25.1"), decide which docs branch to use.
 *
 * Throws if the chosen branch does not exist on origin.
 */
async function determineDocsBranch(operatorTag) {
  // Strip any "operator/" prefix
  const TAG = operatorTag.replace(/^(?:operator|release)\//, '')
  // Pull in the remote Antora version
  const ANTORA = await fetchRemoteAntoraVersion()
  // Extract v<major>.<minor>
  const filtered = TAG.match(/^v([0-9]+\.[0-9]+)/)
    ? `v${RegExp.$1}`
    : null

  if (!filtered) {
    throw new Error(`Could not parse major.minor from ${TAG}`)
  }

  let branch
  if (filtered === 'v2.4') {
    if (ANTORA === '25.1') {
      branch = 'main'
    } else {
      branch = 'v/24.3'
    }
  } else if (filtered === `v${ANTORA}`) {
    branch = 'main'
  } else {
    branch = `v/${filtered.slice(1)}`
  }

  // Verify branch exists
  const repo = 'https://github.com/redpanda-data/docs.git'
  const ref  = `refs/heads/${branch}`
  const ok = spawnSync('git', ['ls-remote', '--exit-code', '--heads', repo, ref], {
    stdio: 'ignore'
  }).status === 0

  if (!ok) {
    throw new Error(`Docs branch ${branch} not found in ${repo}`)
  }

  return branch
}

module.exports = {
  fetchRemoteAntoraVersion,
  determineDocsBranch
}
