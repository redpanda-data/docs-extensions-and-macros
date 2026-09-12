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

/**
 * `files` is an allowlist, so a schema that is committed and documented can
 * still be missing from the tarball with every test green. That happened to
 * property-overrides.schema.json twice: consumers' `sync-schemas --check`
 * reported "in sync" while never seeing the file. Ask npm what it would
 * actually pack rather than reading `files` back.
 */
describe('npm tarball ships every docs-data file consumers read', () => {
  const { execFileSync } = require('child_process')
  const root = path.join(__dirname, '..')
  let packed

  beforeAll(() => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    })
    packed = new Set(JSON.parse(out)[0].files.map((f) => f.path))
  }, 120000)

  const schemas = fs.readdirSync(path.join(root, 'docs-data')).filter((f) => f.endsWith('.schema.json'))

  test.each(schemas)('docs-data/%s is packed', (file) => {
    expect(packed).toContain(`docs-data/${file}`)
  })

  test('docs-data/kapa-source-groups.json is packed (read by extensions/kapa-source-groups.js)', () => {
    expect(packed).toContain('docs-data/kapa-source-groups.json')
  })
})
