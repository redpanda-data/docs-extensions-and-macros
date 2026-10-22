'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const { runAudit, formatHumanReport } = require('../../../tools/overrides-audit')
const { CLASSES } = require('../../../tools/overrides-audit/classify')
const { findCommandNode } = require('../../../tools/overrides-audit/adapters/rpk')

describe('overrides-audit adapters', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overrides-audit-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /**
   * Write a JSON fixture into the test tmp dir.
   *
   * @param {string} name - File name.
   * @param {Object} data - JSON content.
   * @returns {string} Absolute path.
   */
  function writeFixture (name, data) {
    const filePath = path.join(tmpDir, name)
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    return filePath
  }

  describe('properties surface', () => {
    const extracted = {
      properties: {
        // line_start is what says the source has a description to replace; without
        // it the audit correctly reports there is nothing to upstream into.
        prop_redundant: { name: 'prop_redundant', description: 'Same text.', type: 'string', defined_in: 'src/v/config/configuration.cc', line_start: 10 },
        prop_upstreamable: { name: 'prop_upstreamable', description: 'Old text.', type: 'string', defined_in: 'src/v/config/configuration.cc', line_start: 20 }
      }
    }
    const overrides = {
      properties: {
        prop_redundant: { description: 'Same  text.' },
        prop_upstreamable: { description: 'New text.', config_scope: 'cluster' }
      }
    }

    test('classifies against files and cross-checks with compare-properties', () => {
      const result = runAudit({
        overrides: writeFixture('overrides.json', overrides),
        extracted: writeFixture('extracted.json', extracted),
        surface: 'properties'
      })

      expect(result.surface).toBe('properties')
      expect(result.summary.byClass[CLASSES.REDUNDANT]).toBe(1)
      expect(result.summary.byClass[CLASSES.UPSTREAMABLE]).toBe(1)
      expect(result.summary.byClass[CLASSES.KEEP]).toBe(1)
      // The raw-equality cross-check must agree with the classifier
      expect(result.cross_check.violations).toEqual([])
      // prop_upstreamable's description is genuinely changed by the override
      expect(result.cross_check.changedDescriptions).toBe(2)

      const report = formatHumanReport(result)
      expect(report).toContain('Classified 3 override field(s)')
      expect(report).toContain('consistency: OK')
    })

    test('rejects overrides files without a properties object', () => {
      expect(() => runAudit({
        overrides: writeFixture('bad-overrides.json', { nope: {} }),
        extracted: writeFixture('extracted.json', extracted)
      })).toThrow(/no top-level "properties" object/)
    })

    test('requires --extracted for the properties surface', () => {
      expect(() => runAudit({
        overrides: writeFixture('overrides.json', overrides)
      })).toThrow(/--extracted/)
    })

    test('rejects unknown surfaces', () => {
      expect(() => runAudit({ overrides: 'x.json', surface: 'metrics' })).toThrow(/Unknown surface/)
    })
  })

  describe('rpk surface', () => {
    // Prose classification is covered in rpk-adapter.test.js; this checks
    // the adapter is wired through runAudit like the properties surface.
    const rpkOverrides = {
      $schema: './rpk-overrides.schema.json',
      textTransformations: { replacements: [] },
      definitions: { 'common-tls-flags': { 'tls-cert': { description: 'Path to the TLS certificate.' } } },
      commands: {
        'rpk topic create': {
          description: 'Create topics.',
          flags: { partitions: { description: 'Number of partitions.' } },
          seeAlso: [{ content: 'xref:x.adoc[Topics]' }],
          introducedInVersion: '23.2.1',
          pageAliases: ['old-page.adoc']
        }
      }
    }
    const rpkSnapshot = {
      rpk_version: 'v1.0.0',
      raw_tree: {
        name: 'rpk',
        commands: [
          { name: 'topic', commands: [{ name: 'create', description: 'Create topics', flags: [{ name: 'partitions', description: 'Number of partitions' }] }] }
        ]
      },
      tree: { name: 'rpk', commands: [] }
    }

    test('classifies prose against raw_tree and docs structure as KEEP', () => {
      const result = runAudit({
        overrides: writeFixture('rpk-overrides.json', rpkOverrides),
        extracted: writeFixture('rpk-v1.0.0.json', rpkSnapshot),
        surface: 'rpk'
      })

      const byKey = Object.fromEntries(result.manifest.map((row) => [`${row.name}|${row.field}`, row]))
      // Only the formatter's trailing period differs: redundant.
      expect(byKey['rpk topic create|description'].class).toBe(CLASSES.REDUNDANT)
      expect(byKey['rpk topic create|description'].content_hash).toMatch(/^[0-9a-f]{16}$/)
      expect(byKey['rpk topic create --partitions|flags.description'].class).toBe(CLASSES.REDUNDANT)
      expect(byKey['rpk topic create|seeAlso'].class).toBe(CLASSES.KEEP)
      expect(byKey['rpk topic create|introducedInVersion'].class).toBe(CLASSES.KEEP)
      expect(byKey['rpk topic create|pageAliases'].class).toBe(CLASSES.KEEP)
      expect(byKey['definitions/common-tls-flags --tls-cert|flags.description'].class).toBe(CLASSES.KEEP)
      expect(result.cross_check.violations).toEqual([])
      expect(formatHumanReport(result)).toContain('surface: rpk')
    })

    test('flags overrides for commands missing from raw_tree', () => {
      const result = runAudit({
        overrides: writeFixture('rpk-overrides-stale.json', { commands: { 'rpk gone command': { description: 'Stale.' } } }),
        extracted: writeFixture('rpk-v1.0.0.json', rpkSnapshot),
        surface: 'rpk'
      })
      expect(result.manifest[0].class).toBe(CLASSES.REVIEW)
      expect(result.manifest[0].note).toContain("not found in the snapshot's raw_tree")
    })

    test('findCommandNode walks the tree by full command name', () => {
      expect(findCommandNode(rpkSnapshot.raw_tree, 'rpk topic create').name).toBe('create')
      expect(findCommandNode(rpkSnapshot.raw_tree, 'rpk topic delete')).toBeNull()
      expect(findCommandNode(rpkSnapshot.raw_tree, 'other root')).toBeNull()
    })
  })

  describe('retired connect surface', () => {
    // Connect descriptions come from the connect and benthos specs, so there
    // is no Connect overrides file to audit.
    test('connect is rejected as an unknown surface', () => {
      expect(() => runAudit({ overrides: writeFixture('connect-overrides.json', { inputs: [] }), surface: 'connect' }))
        .toThrow("Unknown surface 'connect'. Valid surfaces: properties, rpk")
    })
  })
})
