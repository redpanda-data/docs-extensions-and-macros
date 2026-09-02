'use strict'

/**
 * Unit tests for tools/property-extractor/merge-rp-util.js.
 *
 * Mocks rp-util-fetch and child_process so no real network call, clone, or
 * Bazel build ever runs. The point of this script is gluing getRpUtilSchema
 * and rp_util_merge.py's CLI together correctly, and never letting a
 * failure anywhere in that chain break the Tree-sitter-only fallback that
 * was already sitting at `output` before this ran.
 */

jest.mock('child_process')
// Mock only getRpUtilSchema (the thing that would clone/build/fetch for
// real); keep the real SCHEMA_FLAGS, since this script's schema-directory
// logic iterates over the real shape.
jest.mock('../../tools/property-extractor/rp-util-fetch', () => ({
  ...jest.requireActual('../../tools/property-extractor/rp-util-fetch'),
  getRpUtilSchema: jest.fn()
}))

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { getRpUtilSchema } = require('../../tools/property-extractor/rp-util-fetch')
const { main, markRpUtilMergeUnavailable } = require('../../tools/property-extractor/merge-rp-util')

describe('merge-rp-util main()', () => {
  let tmpDir
  let writtenFiles
  let removedPaths
  let renamed

  beforeEach(() => {
    process.argv = ['node', 'merge-rp-util.js', '--tag', 'v26.2.2', '--enhanced', '/gen/v26.2.2-properties.json']
    getRpUtilSchema.mockReset()
    spawnSync.mockReset()
    writtenFiles = {}
    removedPaths = []
    renamed = null
    tmpDir = '/tmp/rp-util-schemas-fake'

    jest.spyOn(fs, 'mkdtempSync').mockReturnValue(tmpDir)
    jest.spyOn(fs, 'writeFileSync').mockImplementation((p, content) => { writtenFiles[p] = content })
    jest.spyOn(fs, 'existsSync').mockImplementation((p) => p === tmpDir || p.endsWith('overrides.json'))
    jest.spyOn(fs, 'rmSync').mockImplementation((p) => { removedPaths.push(p) })
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => { renamed = { from, to } })
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
    // Release-mode tests set a nonzero exit code on purpose; reset it so the
    // jest worker process itself doesn't inherit a failing exit status.
    process.exitCode = undefined
  })

  // The soft-fallback contract below is branch-ref behavior. Release tags
  // hard-fail instead -- see the release-mode tests at the end of this suite.
  const useBranchRef = () => {
    process.argv = ['node', 'merge-rp-util.js', '--tag', 'dev', '--enhanced', '/gen/dev-properties.json']
  }

  test('writes every schema to the temp dir and merges into a temp output, then renames over the real output', async () => {
    getRpUtilSchema.mockResolvedValue({
      clusterSchema: { a: 1 }, nodeSchema: { b: 2 }, pandaproxySchema: {},
      kafkaClientSchema: {}, schemaRegistrySchema: {}, sourcePath: null
    })
    spawnSync.mockReturnValue({ status: 0 })

    await main()

    expect(JSON.parse(writtenFiles[path.join(tmpDir, 'clusterSchema.json')])).toEqual({ a: 1 })
    expect(JSON.parse(writtenFiles[path.join(tmpDir, 'nodeSchema.json')])).toEqual({ b: 2 })

    const [pythonBin, mergeArgs] = spawnSync.mock.calls[0]
    expect(mergeArgs).toEqual(expect.arrayContaining([
      'rp_util_merge.py', '--enhanced', '/gen/v26.2.2-properties.json', '--rp-util-dir', tmpDir
    ]))
    const outputIdx = mergeArgs.indexOf('--output')
    expect(mergeArgs[outputIdx + 1]).toBe('/gen/v26.2.2-properties.json.rp-util-merge-tmp')

    expect(renamed).toEqual({
      from: '/gen/v26.2.2-properties.json.rp-util-merge-tmp',
      to: '/gen/v26.2.2-properties.json'
    })
    // The schema scratch dir is always cleaned up.
    expect(removedPaths).toContain(tmpDir)
  })

  test('defaults --output to --enhanced when --output is not given', async () => {
    getRpUtilSchema.mockResolvedValue({ clusterSchema: { a: 1 }, sourcePath: null })
    spawnSync.mockReturnValue({ status: 0 })

    await main()

    expect(renamed.to).toBe('/gen/v26.2.2-properties.json')
  })

  test('respects an explicit --output different from --enhanced', async () => {
    process.argv.push('--output', '/gen/merged.json')
    getRpUtilSchema.mockResolvedValue({ clusterSchema: { a: 1 }, sourcePath: null })
    spawnSync.mockReturnValue({ status: 0 })

    await main()

    const mergeArgs = spawnSync.mock.calls[0][1]
    expect(mergeArgs).toEqual(expect.arrayContaining(['--enhanced', '/gen/v26.2.2-properties.json']))
    expect(renamed.to).toBe('/gen/merged.json')
  })

  test('passes --overrides through only when the file actually exists', async () => {
    process.argv.push('--overrides', '/docs-data/property-overrides.json')
    getRpUtilSchema.mockResolvedValue({ clusterSchema: { a: 1 }, sourcePath: null })
    spawnSync.mockReturnValue({ status: 0 })

    await main()

    const mergeArgs = spawnSync.mock.calls[0][1]
    expect(mergeArgs).toEqual(expect.arrayContaining(['--overrides', '/docs-data/property-overrides.json']))
  })

  test('omits --overrides when the given path does not exist', async () => {
    process.argv.push('--overrides', '/does/not/exist.json')
    fs.existsSync.mockImplementation((p) => p === tmpDir) // overrides path is not among the "exists" ones
    getRpUtilSchema.mockResolvedValue({ clusterSchema: { a: 1 }, sourcePath: null })
    spawnSync.mockReturnValue({ status: 0 })

    await main()

    const mergeArgs = spawnSync.mock.calls[0][1]
    expect(mergeArgs).not.toContain('--overrides')
  })

  test('passes --source-path through to getRpUtilSchema as sourcePath', async () => {
    process.argv.push('--source-path', '/local/streaming-enterprise')
    getRpUtilSchema.mockResolvedValue({ clusterSchema: { a: 1 }, sourcePath: '/local/streaming-enterprise' })
    spawnSync.mockReturnValue({ status: 0 })

    await main()

    expect(getRpUtilSchema).toHaveBeenCalledWith('v26.2.2', { sourcePath: '/local/streaming-enterprise' })
  })

  test('calls getRpUtilSchema with no options when --source-path is not given', async () => {
    getRpUtilSchema.mockResolvedValue({ clusterSchema: { a: 1 }, sourcePath: null })
    spawnSync.mockReturnValue({ status: 0 })

    await main()

    expect(getRpUtilSchema).toHaveBeenCalledWith('v26.2.2', undefined)
  })

  test('never touches the real output when getRpUtilSchema rejects on a branch ref, but marks cluster/broker properties as unavailable', async () => {
    useBranchRef()
    getRpUtilSchema.mockRejectedValue(new Error('no token, and Docker is not running'))
    jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      properties: {
        a: { config_scope: 'cluster' }, // no gets_restored -- should be marked
        b: { config_scope: 'cluster', gets_restored: true }, // already has it -- untouched
        c: { config_scope: 'topic' } // out of rp_util's scope -- untouched
      }
    }))

    await main()

    expect(spawnSync).not.toHaveBeenCalled()
    expect(renamed).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no token, and Docker is not running'))
    const written = JSON.parse(writtenFiles['/gen/dev-properties.json'])
    expect(written.properties.a.rp_util_merge_status).toBe('unavailable')
    expect(written.properties.b.rp_util_merge_status).toBeUndefined()
    expect(written.properties.c.rp_util_merge_status).toBeUndefined()
  })

  test('skips the merge entirely when rp_util returned no schemas at all on a branch ref, and marks properties as unavailable', async () => {
    useBranchRef()
    getRpUtilSchema.mockResolvedValue({ sourcePath: null })
    jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      properties: { a: { config_scope: 'broker' } }
    }))

    await main()

    expect(spawnSync).not.toHaveBeenCalled()
    expect(renamed).toBeNull()
    const written = JSON.parse(writtenFiles['/gen/dev-properties.json'])
    expect(written.properties.a.rp_util_merge_status).toBe('unavailable')
  })

  test('never renames the temp file over the real output when the merge subprocess fails on a branch ref, and marks properties as unavailable', async () => {
    useBranchRef()
    getRpUtilSchema.mockResolvedValue({ clusterSchema: { a: 1 }, sourcePath: null })
    spawnSync.mockReturnValue({ status: 1 })
    jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      properties: { a: { config_scope: 'cluster' } }
    }))

    await main()

    expect(renamed).toBeNull()
    // The (failed) temp output is cleaned up rather than left behind.
    expect(removedPaths).toContain('/gen/dev-properties.json.rp-util-merge-tmp')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('rp_util merge failed'))
    const written = JSON.parse(writtenFiles['/gen/dev-properties.json'])
    expect(written.properties.a.rp_util_merge_status).toBe('unavailable')
  })

  test('never renames the temp file over the real output when spawnSync itself errors on a branch ref', async () => {
    useBranchRef()
    getRpUtilSchema.mockResolvedValue({ clusterSchema: { a: 1 }, sourcePath: null })
    spawnSync.mockReturnValue({ error: new Error('python3 not found'), status: null })
    jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ properties: {} }))

    await main()

    expect(renamed).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('python3 not found'))
  })

  test('never throws when the enhanced file cannot be read while marking unavailable properties', async () => {
    useBranchRef()
    getRpUtilSchema.mockRejectedValue(new Error('boom'))
    jest.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT') })

    await expect(main()).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('could not mark rp_util merge as unavailable'))
  })

  test('still cleans up the schema scratch dir when the merge subprocess fails', async () => {
    useBranchRef()
    getRpUtilSchema.mockResolvedValue({ clusterSchema: { a: 1 }, sourcePath: null })
    spawnSync.mockReturnValue({ status: 1 })

    await main()

    expect(removedPaths).toContain(tmpDir)
  })

  test('prefers the venv python when it exists, falls back to python3 otherwise', async () => {
    getRpUtilSchema.mockResolvedValue({ clusterSchema: { a: 1 }, sourcePath: null })
    spawnSync.mockReturnValue({ status: 0 })
    fs.existsSync.mockImplementation((p) => p === tmpDir) // no venv python on disk

    await main()

    const pythonBin = spawnSync.mock.calls[0][0]
    expect(pythonBin).toBe('python3')
  })

  test('a branch-ref failure stays a warning: no failing exit code', async () => {
    useBranchRef()
    getRpUtilSchema.mockRejectedValue(new Error('no schema anywhere'))
    jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ properties: {} }))

    await main()

    expect(process.exitCode).toBeUndefined()
  })

  // Release tags publish the property reference, so a missing rp_util schema
  // must fail the run instead of silently shipping the Tree-sitter-only
  // extraction (which drops/misparses enum_set properties post
  // streaming-enterprise#63).
  test('fails the run when getRpUtilSchema rejects for a release tag, without touching the enhanced file', async () => {
    getRpUtilSchema.mockRejectedValue(new Error('no published schema, Bazel unavailable'))
    jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ properties: { a: { config_scope: 'cluster' } } }))

    await main()

    expect(process.exitCode).toBe(1)
    expect(spawnSync).not.toHaveBeenCalled()
    expect(renamed).toBeNull()
    // No unavailable-marker rewrite: the run is failing, not degrading.
    expect(writtenFiles['/gen/v26.2.2-properties.json']).toBeUndefined()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Refusing to publish Tree-sitter-only property data'))
  })

  test('fails the run when the merge subprocess fails for a release tag, and still cleans up the temp output', async () => {
    getRpUtilSchema.mockResolvedValue({ clusterSchema: { a: 1 }, sourcePath: null })
    spawnSync.mockReturnValue({ status: 1 })
    jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ properties: {} }))

    await main()

    expect(process.exitCode).toBe(1)
    expect(renamed).toBeNull()
    expect(removedPaths).toContain('/gen/v26.2.2-properties.json.rp-util-merge-tmp')
  })

  test('treats an RC tag as a release', async () => {
    process.argv = ['node', 'merge-rp-util.js', '--tag', 'v26.3.1-rc1', '--enhanced', '/gen/v26.3.1-rc1-properties.json']
    getRpUtilSchema.mockRejectedValue(new Error('nope'))
    jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ properties: {} }))

    await main()

    expect(process.exitCode).toBe(1)
  })
})

