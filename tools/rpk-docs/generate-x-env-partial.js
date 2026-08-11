'use strict'

/**
 * Generates the rpk env vars partial (the `-X` option -> RPK_* environment
 * variable mapping table) from rpk itself, so the table cannot drift from
 * the CLI.
 *
 * Data source, in order of preference:
 * 1. The `x_options` array in `rpk --print-tree` JSON (added in
 *    redpanda#31520): structured, versioned with the release, and carries
 *    descriptions.
 * 2. `rpk -X list` text output, for rpk versions that predate x_options.
 *
 * The partial is included by both reference:rpk/rpk-x-options.adoc and
 * reference:environment-variables.adoc in the docs repo. Hidden -X options
 * (for example cloud_environment, whose values are deliberately
 * undocumented) appear in neither source, so they are excluded
 * automatically.
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

// A healthy rpk exposes ~30 -X options. Refuse to overwrite the partial
// with a suspiciously small table (for example, if -X list output ever
// changes format and only partially parses).
const MIN_OPTIONS = 20

const GENERATED_BANNER = `// tag::generated[]
// Generated from rpk's own -X option data. Do not edit manually:
// regenerate with doc-tools generate rpk-docs (which rewrites this
// file alongside the rpk command pages) or, for a targeted refresh,
// doc-tools generate rpk-env-partial.
`

/**
 * Extract -X options from `rpk --print-tree` JSON.
 * @param {string} output - Raw stdout from `rpk --print-tree`
 * @returns {Array<{name: string, env: string}>|null} options in display
 *   order, or null when the tree has no x_options (rpk predates
 *   redpanda#31520). The env name comes from rpk itself when present
 *   (the tree's env field is produced by the same derivation rpk reads).
 */
function xOptionsFromTree (output) {
  let tree
  try {
    tree = JSON.parse(output)
  } catch {
    return null
  }
  if (!Array.isArray(tree.x_options) || tree.x_options.length === 0) return null
  return tree.x_options.map(o => ({ name: o.name, env: o.env || keyToEnvVar(o.name) }))
}

/**
 * Parse `rpk -X list` output into option keys (fallback for rpk versions
 * whose --print-tree has no x_options).
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
 * Convert an -X option key to its section anchor on the rpk-x-options page.
 * The docs repo's AsciiDoc ID convention turns dots into hyphens but keeps
 * underscores (tls.insecure_skip_verify -> tls-insecure_skip_verify),
 * verified against the rendered page IDs. The previous hand-written table
 * hyphenated underscores too, which left 12 of its 31 in-page links dead.
 * @param {string} key
 * @returns {string}
 */
function keyToAnchor (key) {
  return key.replace(/\./g, '-')
}

/**
 * Render the partial's AsciiDoc content.
 * @param {Array<{name: string, env: string}>} options - -X options
 * @returns {string}
 */
function renderPartial (options) {
  const rows = options.map(({ name, env }) => {
    const xrefTarget = `xref:reference:rpk/rpk-x-options.adoc#${keyToAnchor(name)}[${name}]`
    return `|${xrefTarget} |${env}`
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
 * Run an rpk invocation from a Go source checkout.
 * @param {string} sourcePath - Path to src/go/rpk in a redpanda checkout
 * @param {Array<string>} args - rpk arguments
 * @returns {string} Raw stdout
 */
function runRpkFromSource (sourcePath, args) {
  const result = spawnSync('go', ['run', 'cmd/rpk/main.go', ...args], {
    cwd: sourcePath,
    encoding: 'utf8',
    timeout: 300000, // includes build time
    maxBuffer: 50 * 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error(`Failed to run rpk ${args.join(' ')} from source: ${result.stderr}`)
  }
  return result.stdout
}

/**
 * Run an rpk invocation with an existing binary.
 * @param {string} rpkBin - Path to the rpk binary
 * @param {Array<string>} args - rpk arguments
 * @returns {string} Raw stdout
 */
function runRpkBinary (rpkBin, args) {
  const result = spawnSync(rpkBin, args, {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 50 * 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error(`Failed to run ${rpkBin} ${args.join(' ')}: ${result.stderr}`)
  }
  return result.stdout
}

/**
 * Generate the partial and write it to disk.
 * @param {Object} options
 * @param {string} [options.ref] - Git ref of redpanda to build rpk from
 * @param {string} [options.fromSource] - Local src/go/rpk path (skips clone)
 * @param {string} [options.rpkBin] - Existing rpk binary (skips build)
 * @param {string} [options.fromJson] - Versioned tree snapshot from docs-data
 *   (skips clone and build; the snapshot must carry x_options)
 * @param {string} options.output - Path to write the partial to
 * @returns {{keyCount: number, output: string, source: string}}
 */
function handleXEnvPartialGeneration (options) {
  const { ref, fromSource, rpkBin, fromJson, output } = options
  if (!output) throw new Error('Missing required --output path')

  let xopts
  let source
  if (fromJson) {
    // Snapshots saved by the rpk-docs handler wrap the tree in raw_tree/tree;
    // accept a bare tree too. There is no rpk to run in this mode, so a
    // snapshot from before x_options existed (redpanda#31520) cannot be used.
    const j = JSON.parse(fs.readFileSync(fromJson, 'utf8'))
    for (const candidate of [j.raw_tree, j.tree, j]) {
      if (!candidate) continue
      xopts = xOptionsFromTree(JSON.stringify(candidate))
      if (xopts) break
    }
    if (!xopts) {
      throw new Error(
        `${fromJson} has no x_options; the snapshot predates redpanda#31520. ` +
        'Regenerate with --ref/--from-source/--rpk-bin instead.'
      )
    }
    source = `snapshot ${path.basename(fromJson)}`
  } else {
    let run
    if (rpkBin) {
      run = args => runRpkBinary(rpkBin, args)
    } else {
      const { prepareSourceFromRef } = require('./rpk-docs-handler.js')
      const sourcePath = prepareSourceFromRef(ref || 'dev', fromSource || null)
      run = args => runRpkFromSource(sourcePath, args)
    }

    // Preferred: structured x_options from the command tree JSON.
    xopts = xOptionsFromTree(run(['--print-tree']))
    source = 'print-tree x_options'
    if (!xopts) {
      // Fallback for rpk versions that predate x_options in --print-tree.
      // The env name is derived locally with the documented mapping rule.
      xopts = parseXList(run(['-X', 'list'])).map(name => ({ name, env: keyToEnvVar(name) }))
      source = '-X list (fallback)'
    }
  }

  if (xopts.length < MIN_OPTIONS) {
    throw new Error(
      `Parsed only ${xopts.length} -X options from ${source} (expected at least ${MIN_OPTIONS}); ` +
      'refusing to write a suspiciously small partial. The output format may have changed.'
    )
  }

  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, renderPartial(xopts))
  return { keyCount: xopts.length, output, source }
}

module.exports = {
  xOptionsFromTree,
  parseXList,
  keyToEnvVar,
  keyToAnchor,
  renderPartial,
  handleXEnvPartialGeneration
}
