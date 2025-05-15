const https = require('https');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');

/**
 * Retrieves the current Self-Managed documentation version from the remote antora.yml file.
 *
 * @returns {Promise<string>} Resolves with the version string (e.g., "25.1").
 *
 * @throws {Error} If the antora.yml file cannot be fetched, parsed, or if the version field is missing.
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
 * Determines the appropriate documentation branch for a given operator tag based on the remote Antora version.
 *
 * Normalizes the input tag, extracts the major.minor version, and applies version-specific logic to select the correct branch. Verifies that the chosen branch exists in the remote repository.
 *
 * @param {string} operatorTag - The operator tag to evaluate (e.g., "operator/v25.1.2" or "v25.1.2").
 * @returns {Promise<string>} The name of the documentation branch to use.
 *
 * @throws {Error} If the tag cannot be parsed or if the determined branch does not exist in the remote repository.
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
