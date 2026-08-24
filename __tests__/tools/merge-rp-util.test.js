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
const path = require('path')
const { spawnSync } = require('child_process')
const { getRpUtilSchema } = require('../../tools/property-extractor/rp-util-fetch')
const { main } = require('../../tools/property-extractor/merge-rp-util')

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
  })

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

  test('never touches the real output when getRpUtilSchema rejects', async () => {
    getRpUtilSchema.mockRejectedValue(new Error('no token, and Docker is not running'))

    await main()

    expect(spawnSync).not.toHaveBeenCalled()
    expect(renamed).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no token, and Docker is not running'))
  })

  test('skips the merge entirely when rp_util returned no schemas at all', async () => {
    getRpUtilSchema.mockResolvedValue({ sourcePath: null })

    await main()

    expect(spawnSync).not.toHaveBeenCalled()
    expect(renamed).toBeNull()
  })

  test('never renames the temp file over the real output when the merge subprocess fails', async () => {
    getRpUtilSchema.mockResolvedValue({ clusterSchema: { a: 1 }, sourcePath: null })
    spawnSync.mockReturnValue({ status: 1 })

    await main()

    expect(renamed).toBeNull()
    // The (failed) temp output is cleaned up rather than left behind.
    expect(removedPaths).toContain('/gen/v26.2.2-properties.json.rp-util-merge-tmp')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('rp_util merge failed'))
  })

  test('never renames the temp file over the real output when spawnSync itself errors', async () => {
    getRpUtilSchema.mockResolvedValue({ clusterSchema: { a: 1 }, sourcePath: null })
    spawnSync.mockReturnValue({ error: new Error('python3 not found'), status: null })

    await main()

    expect(renamed).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('python3 not found'))
  })

  test('still cleans up the schema scratch dir when the merge subprocess fails', async () => {
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
})
