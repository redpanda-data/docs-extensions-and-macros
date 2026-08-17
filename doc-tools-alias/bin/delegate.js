'use strict'

/**
 * Delegates a bin invocation to the same-named bin of
 * @redpanda-data/docs-extensions-and-macros, which this package depends on.
 *
 * This package exists to hold the unscoped `doc-tools` name officially:
 * `npx doc-tools ...` resolves package names against the public registry, so
 * an unclaimed name matching our bin is a dependency-confusion vector (the
 * sibling bin name `doc-tools-mcp` was squatted by a third party in July
 * 2026). Claiming the name with a real passthrough both closes that vector
 * and makes `npx doc-tools ...` work from machines that do not have the
 * scoped package installed.
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const PARENT = '@redpanda-data/docs-extensions-and-macros'

// The parent's `exports` map does not expose ./package.json or its bin
// files, so the package directory is located by walking the node_modules
// resolution paths instead of require.resolve on a subpath.
function findParentDir () {
  for (const base of require.resolve.paths(PARENT)) {
    const candidate = path.join(base, PARENT)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
  }
  throw new Error(`Could not locate ${PARENT}. Reinstall the doc-tools package.`)
}

function delegate (binName) {
  const parentDir = findParentDir()
  const binRelPath = JSON.parse(fs.readFileSync(path.join(parentDir, 'package.json'), 'utf8')).bin[binName]
  if (!binRelPath) {
    console.error(`Error: ${PARENT} no longer exposes a "${binName}" bin.`)
    process.exit(1)
  }
  const result = spawnSync(
    process.execPath,
    [path.join(parentDir, binRelPath), ...process.argv.slice(2)],
    { stdio: 'inherit' }
  )
  process.exit(result.status === null ? 1 : result.status)
}

module.exports = { delegate }