// Genuine end-to-end coverage against a real file on disk -- no fs mocking
// here, unlike the main() suite above.
describe('markRpUtilMergeUnavailable', () => {
  let tmpFile

  beforeEach(() => {
    tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'merge-rp-util-test-')), 'enhanced.json')
  })

  afterEach(() => {
    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true })
  })

  test('marks cluster/broker properties missing gets_restored, leaves everything else untouched', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      properties: {
        needs_mark: { config_scope: 'cluster' },
        already_known: { config_scope: 'broker', gets_restored: false },
        topic_scoped: { config_scope: 'topic' },
        no_scope: { name: 'weird_but_real' }
      }
    }))

    markRpUtilMergeUnavailable(tmpFile)

    const result = JSON.parse(fs.readFileSync(tmpFile, 'utf8'))
    expect(result.properties.needs_mark.rp_util_merge_status).toBe('unavailable')
    expect(result.properties.already_known.rp_util_merge_status).toBeUndefined()
    expect(result.properties.already_known.gets_restored).toBe(false)
    expect(result.properties.topic_scoped.rp_util_merge_status).toBeUndefined()
    expect(result.properties.no_scope.rp_util_merge_status).toBeUndefined()
  })

  test('does not rewrite the file at all when nothing needs marking', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      properties: { a: { config_scope: 'cluster', gets_restored: true } }
    }))
    const before = fs.statSync(tmpFile).mtimeMs

    markRpUtilMergeUnavailable(tmpFile)

    expect(fs.statSync(tmpFile).mtimeMs).toBe(before)
  })

  test('warns but does not throw when the file does not exist', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => markRpUtilMergeUnavailable(path.join(path.dirname(tmpFile), 'missing.json'))).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not mark rp_util merge as unavailable'))
    warn.mockRestore()
  })
})
