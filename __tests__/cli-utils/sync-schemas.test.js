'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const { listPackageSchemas, syncSchemas, findDestOnlyPaths, PACKAGE_SCHEMA_DIR } = require('../../cli-utils/sync-schemas')

describe('sync-schemas', () => {
  describe('listPackageSchemas', () => {
    it('finds the real schema files shipped in docs-data/', () => {
      const schemas = listPackageSchemas()
      const names = schemas.map((s) => s.name)
      expect(names).toContain('rpk-overrides.schema.json')
      // Every listed file must actually exist and end in .schema.json.
      for (const { name, sourcePath } of schemas) {
        expect(name.endsWith('.schema.json')).toBe(true)
        expect(fs.existsSync(sourcePath)).toBe(true)
      }
    })

    it('resolves sourcePath under the package docs-data directory', () => {
      const schemas = listPackageSchemas()
      for (const { sourcePath } of schemas) {
        expect(path.dirname(sourcePath)).toBe(PACKAGE_SCHEMA_DIR)
      }
    })
  })

  describe('syncSchemas', () => {
    let tempDir

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-schemas-'))
    })

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true })
    })

    it('creates missing schemas in an empty destination', () => {
      const { results, drift } = syncSchemas({ destDir: tempDir })

      expect(drift).toBe(true)
      const rpk = results.find((r) => r.name === 'rpk-overrides.schema.json')
      expect(rpk.status).toBe('created')
      expect(fs.existsSync(path.join(tempDir, 'rpk-overrides.schema.json'))).toBe(true)
    })

    it('reports unchanged and writes nothing when the destination already matches', () => {
      syncSchemas({ destDir: tempDir }) // first sync creates everything
      const before = fs.readFileSync(path.join(tempDir, 'rpk-overrides.schema.json'), 'utf8')

      const { results, drift } = syncSchemas({ destDir: tempDir })

      expect(drift).toBe(false)
      expect(results.every((r) => r.status === 'unchanged')).toBe(true)
      expect(fs.readFileSync(path.join(tempDir, 'rpk-overrides.schema.json'), 'utf8')).toBe(before)
    })

    it('detects and fixes a stale destination copy (the drift this command exists to catch)', () => {
      // "Stale" means the destination lacks content the source has -- a
      // strict subset, safe to overwrite. Built by deleting a real field
      // from the real schema, not an unrelated shape (which is 'diverged',
      // covered separately below).
      const realSchema = JSON.parse(fs.readFileSync(
        path.join(PACKAGE_SCHEMA_DIR, 'rpk-overrides.schema.json'), 'utf8'
      ))
      const stale = JSON.parse(JSON.stringify(realSchema))
      delete stale['$defs'].commandOverride.properties.seeAlso

      fs.mkdirSync(tempDir, { recursive: true })
      fs.writeFileSync(path.join(tempDir, 'rpk-overrides.schema.json'), JSON.stringify(stale))

      const { results, drift } = syncSchemas({ destDir: tempDir })

      expect(drift).toBe(true)
      const rpk = results.find((r) => r.name === 'rpk-overrides.schema.json')
      expect(rpk.status).toBe('updated')
      const after = JSON.parse(fs.readFileSync(path.join(tempDir, 'rpk-overrides.schema.json'), 'utf8'))
      expect(after['$defs'].commandOverride.properties.seeAlso).toBeDefined()
    })

    it('--check reports drift without writing anything', () => {
      const destFile = path.join(tempDir, 'rpk-overrides.schema.json')

      const { results, drift } = syncSchemas({ destDir: tempDir, check: true })

      expect(drift).toBe(true)
      expect(results.find((r) => r.name === 'rpk-overrides.schema.json').status).toBe('created')
      expect(fs.existsSync(destFile)).toBe(false) // check mode never writes
    })

    it('defaults destDir to ./docs-data when not provided', () => {
      const { destDir } = syncSchemas({ destDir: undefined, check: true })
      expect(destDir).toBe(path.resolve('docs-data'))
    })

    it('never overwrites a destination that has content this package lacks (the asPartial near-miss, generalized)', () => {
      // Reproduces the real bug found while building this: the docs repo's
      // destination copy once documented a real field (asPartial) this
      // package's own schema copy didn't have yet -- since fixed on both
      // sides, so this test uses a synthetic stand-in field instead of
      // asPartial itself, to keep passing once the real fields agree again.
      // Built from the real shipped schema plus one synthetic
      // destination-only key, so this exercises syncSchemas' actual
      // package-reading path, not a mock of it.
      const realSchema = JSON.parse(fs.readFileSync(
        path.join(PACKAGE_SCHEMA_DIR, 'rpk-overrides.schema.json'), 'utf8'
      ))
      const diverged = JSON.parse(JSON.stringify(realSchema))
      diverged['$defs'].commandOverride.properties.__test_only_synthetic_field = { type: 'boolean' }

      const schemaFile = path.join(tempDir, 'rpk-overrides.schema.json')
      fs.mkdirSync(tempDir, { recursive: true })
      fs.writeFileSync(schemaFile, JSON.stringify(diverged))
      const before = fs.readFileSync(schemaFile, 'utf8')

      const { results, drift } = syncSchemas({ destDir: tempDir })

      expect(drift).toBe(true)
      const rpk = results.find((r) => r.name === 'rpk-overrides.schema.json')
      expect(rpk.status).toBe('diverged')
      expect(rpk.destOnlyPaths).toContain('$defs.commandOverride.properties.__test_only_synthetic_field')
      expect(fs.readFileSync(schemaFile, 'utf8')).toBe(before) // untouched
    })

    it('force overwrites a diverged destination when explicitly asked', () => {
      const realSchema = JSON.parse(fs.readFileSync(
        path.join(PACKAGE_SCHEMA_DIR, 'rpk-overrides.schema.json'), 'utf8'
      ))
      const diverged = JSON.parse(JSON.stringify(realSchema))
      diverged['$defs'].commandOverride.properties.__test_only_synthetic_field = { type: 'boolean' }

      const schemaFile = path.join(tempDir, 'rpk-overrides.schema.json')
      fs.mkdirSync(tempDir, { recursive: true })
      fs.writeFileSync(schemaFile, JSON.stringify(diverged))

      const { results } = syncSchemas({ destDir: tempDir, force: true })

      const rpk = results.find((r) => r.name === 'rpk-overrides.schema.json')
      expect(rpk.status).toBe('diverged')
      expect(fs.readFileSync(schemaFile, 'utf8')).toBe(fs.readFileSync(path.join(PACKAGE_SCHEMA_DIR, 'rpk-overrides.schema.json'), 'utf8'))
    })

    it('--check reports diverged without writing, even with force (check always wins)', () => {
      const realSchema = JSON.parse(fs.readFileSync(
        path.join(PACKAGE_SCHEMA_DIR, 'rpk-overrides.schema.json'), 'utf8'
      ))
      const diverged = JSON.parse(JSON.stringify(realSchema))
      diverged['$defs'].commandOverride.properties.__test_only_synthetic_field = { type: 'boolean' }

      const schemaFile = path.join(tempDir, 'rpk-overrides.schema.json')
      fs.mkdirSync(tempDir, { recursive: true })
      fs.writeFileSync(schemaFile, JSON.stringify(diverged))
      const before = fs.readFileSync(schemaFile, 'utf8')

      const { results } = syncSchemas({ destDir: tempDir, check: true, force: true })

      expect(results.find((r) => r.name === 'rpk-overrides.schema.json').status).toBe('diverged')
      expect(fs.readFileSync(schemaFile, 'utf8')).toBe(before)
    })
  })

  describe('findDestOnlyPaths', () => {
    it('returns an empty array when the destination has nothing the source lacks', () => {
      expect(findDestOnlyPaths({ a: { b: 1 } }, { a: { b: 2 } })).toEqual([])
    })

    it('finds a nested destination-only key', () => {
      expect(findDestOnlyPaths({ a: {} }, { a: { b: 1 } })).toEqual(['a.b'])
    })

    it('treats arrays as opaque leaves, not something to recurse into', () => {
      expect(findDestOnlyPaths({ a: [1, 2] }, { a: [1, 2, 3] })).toEqual([])
    })

    it('does not false-positive when source and destination are identical', () => {
      const shape = { a: { b: { c: [1, 2] } } }
      expect(findDestOnlyPaths(shape, JSON.parse(JSON.stringify(shape)))).toEqual([])
    })
  })
})
