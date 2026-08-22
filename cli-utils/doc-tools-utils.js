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
 * Returns the canonical path with symlinks resolved, or the input unchanged when
 * the path cannot be resolved (for example, it does not exist).
 *
 * @param {string} target - The path to canonicalize.
 * @returns {string} The canonical path, or `target` if it cannot be resolved.
 */
function realPathOrSelf (target) {
  try {
    return fs.realpathSync(target)
  } catch (err) {
    return target
  }
}

/**
 * Resolves a caller-supplied path against the repository root and refuses any
 * path that escapes it.
 *
 * Options such as `--template` and `--output` are resolved with
 * `path.resolve(repoRoot, value)`, which silently keeps an absolute path as-is
 * and lets `../` climb out of the repository. Both are reachable from the MCP
 * server, where the value comes from an agent rather than from the person at the
 * keyboard, so a read option turns into a file-disclosure primitive and a write
 * option into a write-anywhere primitive. Use this helper for every path option
 * that names a file the CLI then reads or writes.
 *
 * Symlinks are resolved on the deepest existing part of the target, so a symlink
 * inside the repository cannot be used to point outside it. The part that does
 * not exist yet (a `--output` file that is about to be created) is checked
 * lexically, after `path.resolve` has already collapsed any `..` segments.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {string} userPath - The caller-supplied path, absolute or relative to the repo root.
 * @param {string} [label] - Human-readable name of the option, used in the error message.
 * @returns {string} The absolute, contained path.
 * @throws {Error} If the resolved path is outside the repository root.
 */
function resolveInsideRepo (repoRoot, userPath, label = 'path') {
  const resolved = path.resolve(repoRoot, userPath)
  const root = realPathOrSelf(repoRoot)
  let existing = resolved
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    existing = path.dirname(existing)
  }
  const real = path.join(realPathOrSelf(existing), path.relative(existing, resolved))
  const relative = path.relative(root, real)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the repository (${repoRoot}): ${userPath}`)
  }
  return resolved
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
  resolveInsideRepo,
  fail,
  commonOptions
}
