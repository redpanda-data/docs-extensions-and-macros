#!/usr/bin/env node
'use strict'

/**
 * Overwrite cluster/broker scope in an already-extracted --enhanced-output
 * file with rp_util's runtime-introspected data, in place.
 *
 * Called from the Makefile's `build` target, after property_extractor.py's
 * Tree-sitter extraction and before generate-docs renders the result. Topic
 * properties (rp_util has no equivalent) and anything rp_util doesn't cover
 * pass through untouched -- see rp_util_merge.py.
 *
 * Failure behavior depends on what kind of ref is being built:
 *
 *   Branch refs (dev, feature branches): never fails the build. If rp_util's
 *   schema can't be obtained (no published release for this ref, no GitHub
 *   token, no Docker/Bazel available to build from source) or the merge
 *   itself errors, this logs a warning and leaves the Tree-sitter-only
 *   extraction as the enhanced file, exactly as it already was before this
 *   step ran. In-progress content tolerates the degraded data; it gets
 *   regenerated constantly.
 *
 *   Release tags (v26.3.0, v26.3.1-rc1, ...): fails the build. A release run
 *   is the one that publishes the property reference, and shipping the
 *   Tree-sitter-only extraction there is not a degradation readers can see
 *   past: post streaming-enterprise#63, it silently drops enum_set
 *   properties (http_authentication) and misparses others behind a green
 *   job. The fix is to publish the schema first (the publish-rp-util-schema
 *   workflow, which also runs on a schedule) and re-run; --skip-rp-util /
 *   SKIP_RP_UTIL=1 remains the explicit opt-out.
 *
 * Usage:
 *   node merge-rp-util.js --tag <ref> --enhanced <path> [--overrides <path>] [--output <path>]
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { getRpUtilSchema, SCHEMA_FLAGS } = require('./rp-util-fetch')
const bigIntJson = require('../../cli-utils/big-int-json')

function getArg(args, flag) {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

// A ref this pipeline treats as a release build: vX.Y.Z, with or without an
// -rcN suffix (RC tags feed the docs beta branch, which publishes too). Same
// release/RC shape streaming-enterprise's own dispatch-docs-updates.yml keys
// on. Everything else (dev, feature branches, bare SHAs) is in-progress
// content where a degraded merge is tolerable.
const RELEASE_TAG_RX = /^v?\d+\.\d+\.\d+(-rc\d+)?$/

/**
 * Handle a step of the rp_util merge being unavailable: fatal for a release
 * tag (see the header comment), a warning plus the Tree-sitter fallback for
 * everything else.
 */
function handleMergeUnavailable(tag, enhanced, reason) {
  if (RELEASE_TAG_RX.test(tag)) {
    // Print the canonical v-prefixed tag in the remediation command:
    // streaming-enterprise tags (and therefore schema release names) are
    // always v-prefixed, so telling the operator to publish a v-less name
    // would send them to a workflow run that can never help.
    const releaseTag = tag.startsWith('v') ? tag : `v${tag}`
    console.error(`Error: ${reason}`)
    console.error(
      `Refusing to publish Tree-sitter-only property data for release ${tag}: ` +
      'it drops or misparses enum_set properties. Publish the rp_util schema ' +
      `first (gh workflow run publish-rp-util-schema.yaml -f tag=${releaseTag}, or wait ` +
      'for its scheduled run) and retry, or pass --skip-rp-util to override.'
    )
    process.exitCode = 1
    return
  }
  console.warn(`Warning: ${reason}`)
  console.warn('Skipping rp_util merge -- keeping the Tree-sitter-only extraction for cluster/broker scope.')
  markRpUtilMergeUnavailable(enhanced)
}

// rp_util covers every cluster/broker-scope property (see this file's own
// header comment), so when its merge is skipped or fails, any cluster/
// broker property still missing gets_restored isn't "no annotation exists"
// (the pre-existing, legitimate case property.hbs already renders as an
// absent row) -- it's "we don't know, because the merge that would have
// told us didn't run". Mark those explicitly so the template can render
// that as a visible "Unknown" state instead of silently rendering nothing,
// which previously made a flaky rp_util fetch indistinguishable from a
// real upstream change in the generated docs.
const RP_UTIL_COVERED_SCOPES = new Set(['cluster', 'broker'])

