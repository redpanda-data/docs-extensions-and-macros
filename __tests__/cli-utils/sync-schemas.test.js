'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const { listPackageSchemas, syncSchemas, findDestOnlyPaths, dataFileFor, PACKAGE_SCHEMA_DIR } = require('../../cli-utils/sync-schemas')

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
      // A schema is only synced into a destination that is plausibly its home:
      // one that already has the schema, or has the *.json it documents. These
      // cases are about sync behaviour, so give the destination the data files
      // and let the applicability rule have its own describe block below.
      for (const { name } of listPackageSchemas()) {
        fs.writeFileSync(path.join(tempDir, name.replace(/\.schema\.json$/, '.json')), '{}')
      }
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

    it('treats a cosmetic reformat (different indentation, no data change) as unchanged, not drift', () => {
      // Reproduces a real false-positive: a content repo's own prettier or
      // editorconfig reformats the synced JSON on save, with zero semantic
      // change. Raw-string comparison would misclassify that as 'updated'
      // (or fail --check) on every single run.
      syncSchemas({ destDir: tempDir }) // first sync creates every schema as an exact copy

      const schemaFile = path.join(tempDir, 'rpk-overrides.schema.json')
      const realSchema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'))
      const reformatted = JSON.stringify(realSchema, null, 4) // package ships 2-space
      fs.writeFileSync(schemaFile, reformatted)

      const { results, drift } = syncSchemas({ destDir: tempDir })

      expect(drift).toBe(false)
      const rpk = results.find((r) => r.name === 'rpk-overrides.schema.json')
      expect(rpk.status).toBe('unchanged')
      expect(fs.readFileSync(schemaFile, 'utf8')).toBe(reformatted) // left untouched
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

  describe('applicability: a schema only goes where its data file lives', () => {
    let tempDir

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-schemas-na-'))
    })

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true })
    })

    it('skips a schema whose data file the destination does not have', () => {
      // kapa-source-groups.json is generated into this package and read from
      // node_modules by an Antora extension, so it never lives in a content
      // repo. Copying its schema into redpanda-data/docs would leave a file
      // describing data that repo will never have.
      const { results, drift } = syncSchemas({ destDir: tempDir })

      expect(results.every((r) => r.status === 'not-applicable')).toBe(true)
      for (const { name } of listPackageSchemas()) {
        expect(fs.existsSync(path.join(tempDir, name))).toBe(false)
      }
      // And it must not read as drift, or `--check` fails forever on a repo
      // that is correctly not hosting that schema.
      expect(drift).toBe(false)
    })

    it('--check agrees, and exits clean', () => {
      const { results, drift } = syncSchemas({ destDir: tempDir, check: true })
      expect(results.every((r) => r.status === 'not-applicable')).toBe(true)
      expect(drift).toBe(false)
    })

    it('syncs a schema once the destination has the data file it documents', () => {
      const schema = listPackageSchemas()[0]
      fs.writeFileSync(path.join(tempDir, dataFileFor(schema.name)), '{}')

      const { results } = syncSchemas({ destDir: tempDir })

      expect(results.find((r) => r.name === schema.name).status).toBe('created')
      expect(fs.existsSync(path.join(tempDir, schema.name))).toBe(true)
      // The others are still not this repo's business.
      expect(results.filter((r) => r.name !== schema.name).every((r) => r.status === 'not-applicable')).toBe(true)
    })

    it('keeps an already-present schema up to date even with no data file', () => {
      // A repo can legitimately carry the schema before creating the data
      // file, or generate that data at build time. Once the schema is there,
      // it is this repo's and stays current.
      const schema = listPackageSchemas()[0]
      // An empty object, so the package copy is a strict superset and this is
      // an ordinary update rather than a divergence.
      fs.writeFileSync(path.join(tempDir, schema.name), '{}')

      const { results, drift } = syncSchemas({ destDir: tempDir })

      expect(results.find((r) => r.name === schema.name).status).toBe('updated')
      expect(drift).toBe(true)
      expect(fs.readFileSync(path.join(tempDir, schema.name), 'utf8'))
        .toBe(fs.readFileSync(schema.sourcePath, 'utf8'))
    })

    it('still refuses a diverged schema it is keeping up to date', () => {
      // Applicability decides whether the schema belongs here at all. It does
      // not override the superset rule that protects destination-only content.
      const schema = listPackageSchemas()[0]
      fs.writeFileSync(path.join(tempDir, schema.name), '{"aFieldOnlyTheRepoKnows": true}')

      const { results } = syncSchemas({ destDir: tempDir })
      const row = results.find((r) => r.name === schema.name)

      expect(row.status).toBe('diverged')
      expect(row.destOnlyPaths).toEqual(['aFieldOnlyTheRepoKnows'])
      expect(JSON.parse(fs.readFileSync(path.join(tempDir, schema.name), 'utf8')).aFieldOnlyTheRepoKnows).toBe(true)
    })
  })

  describe('dataFileFor', () => {
    it('maps a schema name to the data file it documents', () => {
      expect(dataFileFor('property-overrides.schema.json')).toBe('property-overrides.json')
      expect(dataFileFor('rpk-overrides.schema.json')).toBe('rpk-overrides.json')
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

    describe('oneOf/anyOf/allOf, the one array shape that is not opaque', () => {
      // JSON Schema combinators hold real, named schema objects as array
      // ELEMENTS -- see_also.items.oneOf[1].properties.cloud_only is
      // exactly the "destination-only capability" this function exists to
      // find, and it lives inside an array. Without index-matching into
      // oneOf/anyOf/allOf specifically, a destination-only audience flag
      // there was invisible to this function, and a write-mode sync would
      // delete it silently.
      it('finds a destination-only property inside a oneOf array element', () => {
        const source = { oneOf: [{ type: 'string' }, { type: 'object', properties: { content: {} } }] }
        const dest = { oneOf: [{ type: 'string' }, { type: 'object', properties: { content: {}, cloud_only: { const: true } } }] }
        expect(findDestOnlyPaths(source, dest)).toEqual(['oneOf[1].properties.cloud_only'])
      })

      it('recurses the same way for anyOf and allOf', () => {
        expect(findDestOnlyPaths({ anyOf: [{ properties: {} }] }, { anyOf: [{ properties: { x: {} } }] }))
          .toEqual(['anyOf[0].properties.x'])
        expect(findDestOnlyPaths({ allOf: [{ properties: {} }] }, { allOf: [{ properties: { x: {} } }] }))
          .toEqual(['allOf[0].properties.x'])
      })

      it('reports a whole destination-only array element when source has fewer', () => {
        const source = { oneOf: [{ type: 'string' }] }
        const dest = { oneOf: [{ type: 'string' }, { type: 'object', properties: { x: {} } }] }
        expect(findDestOnlyPaths(source, dest)).toEqual(['oneOf[1]'])
      })

      it('reports nothing when both sides carry the same combinator content', () => {
        const shape = { oneOf: [{ type: 'string' }, { type: 'object', properties: { cloud_only: { const: true } } }] }
        expect(findDestOnlyPaths(shape, JSON.parse(JSON.stringify(shape)))).toEqual([])
      })

      it('still treats a non-combinator array (required, enum) as opaque', () => {
        // The general rule is unchanged: only oneOf/anyOf/allOf recurse.
        expect(findDestOnlyPaths({ required: ['a'] }, { required: ['a', 'b'] })).toEqual([])
        expect(findDestOnlyPaths({ enum: [1, 2] }, { enum: [1, 2, 3] })).toEqual([])
      })
    })
  })
})
