#!/usr/bin/env node
'use strict'

/**
 * Regenerates the redpanda.iceberg.mode release data from Redpanda's source.
 *
 *   node tools/iceberg-mode/generate.js
 *
 * Reads, at every release tag of redpanda-data/streaming-enterprise (private):
 *
 *   src/v/model/model.cc                                the parser and formatter
 *   src/v/kafka/server/handlers/configs/config_utils.h  the cluster upgrade gate
 *   src/v/model/tests/iceberg_mode_test.cc              the test cases
 *
 * and writes two files:
 *
 *   extension-utils/iceberg-mode-releases.json
 *     Which grammar each release series accepts, keyed by a fingerprint of
 *     its parser source. extension-utils/iceberg-mode.js reads it at build
 *     time to validate a page's config against that page's release.
 *   __tests__/fixtures/iceberg-mode/upstream-vectors.js
 *     The upstream test cases, which the port's tests replay. docs-ui copies
 *     this file too.
 *
 * Which tags: every GA tag (vX.Y.Z) of each release series, or the series'
 * RC tags while it has no GA yet, so the docs beta for an unreleased series
 * is checked against the release candidate it documents. Series are walked
 * newest first and the walk stops at the first series whose newest tag has no
 * iceberg_mode parser, which is recorded as having none.
 *
 * Only what changes the grammar is recorded (the first tag of each distinct
 * parser), so a patch release that leaves the parser alone changes nothing
 * here and the drift job stays green.
 *
 * Needs a token that can read streaming-enterprise: GH_TOKEN or GITHUB_TOKEN,
 * falling back to `gh auth token`. The drift job
 * (.github/workflows/iceberg-mode-drift.yml) runs this and fails on any diff.
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const upstream = require('./upstream')

const REPO = 'redpanda-data/streaming-enterprise'
const MODEL_CC = 'src/v/model/model.cc'
const CONFIG_UTILS_H = 'src/v/kafka/server/handlers/configs/config_utils.h'
const TEST_CC = 'src/v/model/tests/iceberg_mode_test.cc'
const ROOT = path.resolve(__dirname, '..', '..')
const RELEASES_JSON = path.join(ROOT, 'extension-utils', 'iceberg-mode-releases.json')
const VECTORS_JS = path.join(ROOT, '__tests__', 'fixtures', 'iceberg-mode', 'upstream-vectors.js')
const TAG_RX = /^v(\d+)\.(\d+)\.(\d+)(?:-rc(\d+))?$/

function token () {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error(`no GitHub token: set GH_TOKEN to a token that can read ${REPO}`)
  }
}

async function api (pathname, auth) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.github.com/${pathname}`, {
      headers: { Authorization: `Bearer ${auth}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    })
    if (res.status === 404) return null
    if (res.ok) return { body: await res.json(), link: res.headers.get('link') || '' }
    if (attempt >= 3 || res.status < 500) {
      throw new Error(`GET ${pathname}: HTTP ${res.status} ${await res.text()}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
  }
}

async function listTags (auth) {
  const tags = []
  for (let page = 1; ; page++) {
    const res = await api(`repos/${REPO}/tags?per_page=100&page=${page}`, auth)
    if (!res) throw new Error(`${REPO} not found: the token cannot read it`)
    tags.push(...res.body.map((t) => ({ name: t.name, commit: t.commit.sha })))
    if (!/rel="next"/.test(res.link)) break
  }
  return tags
}

async function fileAt (file, tag, auth) {
  const res = await api(`repos/${REPO}/contents/${file}?ref=${encodeURIComponent(tag)}`, auth)
  if (!res) return null
  return { sha: res.body.sha, text: Buffer.from(res.body.content, 'base64').toString('utf8') }
}

const parseTag = (name) => {
  const m = TAG_RX.exec(name)
  return m && { name, major: +m[1], minor: +m[2], patch: +m[3], rc: m[4] === undefined ? null : +m[4] }
}
// RCs sort before their GA.
const tagOrder = (a, b) =>
  (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch) ||
  ((a.rc === null ? Infinity : a.rc) - (b.rc === null ? Infinity : b.rc))

/** Release tags grouped by series, newest series first, each list oldest first. */
function seriesTags (tags) {
  const bySeries = new Map()
  for (const tag of tags.map((t) => parseTag(t.name) && { ...parseTag(t.name), commit: t.commit }).filter(Boolean)) {
    const key = `${tag.major}.${tag.minor}`
    if (!bySeries.has(key)) bySeries.set(key, [])
    bySeries.get(key).push(tag)
  }
  const out = []
  for (const [series, list] of bySeries) {
    const ga = list.filter((t) => t.rc === null)
    out.push({ series, major: list[0].major, minor: list[0].minor, tags: (ga.length ? ga : list).sort(tagOrder) })
  }
  return out.sort((a, b) => (b.major - a.major) || (b.minor - a.minor))
}

async function mapLimit (items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }))
  return results
}

/** Everything one tag contributes. */
async function readTag (tag, auth) {
  const [model, configUtils, tests] = await Promise.all([
    fileAt(MODEL_CC, tag.name, auth),
    fileAt(CONFIG_UTILS_H, tag.name, auth),
    fileAt(TEST_CC, tag.name, auth),
  ])
  if (!model) throw new Error(`${tag.name}: ${MODEL_CC} not found`)
  const grammar = upstream.extractGrammar(model.text)
  return {
    tag: tag.name,
    grammar,
    parser: grammar ? upstream.parserFingerprint(upstream.parserFunctions(model.text)) : null,
    clusterGate: grammar ? upstream.extractClusterGate(configUtils && configUtils.text) : null,
    tests: tests && { sha: tests.sha, text: tests.text },
  }
}

