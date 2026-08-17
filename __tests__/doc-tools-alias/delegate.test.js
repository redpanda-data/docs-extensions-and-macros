'use strict'

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..', '..')
const aliasDir = path.join(repoRoot, 'doc-tools-alias')

describe('doc-tools alias package', () => {
  let tmp

  beforeAll(() => {
    // Stage the alias as npx would install it, with its dependency on
    // @redpanda-data/docs-extensions-and-macros satisfied by a symlink to
    // this repository, so delegation is exercised against the real CLI.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-tools-alias-'))
    fs.cpSync(path.join(aliasDir, 'bin'), path.join(tmp, 'bin'), { recursive: true })
    fs.copyFileSync(path.join(aliasDir, 'package.json'), path.join(tmp, 'package.json'))
    const scopeDir = path.join(tmp, 'node_modules', '@redpanda-data')
    fs.mkdirSync(scopeDir, { recursive: true })
    fs.symlinkSync(repoRoot, path.join(scopeDir, 'docs-extensions-and-macros'), 'dir')
  })

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('exposes the same bin names as the parent package', () => {
    const aliasBins = require(path.join(aliasDir, 'package.json')).bin
    const parentBins = require(path.join(repoRoot, 'package.json')).bin
    expect(Object.keys(aliasBins).sort()).toEqual(Object.keys(parentBins).sort())
  })

  test('every parent bin the alias delegates to exists', () => {
    const parentBins = require(path.join(repoRoot, 'package.json')).bin
    for (const rel of Object.values(parentBins)) {
      expect(fs.existsSync(path.join(repoRoot, rel))).toBe(true)
    }
  })

  test('doc-tools delegates to the parent CLI', () => {
    const r = spawnSync(
      process.execPath,
      [path.join(tmp, 'bin', 'doc-tools.js'), '--help'],
      { encoding: 'utf8' }
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('doc-tools')
  })

  test('exits with an error when the parent stops exposing a bin', () => {
    const brokenShim = path.join(tmp, 'bin', 'gone.js')
    fs.writeFileSync(
      brokenShim,
      "require('./delegate').delegate('no-such-bin')\n"
    )
    const r = spawnSync(process.execPath, [brokenShim], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('no-such-bin')
  })
})
