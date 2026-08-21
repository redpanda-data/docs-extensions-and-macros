'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Every extension file must be reachable through the package exports map.
 * The map enumerates subpaths explicitly, so a new extension that ships
 * without an entry loads fine in this repo but throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED in every consumer — found the hard way when
 * set-available-attachment-versions broke the docs-site build despite the
 * file being present in the published package.
 */
describe('package exports cover all extensions', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))

  const exportedTargets = new Set(
    Object.values(pkg.exports || {}).map((v) => (typeof v === 'object' ? v.require : v))
  )

  const extensionFiles = fs
    .readdirSync(path.join(__dirname, '..', 'extensions'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `./extensions/${f}`)

  test.each(extensionFiles)('%s is exported', (file) => {
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

  test.each(extensionFiles)('%s is reachable by its conventional specifier', (file) => {
    const specifier = file.replace(/\.js$/, '')
    expect(Object.keys(pkg.exports || {})).toContain(specifier)
  })
})