async function collect (auth) {
  const all = seriesTags(await listTags(auth))
  const series = []
  for (const entry of all) {
    const newest = await readTag(entry.tags[entry.tags.length - 1], auth)
    if (!newest.grammar) {
      series.push({ ...entry, reads: [] })
      break
    }
    const reads = await mapLimit(entry.tags.slice(0, -1), 6, (tag) => readTag(tag, auth))
    series.push({ ...entry, reads: [...reads, newest] })
    process.stderr.write(`${entry.series}: ${entry.tags.length} tag(s)\n`)
  }
  return series
}

/** The releases JSON: parsers by fingerprint, and each series' grammar history. */
function buildReleases (series) {
  const parsers = {}
  const bySeries = {}
  for (const entry of series) {
    const history = []
    for (const read of entry.reads) {
      if (!read.grammar) throw new Error(`${read.tag}: no iceberg_mode parser, but a newer tag in ${entry.series} has one`)
      if (!parsers[read.parser]) parsers[read.parser] = { firstTag: read.tag, ...read.grammar }
      const last = history[history.length - 1]
      if (!last || last.parser !== read.parser || last.clusterGate !== read.clusterGate) {
        history.push({ since: read.tag, parser: read.parser, clusterGate: read.clusterGate })
      }
    }
    bySeries[entry.series] = history
  }
  // firstTag must be the oldest tag overall, not the first one visited.
  for (const entry of [...series].reverse()) {
    for (const read of entry.reads) {
      const p = parsers[read.parser]
      if (tagOrder(parseTag(read.tag), parseTag(p.firstTag)) < 0) p.firstTag = read.tag
    }
  }
  return {
    $comment: 'Generated by tools/iceberg-mode/generate.js from redpanda-data/streaming-enterprise. Do not edit by hand: run the generator.',
    source: { repo: REPO, files: [MODEL_CC, CONFIG_UTILS_H, TEST_CC] },
    series: bySeries,
    parsers,
  }
}

/**
 * Distinct vector sets, oldest first, each with the release series that ship
 * it. Keyed by the vectors rather than the file's blob, so an edit upstream
 * that touches only cases this ignores (the wire format tests) is no change.
 */
function buildVectorSets (series) {
  const sets = new Map()
  for (const entry of [...series].reverse()) {
    for (const read of entry.reads) {
      if (!read.tests) continue
      const vectors = upstream.extractVectors(read.tests.text)
      const key = JSON.stringify(vectors)
      if (!sets.has(key)) sets.set(key, { since: read.tag, sha: read.tests.sha, series: [], vectors })
      const set = sets.get(key)
      if (!set.series.includes(entry.series)) set.series.push(entry.series)
    }
  }
  return [...sets.values()]
}

function renderVectors (sets) {
  if (!sets.length) throw new Error(`no release has ${TEST_CC}`)
  const newest = sets[sets.length - 1]
  const json = (value) => JSON.stringify(value, null, 2)
  const header = `'use strict'

// GENERATED by tools/iceberg-mode/generate.js. Do not edit: rerun the generator.
//
// Test vectors for redpanda.iceberg.mode, read statement by statement from
// ${TEST_CC} in ${REPO}.
// Each entry names the upstream TEST it came from. Wire round-trip and
// needs_extended_cluster_feature cases are omitted: they test the broker's
// serialization and upgrade gate, not the config string grammar.
//
// The top-level exports are the newest set of cases (first seen at
// ${newest.since}, in series ${newest.series.join(', ')}). \`sets\` holds every distinct
// set, each with the release series that ship it.
`
  const upstreamInfo = { repo: REPO, file: TEST_CC, sha: newest.sha, since: newest.since, series: newest.series }
  const v = newest.vectors
  // One vector per line, so a changed upstream case is a one-line diff.
  const list = (items, indent = '') => items.length
    ? `[\n${items.map((item) => `${indent}  ${JSON.stringify(item)},`).join('\n')}\n${indent}]`
    : '[]'
  const older = sets.slice(0, -1).map((s) => {
    const fields = ['accept', 'reject', 'errorMessages', 'format', 'roundtrip']
      .map((k) => `    ${k}: ${list(s.vectors[k], '    ')},`).join('\n')
    return `  {\n    since: ${JSON.stringify(s.since)},\n    sha: ${JSON.stringify(s.sha)},\n    series: ${JSON.stringify(s.series)},\n${fields}\n  },`
  })
  return `${header}
const UPSTREAM = ${json(upstreamInfo)}

const accept = ${list(v.accept)}

const reject = ${list(v.reject)}

const errorMessages = ${list(v.errorMessages)}

const format = ${list(v.format)}

const roundtrip = ${list(v.roundtrip)}

const sets = [
${[...older, '  { since: UPSTREAM.since, sha: UPSTREAM.sha, series: UPSTREAM.series, accept, reject, errorMessages, format, roundtrip },'].join('\n')}
]

module.exports = { UPSTREAM, accept, reject, errorMessages, format, roundtrip, sets }
`
}

async function main () {
  const series = await collect(token())
  const releases = `${JSON.stringify(buildReleases(series), null, 2)}\n`
  const vectors = renderVectors(buildVectorSets(series))
  fs.writeFileSync(RELEASES_JSON, releases)
  fs.writeFileSync(VECTORS_JS, vectors)
  process.stderr.write(`wrote ${path.relative(ROOT, RELEASES_JSON)} and ${path.relative(ROOT, VECTORS_JS)}\n`)
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`iceberg-mode generate: ${error.message}\n`)
    process.exit(1)
  })
}

module.exports = { seriesTags, buildReleases, buildVectorSets, renderVectors, tagOrder, parseTag }
