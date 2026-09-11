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
const { getRpUtilSchema, schemaExpectation, fetchPublishedSchema, SCHEMA_FLAGS } = require('./rp-util-fetch')
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
// How long to wait for a schema that is being built right now, and how often
// to look. streaming-enterprise's dispatch-docs-updates.yml fires the schema
// publish and this generation from the same job, and the publish is a
// ~27-minute Bazel build per scope, so on a fresh release tag the schema
// reliably does not exist yet when we first ask. The docs runner has neither
// bazel nor docker, so the from-source fallback cannot cover the gap: without
// waiting, every RC and GA regeneration fails on a race it is guaranteed to
// lose. Overridable so a one-off backfill need not sit through it.
/**
 * Read a millisecond knob from the environment, or fall back. Number('') is 0
 * and Number('abc') is NaN, and a 0 or NaN poll interval turns the wait loop
 * into a busy-poll of the GitHub API for the whole budget. `allowZero` is for
 * the wait budget, where 0 is the documented way to disable waiting.
 */
function parseEnvMs(name, fallback, { allowZero = false } = {}) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (Number.isInteger(n) && (n > 0 || (allowZero && n === 0))) return n
  // Quoted by hand: this file is held to bigIntJson.stringify by a repo-wide
  // guard test, and a plain string needs no BigInt-aware serializer anyway.
  console.warn(`Warning: ${name}='${raw}' is not a ${allowZero ? 'non-negative' : 'positive'} integer; using ${fallback}.`)
  return fallback
}

const SCHEMA_WAIT_MS = parseEnvMs('RP_UTIL_SCHEMA_WAIT_MS', 45 * 60 * 1000, { allowZero: true })
const SCHEMA_POLL_MS = parseEnvMs('RP_UTIL_SCHEMA_POLL_MS', 60 * 1000)
const CLASSIFY_BACKOFF_MS = parseEnvMs('RP_UTIL_CLASSIFY_BACKOFF_MS', 5 * 1000)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Poll for a published schema release until it appears or the budget runs out.
 * @returns {Promise<object|null>} The schemas, or null if none appeared
 */
function isPermanentLookupError(err) {
  const s = Number(err && err.status)
  return s >= 400 && s < 500 && s !== 404 && s !== 429
}

/**
 * schemaExpectation() with a few retries. It is one GitHub contents call, and
 * a single flaky response used to leave the classification at 'unknown', which
 * skipped the wait entirely and dropped a release straight into the race this
 * module exists to avoid. Only exceptions are retried; a real classification,
 * including 'unknown' from the classifier itself, is returned as-is.
 */
async function classifyWithRetry(releaseTag, { attempts = 3, backoffMs = CLASSIFY_BACKOFF_MS, sleepFn = sleep } = {}) {
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      return await schemaExpectation(releaseTag)
    } catch (err) {
      lastErr = err
      console.warn(`Warning: could not classify ${releaseTag} (attempt ${i} of ${attempts}): ${err.message}`)
      if (i < attempts) await sleepFn(backoffMs * i)
    }
  }
  return { expectation: 'unknown', reason: `could not classify ${releaseTag} after ${attempts} attempts: ${lastErr.message}` }
}

async function waitForPublishedSchema(releaseTag, budgetMs, pollMs, now = Date.now) {
  const deadline = now() + budgetMs
  let attempt = 0
  for (;;) {
    attempt++
    let published = null
    try {
      published = await fetchPublishedSchema(releaseTag)
    } catch (err) {
      // A transient failure is not the same as "not published": log and
      // keep waiting. A 4xx other than 404 (which fetchPublishedSchema maps
      // to null) or 429 is permanent: a bad or under-scoped token will not
      // heal in 45 minutes, so surface it now instead of after the budget.
      if (isPermanentLookupError(err)) {
        throw new Error(`Cannot look up the rp_util schema for ${releaseTag}: ${err.message}`)
      }
      console.warn(`Warning: schema lookup for ${releaseTag} failed (attempt ${attempt}): ${err.message}`)
    }
    if (published) {
      console.log(`rp_util schema for ${releaseTag} is published (after ${attempt} check(s)).`)
      return published
    }
    const remaining = deadline - now()
    if (remaining <= 0) return null
    const nap = Math.min(pollMs, remaining)
    console.log(
      `Waiting for the rp_util schema for ${releaseTag} to be published ` +
      `(${Math.round(remaining / 1000)}s of budget left)...`
    )
    await sleep(nap)
  }
}

