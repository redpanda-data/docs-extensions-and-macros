'use strict'

/**
 * Generates the rpk env vars partial (the `-X` option -> RPK_* environment
 * variable mapping table) from rpk's own `-X list` output, so the table
 * cannot drift from the CLI.
 *
 * The partial is included by both reference:rpk/rpk-x-options.adoc and
 * reference:environment-variables.adoc in the docs repo. Hidden -X options
 * (for example cloud_environment, whose values are deliberately
 * undocumented) never appear in `-X list` output, so they are excluded
 * automatically.
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const GENERATED_BANNER = `// tag::generated[]
// This file is generated from rpk's -X list output by
// doc-tools generate rpk-env-partial. Do not edit it manually:
// rerun the generator (the update-rpk-docs workflow does this on
// each rpk docs run).
`

/**
 * Parse `rpk -X list` output into option keys.
 * Each line has the form `key=value-hint`; keys contain lowercase
 * letters, digits, dots, and underscores.
 * @param {string} output - Raw stdout from `rpk -X list`
 * @returns {Array<string>} option keys in CLI order
 */
function parseXList (output) {
  const keys = []
  for (const line of output.split('\n')) {
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    if (/^[a-z0-9._]+$/.test(key)) keys.push(key)
  }
  return keys
}

/**
 * Convert an -X option key to its RPK_* environment variable name:
 * prefix RPK_, uppercase, dots -> underscores.
 * @param {string} key
 * @returns {string}
 */
function keyToEnvVar (key) {
  return 'RPK_' + key.toUpperCase().replace(/\./g, '_')
}

/**
 * Convert an -X option key to its section anchor on the rpk-x-options page
 * (AsciiDoc section IDs there turn both dots and underscores into hyphens).
 * @param {string} key
 * @returns {string}
 */
function keyToAnchor (key) {
  return key.replace(/[._]/g, '-')
}

/**
 * Render the partial's AsciiDoc content.
 * @param {Array<string>} keys - -X option keys
 * @returns {string}
 */
function renderPartial (keys) {
  const rows = keys.map(key => {
    const xrefTarget = `xref:reference:rpk/rpk-x-options.adoc#${keyToAnchor(key)}[${key}]`
    return `|${xrefTarget} |${keyToEnvVar(key)}`
  })
  return `${GENERATED_BANNER}
Every \`-X\` option has a corresponding \`RPK_*\` environment variable. Convert by prefixing with \`RPK_\` and replacing dots with underscores:

[cols="1m,1m"]
|===
|\`-X\` Option |Environment Variable

${rows.join('\n')}
|===
// end::generated[]
`
}

/**
 * Run `rpk -X list` from a Go source checkout.
 * @param {string} sourcePath - Path to src/go/rpk in a redpanda checkout
 * @returns {string} Raw stdout
 */
function runXListFromSource (sourcePath) {
  const result = spawnSync('go', ['run', 'cmd/rpk/main.go', '-X', 'list'], {
    cwd: sourcePath,
    encoding: 'utf8',
    timeout: 300000, // includes build time
    maxBuffer: 10 * 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error(`Failed to run rpk -X list from source: ${result.stderr}`)
  }
  return result.stdout
}

/**
 * Generate the partial and write it to disk.
 * @param {Object} options
 * @param {string} [options.ref] - Git ref of redpanda to build rpk from
 * @param {string} [options.fromSource] - Local src/go/rpk path (skips clone)
 * @param {string} [options.rpkBin] - Existing rpk binary (skips build)
 * @param {string} options.output - Path to write the partial to
 * @returns {{keyCount: number, output: string}}
 */
function handleXEnvPartialGeneration (options) {
  const { ref, fromSource, rpkBin, output } = options
  if (!output) throw new Error('Missing required --output path')

  let stdout
  if (rpkBin) {
    const result = spawnSync(rpkBin, ['-X', 'list'], { encoding: 'utf8', timeout: 60000 })
    if (result.status !== 0) {
      throw new Error(`Failed to run ${rpkBin} -X list: ${result.stderr}`)
    }
    stdout = result.stdout
  } else {
    const { prepareSourceFromRef } = require('./rpk-docs-handler.js')
    const sourcePath = prepareSourceFromRef(ref || 'dev', fromSource || null)
    stdout = runXListFromSource(sourcePath)
  }

  const keys = parseXList(stdout)
  if (keys.length === 0) {
    throw new Error('rpk -X list produced no parsable options; refusing to write an empty partial')
  }

  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, renderPartial(keys))
  return { keyCount: keys.length, output }
}

module.exports = {
  parseXList,
  keyToEnvVar,
  keyToAnchor,
  renderPartial,
  handleXEnvPartialGeneration
}