function markRpUtilMergeUnavailable(enhancedPath) {
  let data
  try {
    data = bigIntJson.parse(fs.readFileSync(enhancedPath, 'utf8'))
  } catch (err) {
    console.warn(`Warning: could not mark rp_util merge as unavailable in ${enhancedPath}: ${err.message}`)
    return
  }
  const properties = data.properties || {}
  let marked = 0
  for (const prop of Object.values(properties)) {
    if (!prop || !RP_UTIL_COVERED_SCOPES.has(prop.config_scope)) continue
    if (prop.gets_restored !== undefined) continue
    prop.rp_util_merge_status = 'unavailable'
    marked++
  }
  if (marked === 0) return
  try {
    fs.writeFileSync(enhancedPath, bigIntJson.stringify(data))
  } catch (err) {
    console.warn(`Warning: could not write rp_util-unavailable marker to ${enhancedPath}: ${err.message}`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const tag = getArg(args, '--tag')
  const enhanced = getArg(args, '--enhanced')
  const overrides = getArg(args, '--overrides')
  const output = getArg(args, '--output') || enhanced
  const sourcePath = getArg(args, '--source-path')

  if (!tag || !enhanced) {
    console.error(
      'Usage: node merge-rp-util.js --tag <ref> --enhanced <path> ' +
      '[--overrides <path>] [--output <path>] [--source-path <dir>]'
    )
    process.exit(1)
  }

  console.log(`Fetching rp_util schema for ${tag}...`)
  let schemas
  try {
    // --source-path builds from an existing local streaming-enterprise
    // checkout instead of fetching a published release or cloning+building
    // fresh -- same option rp-util-fetch.js itself exposes, useful for
    // local iteration against a branch that has no published schema yet.
    schemas = await getRpUtilSchema(tag, sourcePath ? { sourcePath } : undefined)
  } catch (err) {
    handleMergeUnavailable(tag, enhanced, `could not get rp_util schema for ${tag}: ${err.message}`)
    return
  }

  const schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-util-schemas-'))
  try {
    let anySchema = false
    for (const { key } of SCHEMA_FLAGS) {
      if (schemas[key]) {
        fs.writeFileSync(path.join(schemaDir, `${key}.json`), bigIntJson.stringify(schemas[key]))
        anySchema = true
      }
    }
    if (!anySchema) {
      handleMergeUnavailable(tag, enhanced, `rp_util schema for ${tag} came back empty.`)
      return
    }

    const venvPython = path.join(__dirname, 'tmp', 'redpanda-property-extractor-venv', 'bin', 'python')
    const pythonBin = fs.existsSync(venvPython) ? venvPython : 'python3'

    // Write to a temp path and only rename over the real output on success.
    // output frequently equals enhanced (an in-place update), so a partial
    // write from a mid-json.dump failure must never be able to leave that
    // file truncated -- generate-docs reads it right after this returns.
    const tempOutput = `${output}.rp-util-merge-tmp`
    const mergeArgs = [
      'rp_util_merge.py',
      '--enhanced', enhanced,
      '--rp-util-dir', schemaDir,
      '--output', tempOutput
    ]
    if (overrides && fs.existsSync(overrides)) {
      mergeArgs.push('--overrides', overrides)
    }

    console.log('Merging rp_util schema into extracted properties...')
    const result = spawnSync(pythonBin, mergeArgs, { cwd: __dirname, stdio: 'inherit' })
    if (result.error || result.status !== 0) {
      fs.rmSync(tempOutput, { force: true })
      handleMergeUnavailable(
        tag,
        enhanced,
        `rp_util merge failed (${result.error ? result.error.message : `exit ${result.status}`}).`
      )
    } else {
      fs.renameSync(tempOutput, output)
    }
  } finally {
    fs.rmSync(schemaDir, { recursive: true, force: true })
  }
}

module.exports = { main, markRpUtilMergeUnavailable }

if (require.main === module) {
  main()
}
