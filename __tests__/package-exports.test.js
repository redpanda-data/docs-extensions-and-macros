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
})
