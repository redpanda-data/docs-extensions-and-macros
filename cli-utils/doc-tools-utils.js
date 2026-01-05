'use strict'

const path = require('path')
const fs = require('fs')

/**
 * Searches upward from a starting directory to locate the repository root.
 *
 * Traverses parent directories from the specified start path, returning the first
 * directory containing either a `.git` folder or a `package.json` file.
 * Exits the process with an error if no such directory is found.
 *
 * @param {string} [start] - The directory to begin the search from. Defaults to cwd.
 * @returns {string} The absolute path to the repository root directory.
 */
function findRepoRoot (start = process.cwd()) {
  let dir = start
  while (dir !== path.parse(dir).root) {
    if (
      fs.existsSync(path.join(dir, '.git')) ||
      fs.existsSync(path.join(dir, 'package.json'))
    ) {
      return dir
    }
    dir = path.dirname(dir)
  }
  console.error('Error: Could not find repo root (no .git or package.json in any parent)')
  process.exit(1)
}

/**
 * Prints an error message to stderr and exits the process with a non-zero status.
 *
 * @param {string} msg - The error message to display before exiting.
 */
function fail (msg) {
  console.error(`Error: ${msg}`)
  process.exit(1)
}

/**
 * Common options for automation tasks
 */
const commonOptions = {
  dockerRepo: 'redpanda',
  consoleTag: 'latest',
  consoleDockerRepo: 'console'
}

module.exports = {
  findRepoRoot,
  fail,
  commonOptions
}
