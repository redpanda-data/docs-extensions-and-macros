'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

/**
 * Copies an Antora component fixture into a throwaway git repository and
 * commits it once. The docs link converter reads checkouts the way Antora
 * does, through the content aggregator, which wants a repository with a HEAD.
 *
 * @param {string} fixture - Directory holding antora.yml and modules/.
 * @param {Object} [options]
 * @param {Function} [options.edit] - Called with the copy's root before the
 *   commit, to vary the fixture (for example, another version).
 * @returns {string} The repository root.
 */
function makeAntoraCheckout (fixture, { edit } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${path.basename(fixture)}-`))
  fs.cpSync(fixture, root, { recursive: true })
  if (edit) edit(root)
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
      cwd: root,
      encoding: 'utf8',
    })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  git('init', '-q')
  git('add', '.')
  git('commit', '-q', '-m', 'fixture')
  return root
}

module.exports = { makeAntoraCheckout }
