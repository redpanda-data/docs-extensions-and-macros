'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const { parseSourceComment, checkSources, locateSymbol, SYMBOL_WINDOW } = require('../../../tools/check-sources')
const { createVersionResolver, readComponent, _componentCache } = require('../../../tools/check-sources/versions')

// configuration.cc as of a GA release: log_segment_size defaults to 128_MiB.
const CONFIG_CC = [
  '#include "config/configuration.h"', //                        1
  '', //                                                          2
  'configuration::configuration()', //                            3
  '  : log_segment_size(', //                                     4
  '      *this,', //                                              5
  '      "log_segment_size",', //                                 6
  '      "Default log segment size in bytes for topics.",', //    7
  '      {.needs_restart = needs_restart::no},', //               8
  '      128_MiB)', //                                            9
  '  , log_segment_size_min(*this, "log_segment_size_min", "x", {}, 1_MiB)' // 10
].join('\n') + '\n'

// A later release: a property was added above, so every line moved down.
const CONFIG_CC_MOVED = CONFIG_CC.replace('configuration::configuration()\n', 'configuration::configuration()\n  : new_property(*this, "new_property", "x", {}, 0)\n  , unrelated(*this, "unrelated", "y", {}, 1)\n').replace('  : log_segment_size(', '  , log_segment_size(')

// A release that changed the default.
const CONFIG_CC_CHANGED = CONFIG_CC.replace('128_MiB)', '256_MiB)')

const GA = { redpandaGa: 'v26.2.6', redpandaRc: 'v26.3.1-rc1', console: 'v3.13.1', operator: 'v26.2.5', operatorReleases: ['v26.2.5', 'v26.1.9', 'v25.3.12', 'v25.3.11'], connect: 'v4.115.1' }

function stubClient (files) {
  const calls = []
  return {
    calls,
    authenticated: true,
    async getFile ({ repo, ref, path: p }) {
      calls.push(`${repo}@${ref || ''}:${p}`)
      const key = `${repo}@${ref || ''}:${p}`
      if (files[key] !== undefined) return { status: 'ok', text: files[key] }
      if (files[`${repo}@${ref || ''}`] === 'no-ref') return { status: 'missing', refMissing: true, reason: `ref ${ref} does not exist in redpanda-data/${repo}` }
      return { status: 'missing', reason: `${p} does not exist in redpanda-data/${repo}${ref ? ' at ' + ref : ''}` }
    },
    async getPull () { return { status: 'ok', state: 'merged' } },
    async headUrl () { return { status: 'ok', code: 200 } }
  }
}

function antoraYml ({ version = '26.2', prerelease = false, attributes = {} } = {}) {
  const attrs = Object.entries(attributes).map(([k, v]) => `      ${k}: '${v}'`).join('\n')
  return `name: ROOT\nversion: '${version}'\n${prerelease ? 'prerelease: true\n' : ''}asciidoc:\n  attributes:\n${attrs || '      x: y'}\n`
}

async function run (page, { files = {}, yml = antoraYml(), branch = 'main', latest = GA } = {}) {
  _componentCache.clear()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-sources-versions-'))
  fs.mkdirSync(path.join(root, 'modules/ROOT/pages'), { recursive: true })
  fs.writeFileSync(path.join(root, 'modules/ROOT/pages/p.adoc'), page)
  if (yml !== null) fs.writeFileSync(path.join(root, 'antora.yml'), yml)
  const client = stubClient(files)
  let lookups = 0
  const resolveVersion = createVersionResolver({ root, branch, env: {}, latest: () => { lookups++; return latest } })
  const result = await checkSources({ files: ['modules/ROOT/pages/p.adoc'], root, client, resolveVersion })
  return { result, client, lookups, rules: result.findings.map((f) => f.rule), citation: result.citations[0] }
}

const SYMBOL = '// source: streaming-enterprise:src/v/config/configuration.cc#log_segment_size "128_MiB"\nThe default segment size is 128 MiB.\n'

