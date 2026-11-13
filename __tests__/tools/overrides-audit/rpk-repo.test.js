'use strict'

// `doc-tools overrides audit --surface rpk --repo <src/go/rpk>`: the audit
// builds rpk there and runs the locate-strings analyzer. Both are mocked
// here; the analyzer itself is tested in tools/rpk-docs/scripts/locate-strings
// (see locate-strings.test.js).

const fs = require('fs')
const os = require('os')
const path = require('path')

jest.mock('../../../tools/rpk-docs/rpk-docs-handler', () => ({
  fetchRpkTreeFromSource: jest.fn(),
  locateRpkSourceStrings: jest.fn()
}))

const handler = require('../../../tools/rpk-docs/rpk-docs-handler')
const { runAudit } = require('../../../tools/overrides-audit')
const { CLASSES } = require('../../../tools/overrides-audit/classify')

// What `rpk --print-tree` prints: a bare tree, no overrides applied.
const printTree = {
  name: 'rpk',
  description: 'rpk is the Redpanda CLI',
  commands: [
    {
      name: 'widget',
      description: 'Manage widgets',
      flags: [{ name: 'size', type: 'int', description: 'Size of the widget', default: 0 }],
      commands: []
    }
  ]
}

describe('overrides audit --surface rpk --repo', () => {
  let tmpDir
  let overridesPath
  let logSpy
  let errorSpy

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overrides-audit-rpk-repo-'))
    overridesPath = path.join(tmpDir, 'rpk-overrides.json')
    fs.writeFileSync(overridesPath, JSON.stringify({
      commands: {
        'rpk widget': {
          description: 'Create, list and delete widgets.',
          flags: { size: { description: 'Widget size in units.' } }
        }
      }
    }))
    handler.fetchRpkTreeFromSource.mockReset()
    handler.locateRpkSourceStrings.mockReset()
    handler.fetchRpkTreeFromSource.mockImplementation((repo, log) => {
      log(`Building and running rpk from source at ${repo}...`)
      return printTree
    })
    handler.locateRpkSourceStrings.mockImplementation((repo, log) => {
      log('locate-strings: resolved 2 command node(s)')
      return [{ path: 'rpk widget', description: { file: 'pkg/cli/widget/widget.go', line: 12 }, flags: [{ flag: 'size', file: 'pkg/cli/widget/widget.go', line: 20 }] }]
    })
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const rowsByKey = (result) => Object.fromEntries(result.manifest.map((row) => [`${row.name}|${row.field}`, row]))

  test('audits against the --print-tree output as raw_tree and attaches source locations', () => {
    const result = runAudit({ overrides: overridesPath, repo: '/src/go/rpk', surface: 'rpk' })
    expect(handler.fetchRpkTreeFromSource).toHaveBeenCalledWith(path.resolve('/src/go/rpk'), expect.any(Function))
    expect(JSON.parse(fs.readFileSync(result.extracted_file, 'utf8'))).toEqual({ raw_tree: printTree })
    const byKey = rowsByKey(result)
    expect(byKey['rpk widget|description']).toMatchObject({ class: CLASSES.UPSTREAMABLE, source_file: 'pkg/cli/widget/widget.go', source_line: 12 })
    expect(byKey['rpk widget --size|flags.description']).toMatchObject({ class: CLASSES.UPSTREAMABLE, source_line: 20 })
    expect(result.locations_file).not.toBeNull()
  })

  test('progress logs go to stderr, never stdout, so the JSON on stdout stays parseable', () => {
    runAudit({ overrides: overridesPath, repo: '/src/go/rpk', surface: 'rpk' })
    expect(logSpy).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Building and running rpk'))
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('locate-strings: resolved'))
  })

  test('--locations skips the analyzer; --extracted skips the build', () => {
    const locations = path.join(tmpDir, 'locations.json')
    fs.writeFileSync(locations, JSON.stringify([{ path: 'rpk widget', description: { file: 'given.go', line: 3 } }]))
    const extracted = path.join(tmpDir, 'snapshot.json')
    fs.writeFileSync(extracted, JSON.stringify({ raw_tree: printTree }))

    const withLocations = runAudit({ overrides: overridesPath, repo: '/src/go/rpk', locations, surface: 'rpk' })
    expect(handler.locateRpkSourceStrings).not.toHaveBeenCalled()
    expect(rowsByKey(withLocations)['rpk widget|description'].source_file).toBe('given.go')

    const withExtracted = runAudit({ overrides: overridesPath, repo: '/src/go/rpk', extracted, surface: 'rpk' })
    expect(handler.fetchRpkTreeFromSource).toHaveBeenCalledTimes(1)
    expect(handler.locateRpkSourceStrings).toHaveBeenCalledTimes(1)
    expect(withExtracted.extracted_file).toBe(extracted)
    expect(rowsByKey(withExtracted)['rpk widget|description'].source_line).toBe(12)
  })

  test('a locator failure is a warning: no locations, and no row reported as unlocatable', () => {
    handler.locateRpkSourceStrings.mockImplementation(() => { throw new Error('go: not found') })
    const result = runAudit({ overrides: overridesPath, repo: '/src/go/rpk', surface: 'rpk' })
    expect(result.locations_file).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('locator failed'))
    for (const row of result.manifest) {
      expect(row.source_file).toBeUndefined()
      expect(row.note || '').not.toMatch(/No source location/)
    }
  })
})