async function handleMergeUnavailable(tag, enhanced, reason, output = enhanced) {
  if (RELEASE_TAG_RX.test(tag)) {
    // Print the canonical v-prefixed tag in the remediation command:
    // streaming-enterprise tags (and therefore schema release names) are
    // always v-prefixed, so telling the operator to publish a v-less name
    // would send them to a workflow run that can never help.
    const releaseTag = tag.startsWith('v') ? tag : `v${tag}`

    // Not every release CAN have a schema, and the ones that cannot do not
    // need one. streaming-enterprise#63 added the broker-scope dump flags and
    // the enum_set_property conversions in the same change, so a tag without
    // the flags also has no enum_set properties for the Tree-sitter pass to
    // misparse. Failing those releases forever would block every regeneration
    // of a v26.2.x or older line on a schema that can never be published.
    // See schemaExpectation() for the evidence.
    const expectation = await classifyWithRetry(releaseTag)

    if (expectation.expectation === 'unavailable') {
      console.warn(`Warning: ${reason}`)
      console.warn(`No rp_util schema can exist for ${releaseTag}: ${expectation.reason}`)
      console.warn('Keeping the Tree-sitter-only extraction, which is accurate for this release.')
      markRpUtilMergeUnavailable(enhanced)
      // generate-docs reads --output right after this returns. When it is
      // not the same file as --enhanced, the degraded result has to land
      // there too, or the run exits 0 having left the output stale.
      if (output && output !== enhanced) fs.copyFileSync(enhanced, output)
      return
    }

    if (expectation.expectation === 'inconsistent') {
      console.error(`Error: ${expectation.reason}`)
      console.error(
        'This is the one combination that must never ship: neither the schema ' +
        'nor the Tree-sitter extraction can describe those properties. Backport ' +
        'the rp_util schema flags to this branch before regenerating.'
      )
      process.exitCode = 1
      return
    }

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
  // Cluster properties rp_util reports but the Tree-sitter pass never saw
  // have no existing entry to carry cloud metadata forward from, so the
  // merge needs its own CloudConfig to annotate them -- see rp_util_merge.py.
  // Honours CLOUD_SUPPORT=1 as well because that is how doc-tools passes the
  // request down to `make` in the first place.
  const cloudSupport = args.includes('--cloud-support') || process.env.CLOUD_SUPPORT === '1'

  if (!tag || !enhanced) {
    console.error(
      'Usage: node merge-rp-util.js --tag <ref> --enhanced <path> ' +
      '[--overrides <path>] [--output <path>] [--source-path <dir>] [--cloud-support]'
    )
    process.exit(1)
  }

  console.log(`Fetching rp_util schema for ${tag}...`)
  let schemas

  // On a release tag whose rp_util can dump every scope, the schema is either
  // already published or being built right now, so wait for it instead of
  // racing the publisher. A tag that can never have one skips the wait and
  // falls through to the classification in handleMergeUnavailable.
  if (!sourcePath && RELEASE_TAG_RX.test(tag) && SCHEMA_WAIT_MS > 0) {
    const releaseTag = tag.startsWith('v') ? tag : `v${tag}`
    const expectation = await classifyWithRetry(releaseTag)
    if (expectation.expectation === 'required') {
      let waited
      try {
        waited = await waitForPublishedSchema(releaseTag, SCHEMA_WAIT_MS, SCHEMA_POLL_MS)
      } catch (err) {
        // 'required' means degrading is not an option, so a permanent
        // lookup failure is the run's failure.
        console.error(`Error: ${err.message}`)
        process.exitCode = 1
        return
      }
      if (waited) {
        schemas = { ...waited, sourcePath: null }
      } else {
        console.warn(
          `Warning: no rp_util schema for ${releaseTag} after waiting ` +
          `${Math.round(SCHEMA_WAIT_MS / 60000)} minutes.`
        )
      }
    }
  }

  try {
    // --source-path builds from an existing local streaming-enterprise
    // checkout instead of fetching a published release or cloning+building
    // fresh -- same option rp-util-fetch.js itself exposes, useful for
    // local iteration against a branch that has no published schema yet.
    if (!schemas) {
      schemas = await getRpUtilSchema(tag, sourcePath ? { sourcePath } : undefined)
    }
  } catch (err) {
    await handleMergeUnavailable(tag, enhanced, `could not get rp_util schema for ${tag}: ${err.message}`, output)
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
      await handleMergeUnavailable(tag, enhanced, `rp_util schema for ${tag} came back empty.`, output)
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
    if (cloudSupport) {
      mergeArgs.push('--cloud-support')
    }

    console.log('Merging rp_util schema into extracted properties...')
    const result = spawnSync(pythonBin, mergeArgs, { cwd: __dirname, stdio: 'inherit' })
    if (result.error || result.status !== 0) {
      fs.rmSync(tempOutput, { force: true })
      await handleMergeUnavailable(
        tag,
        enhanced,
        `rp_util merge failed (${result.error ? result.error.message : `exit ${result.status}`}).`,
        output
      )
    } else {
      fs.renameSync(tempOutput, output)
    }
  } finally {
    fs.rmSync(schemaDir, { recursive: true, force: true })
  }
}

module.exports = {
  main,
  parseEnvMs,
  classifyWithRetry,
  isPermanentLookupError,
  markRpUtilMergeUnavailable,
  // exported for testing
  waitForPublishedSchema,
  handleMergeUnavailable
}

if (require.main === module) {
  main()
}
