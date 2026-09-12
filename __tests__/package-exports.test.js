'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Every extension and macro file must be reachable through the package exports
 * map. The map enumerates subpaths explicitly, so a new extension or macro that
 * ships without an entry loads fine in this repo but throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED in every consumer — found the hard way when
 * set-available-attachment-versions broke the docs-site build despite the
 * file being present in the published package.
 *
 * The directory list is derived from the filesystem rather than a hand-kept
 * list, so a new macro is guarded the moment it lands.
 */
describe('package exports cover all extensions and macros', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))

  const exportedTargets = new Set(
    Object.values(pkg.exports || {}).map((v) => (typeof v === 'object' ? v.require : v))
  )

  const sourceFiles = ['extensions', 'macros'].flatMap((dir) =>
    fs
      .readdirSync(path.join(__dirname, '..', dir))
      .filter((f) => f.endsWith('.js'))
      .map((f) => `./${dir}/${f}`)
  )

  test.each(sourceFiles)('%s is exported', (file) => {
    expect(exportedTargets).toContain(file)
  })

  // Targets alone are not enough: the KEY is the specifier consumers write, and
  // playbooks write it without the extension. A key carrying a stray '.js'
  // passed the check above while `require('.../extensions/foo')` still threw
  // ERR_PACKAGE_PATH_NOT_EXPORTED.
  test('every extension subpath key omits the .js suffix', () => {
    const offenders = Object.keys(pkg.exports || {}).filter(
      (key) => key.startsWith('./extensions/') && key.endsWith('.js')
    )
    expect(offenders).toEqual([])
  })

  test.each(sourceFiles)('%s is reachable by its conventional specifier', (file) => {
    const specifier = file.replace(/\.js$/, '')
    expect(Object.keys(pkg.exports || {})).toContain(specifier)
  })
})

/**
 * A release only reaches consuming repos if the version moves. The publish
 * workflow is a no-op for a version npm already has, and package-lock.json
 * mirrors the version in two places, so a half-applied bump is easy to miss.
 */
describe('package version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'))

  test('package-lock mirrors the package version in both places', () => {
    expect(lock.version).toBe(pkg.version)
    expect(lock.packages[''].version).toBe(pkg.version)
  })
})
