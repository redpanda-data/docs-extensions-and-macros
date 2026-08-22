const { describe, it, expect } = require('@jest/globals')
const fs = require('fs')
const path = require('path')

// The publish workflow only publishes when package.json carries a version that is
// not on npm yet, and npm ci fails when the lockfile records a different version
// than package.json. A bump that misses either mirrored slot in the lockfile
// therefore breaks a release, so pin all three values together.
const repoRoot = path.resolve(__dirname, '..')
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8'))

describe('package version', () => {
  const pkg = readJson('package.json')
  const lock = readJson('package-lock.json')

  it('is a plain three-part version', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('matches both mirrored versions in package-lock.json', () => {
    expect(lock.version).toBe(pkg.version)
    expect(lock.packages[''].version).toBe(pkg.version)
  })

  it('names the same package in both files', () => {
    expect(lock.name).toBe(pkg.name)
    expect(lock.packages[''].name).toBe(pkg.name)
  })
})