describe('symbol refs: parsing', () => {
  test('repo, path, symbol and quote; the owner and a pin are optional', () => {
    expect(parseSourceComment('streaming-enterprise:src/v/config/configuration.cc#log_segment_size "128_MiB"')).toEqual({
      ref: { kind: 'symbol', text: 'streaming-enterprise:src/v/config/configuration.cc#log_segment_size', owner: 'redpanda-data', repo: 'streaming-enterprise', gitRef: null, path: 'src/v/config/configuration.cc', symbol: 'log_segment_size' },
      quote: '128_MiB'
    })
    expect(parseSourceComment('redpanda-data/console@v3.13.1:backend/pkg/config/kafka.go#DefaultMaxMessages "100"').ref).toMatchObject({ repo: 'console', gitRef: 'v3.13.1', symbol: 'DefaultMaxMessages' })
  })
  test('a symbol ref without its quoted value is malformed', () => {
    expect(parseSourceComment('connect:internal/x.go#maxBatch').error).toMatch(/needs the quoted value/)
  })
  test('another owner is malformed; prose that is not a ref stays a note', () => {
    expect(parseSourceComment('someone/connect:x.go#y "1"').error).toMatch(/owner must be redpanda-data/)
    expect(parseSourceComment('cloudv2 apps/adp-ui/x.tsx CreatePage (section "Activation")').note).toBeDefined()
  })
})

describe('locateSymbol', () => {
  const lines = CONFIG_CC.trimEnd().split('\n')
  test('finds the quote within the window after the symbol, as a whole identifier', () => {
    expect(locateSymbol(lines, 'log_segment_size', '128_MiB')).toEqual({ occurrences: [4, 6], match: { line: 4, quoteLine: 9 } })
    // log_segment_size_min is a different identifier.
    expect(locateSymbol(lines, 'log_segment_size_min', '1_MiB').match).toEqual({ line: 10, quoteLine: 10 })
    expect(locateSymbol(lines, 'segment_size', '128_MiB').occurrences).toEqual([])
  })
  test('a quote past the window does not count', () => {
    const far = ['const x = 1', ...Array(SYMBOL_WINDOW).fill('//'), 'y = 42']
    expect(locateSymbol(far, 'x', '42').match).toBeNull()
  })
})

describe('version-aware refs', () => {
  test('a main-style component checks streaming-enterprise at the newest GA tag', async () => {
    const { rules, citation, lookups } = await run(SYMBOL, { files: { 'streaming-enterprise@v26.2.6:src/v/config/configuration.cc': CONFIG_CC } })
    expect(rules).toEqual([])
    expect(citation).toMatchObject({ ref: 'v26.2.6', resolvedBy: 'latest-redpanda-tag (newest GA)', status: 'ok', line: 1, sourceLine: 9 })
    expect(lookups).toBe(1)
  })

  test('a v/* branch checks against its own antora.yml latest-redpanda-tag, as the build does', async () => {
    const yml = antoraYml({ version: '26.1', attributes: { 'latest-redpanda-tag': 'v26.1.19' } })
    const { rules, citation } = await run(SYMBOL, { yml, branch: 'v/26.1', files: { 'streaming-enterprise@v26.1.19:src/v/config/configuration.cc': CONFIG_CC } })
    expect(rules).toEqual([])
    expect(citation).toMatchObject({ ref: 'v26.1.19', resolvedBy: 'latest-redpanda-tag from antora.yml' })
  })

  test('without a branch, a version whose line is below the newest GA line is older', async () => {
    const yml = antoraYml({ version: '25.3', attributes: { 'latest-redpanda-tag': 'v25.3.18' } })
    const { citation } = await run(SYMBOL, { yml, branch: null, files: { 'streaming-enterprise@v25.3.18:src/v/config/configuration.cc': CONFIG_CC } })
    expect(citation.ref).toBe('v25.3.18')
  })

  test('a prerelease component version checks against the newest RC (redpanda-beta-tag)', async () => {
    const yml = antoraYml({ version: '26.3', prerelease: true })
    const { rules, citation } = await run(SYMBOL, { yml, branch: 'beta', files: { 'streaming-enterprise@v26.3.1-rc1:src/v/config/configuration.cc': CONFIG_CC } })
    expect(rules).toEqual([])
    expect(citation).toMatchObject({ ref: 'v26.3.1-rc1', resolvedBy: 'redpanda-beta-tag (newest RC, prerelease component version)' })
  })

  test('an explicit pin wins over the component version', async () => {
    const page = SYMBOL.replace('streaming-enterprise:', 'streaming-enterprise@v25.3.18:')
    const { rules, citation, lookups } = await run(page, { files: { 'streaming-enterprise@v25.3.18:src/v/config/configuration.cc': CONFIG_CC } })
    expect(rules).toEqual([])
    expect(citation).toMatchObject({ ref: 'v25.3.18', resolvedBy: 'pinned' })
    expect(lookups).toBe(0)
  })

  test('a changed value fails with quote-not-found at the resolved tag', async () => {
    const { rules, result } = await run(SYMBOL, { files: { 'streaming-enterprise@v26.2.6:src/v/config/configuration.cc': CONFIG_CC_CHANGED } })
    expect(rules).toEqual(['quote-not-found'])
    expect(result.findings[0].message).toMatch(/quote not found within 30 lines of log_segment_size \(line 4, 6\) in src\/v\/config\/configuration\.cc at v26\.2\.6: the cited value changed\. It does not appear anywhere in the file\./)
    expect(result.citations[0].status).toBe('error')
    expect(result.summary.errors).toBe(1)
  })

  test('a moved line still passes, and a line ref at the same tag fails', async () => {
    const files = { 'streaming-enterprise@v26.2.6:src/v/config/configuration.cc': CONFIG_CC_MOVED }
    const moved = await run(SYMBOL, { files })
    expect(moved.rules).toEqual([])
    expect(moved.citation).toMatchObject({ line: 1, sourceLine: 11 })
    // The fallback form still works, version-aware too, and catches the move.
    const lineRef = '// Source: redpanda-data/streaming-enterprise:src/v/config/configuration.cc:9 "128_MiB"\nThe default segment size is 128 MiB.\n'
    expect((await run(lineRef, { files: { 'streaming-enterprise@v26.2.6:src/v/config/configuration.cc': CONFIG_CC } })).rules).toEqual([])
    const after = await run(lineRef, { files })
    expect(after.rules).toEqual(['quote-not-found'])
    expect(after.result.findings[0].message).toMatch(/at v26\.2\.6\. It now appears at line 11\./)
  })

  test('a symbol that is gone is symbol-not-found', async () => {
    const page = SYMBOL.replace('#log_segment_size', '#log_segment_bytes')
    const { rules, result } = await run(page, { files: { 'streaming-enterprise@v26.2.6:src/v/config/configuration.cc': CONFIG_CC } })
    expect(rules).toEqual(['symbol-not-found'])
    expect(result.findings[0].message).toMatch(/log_segment_bytes does not appear in src\/v\/config\/configuration\.cc at v26\.2\.6\. The quote appears at line 9\./)
  })

  test('the operator: an older line pins to its own newest release, and the git tag falls back from operator/<tag> to <tag>', async () => {
    const page = '// source: redpanda-operator:operator/api/redpanda/v1alpha2/redpanda_types.go#Replicas "default=3"\nThe default is three brokers.\n'
    const latest = await run(page, { files: { 'redpanda-operator@operator/v26.2.5:operator/api/redpanda/v1alpha2/redpanda_types.go': '// Replicas\n// +kubebuilder:default=3\n' } })
    expect(latest.rules).toEqual([])
    expect(latest.citation.ref).toBe('operator/v26.2.5')
    const yml = antoraYml({ version: '25.3' })
    const older = await run(page, { yml, branch: 'v/25.3', files: { 'redpanda-operator@operator/v25.3.12': 'no-ref', 'redpanda-operator@v25.3.12:operator/api/redpanda/v1alpha2/redpanda_types.go': '// Replicas\n// +kubebuilder:default=3\n' } })
    expect(older.rules).toEqual([])
    expect(older.citation).toMatchObject({ ref: 'v25.3.12', resolvedBy: 'latest-operator-version (newest 25.3 release)' })
    expect(older.client.calls).toEqual(['redpanda-operator@operator/v25.3.12:operator/api/redpanda/v1alpha2/redpanda_types.go', 'redpanda-operator@v25.3.12:operator/api/redpanda/v1alpha2/redpanda_types.go'])
  })

  test('connect uses the newest release, not a stale antora.yml seed', async () => {
    const yml = antoraYml({ version: '~', attributes: { 'full-version': '24.1.4', 'latest-connect-version': '4.20.0' } }).replace("version: '~'", 'version: ~')
    const page = '// source: connect:internal/impl/kafka/franz_reader.go#kfrFieldCommitPeriod "5s"\nOffsets are committed every five seconds.\n'
    const { rules, citation } = await run(page, { yml, files: { 'connect@v4.115.1:internal/impl/kafka/franz_reader.go': 'kfrFieldCommitPeriod).Default("5s")\n' } })
    expect(rules).toEqual([])
    expect(citation.ref).toBe('v4.115.1')
  })

  test('when the live lookup fails, the antora.yml value is used and reported', async () => {
    const yml = antoraYml({ attributes: { 'latest-redpanda-tag': 'v26.2.1' } })
    const { rules, citation, result } = await run(SYMBOL, { yml, latest: {}, files: { 'streaming-enterprise@v26.2.1:src/v/config/configuration.cc': CONFIG_CC } })
    expect(rules).toEqual(['version-fallback'])
    expect(result.findings[0].severity).toBe('info')
    expect(citation.ref).toBe('v26.2.1')
  })

  test('with no live value and no fallback, the citation is unresolved, a warning', async () => {
    const { rules, result } = await run(SYMBOL, { latest: {} })
    expect(rules).toEqual(['unresolved-version'])
    expect(result.summary.errors).toBe(0)
    expect(result.citations[0].status).toBe('unresolved')
  })

  test('a repo docs do not track releases of is checked on its default branch and flagged unversioned', async () => {
    const page = '// source: cloudv2:apps/adp-api/internal/agent/trigger/cron/validate.go#maxInputPromptChars "4000"\nAn input prompt has at most 4,000 characters.\n'
    const { rules, citation } = await run(page, { files: { 'cloudv2@:apps/adp-api/internal/agent/trigger/cron/validate.go': 'const maxInputPromptChars = 4000\n' } })
    expect(rules).toEqual(['unversioned'])
    expect(citation).toMatchObject({ ref: null, resolvedBy: 'default branch' })
  })

  test('a page with no antora.yml above it keeps the default branch, as before', async () => {
    const { rules, citation, lookups } = await run(SYMBOL, { yml: null, files: { 'streaming-enterprise@:src/v/config/configuration.cc': CONFIG_CC } })
    expect(rules).toEqual([])
    expect(citation.ref).toBeNull()
    expect(lookups).toBe(0)
  })

  test('result.resolved lists each ref once', async () => {
    const page = SYMBOL + '\n' + SYMBOL.replace('"128_MiB"', '"log_segment_size"')
    const { result } = await run(page, { files: { 'streaming-enterprise@v26.2.6:src/v/config/configuration.cc': CONFIG_CC } })
    expect(result.resolved).toEqual([{ repo: 'streaming-enterprise', ref: 'v26.2.6', by: 'latest-redpanda-tag (newest GA)' }])
    expect(result.fetches).toBe(1)
  })
})

describe('readComponent', () => {
  test('reads the nearest antora.yml', () => {
    _componentCache.clear()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-sources-yml-'))
    fs.mkdirSync(path.join(root, 'docs/modules/x/pages'), { recursive: true })
    fs.writeFileSync(path.join(root, 'docs/antora.yml'), antoraYml({ version: '26.1', prerelease: true, attributes: { 'latest-redpanda-tag': 'v26.1.2' } }))
    expect(readComponent(root, path.join(root, 'docs/modules/x/pages/a.adoc'))).toMatchObject({ version: '26.1', prerelease: true, attributes: { 'latest-redpanda-tag': 'v26.1.2' } })
    expect(readComponent(root, path.join(root, 'other/a.adoc'))).toBeNull()
  })
})
