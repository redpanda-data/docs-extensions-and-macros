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
        prop_redundant: { name: 'prop_redundant', description: 'Same text.', type: 'string', defined_in: 'src/v/config/configuration.cc' },
        prop_upstreamable: { name: 'prop_upstreamable', description: 'Old text.', type: 'string', defined_in: 'src/v/config/configuration.cc' }
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

  describe('rpk surface (structural)', () => {
    const rpkOverrides = {
      $schema: './rpk-overrides.schema.json',
      _notes: { ignored: 'yes' },
      textTransformations: { replacements: [] },
      definitions: {
        'common-tls-flags': {
          'tls-cert': { description: 'Path to the TLS certificate.' }
        }
      },
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
    const rpkExtracted = {
      tree: {
        name: 'rpk',
        commands: [
          { name: 'topic', commands: [{ name: 'create' }] }
        ]
      }
    }

    test('enumerates prose fields as REVIEW-TODO and docs structure as KEEP', () => {
      const result = runAudit({
        overrides: writeFixture('rpk-overrides.json', rpkOverrides),
        extracted: writeFixture('rpk-extracted.json', rpkExtracted),
        surface: 'rpk'
      })

      const byKey = Object.fromEntries(result.manifest.map((row) => [`${row.name}|${row.field}`, row]))
      expect(byKey['rpk topic create|description'].class).toBe(CLASSES.REVIEW)
      expect(byKey['rpk topic create|description'].note).toContain('TODO')
      expect(byKey['rpk topic create|description'].content_hash).toMatch(/^[0-9a-f]{16}$/)
      expect(byKey['rpk topic create --partitions|flags.description'].class).toBe(CLASSES.REVIEW)
      expect(byKey['rpk topic create|seeAlso'].class).toBe(CLASSES.KEEP)
      expect(byKey['rpk topic create|introducedInVersion'].class).toBe(CLASSES.KEEP)
      expect(byKey['rpk topic create|pageAliases'].class).toBe(CLASSES.KEEP)
      expect(byKey['definitions/common-tls-flags --tls-cert|flags.description'].class).toBe(CLASSES.REVIEW)
    })

    test('flags overrides for commands missing from the extracted tree', () => {
      const result = runAudit({
        overrides: writeFixture('rpk-overrides-stale.json', {
          commands: { 'rpk gone command': { description: 'Stale.' } }
        }),
        extracted: writeFixture('rpk-extracted.json', rpkExtracted),
        surface: 'rpk'
      })
      expect(result.manifest[0].note).toContain('not found in the extracted rpk tree')
    })

    test('findCommandNode walks the tree by full command name', () => {
      expect(findCommandNode(rpkExtracted.tree, 'rpk topic create')).toEqual({ name: 'create' })
      expect(findCommandNode(rpkExtracted.tree, 'rpk topic delete')).toBeNull()
      expect(findCommandNode(rpkExtracted.tree, 'other root')).toBeNull()
    })
  })

  describe('connect surface (structural)', () => {
    const connectOverrides = {
      definitions: {
        batching: { description: 'Configure a xref:configuration:batching.adoc[batching policy].' }
      },
      inputs: [
        {
          name: 'amqp_0_9',
          summary: 'Connects to AMQP.',
          config: {
            children: [
              { name: 'urls', description: 'A list of URLs.' },
              { name: 'batching', $ref: '#/definitions/batching' },
              {
                name: 'queue_declare',
                children: [{ name: 'auto_delete', description: 'Whether the queue auto-deletes.' }]
              }
            ]
          }
        },
        { name: 'jira', version: '4.100.0' }
      ]
    }

    test('enumerates definitions, summaries, and nested config descriptions', () => {
      const result = runAudit({
        overrides: writeFixture('connect-overrides.json', connectOverrides),
        surface: 'connect'
      })

      const byKey = Object.fromEntries(result.manifest.map((row) => [`${row.name}|${row.field}`, row]))
      expect(byKey['definitions/batching|description'].class).toBe(CLASSES.REVIEW)
      expect(byKey['inputs/amqp_0_9|summary'].class).toBe(CLASSES.REVIEW)
      expect(byKey['inputs/amqp_0_9/urls|config.description'].class).toBe(CLASSES.REVIEW)
      expect(byKey['inputs/amqp_0_9/queue_declare/auto_delete|config.description'].class).toBe(CLASSES.REVIEW)
      expect(byKey['inputs/amqp_0_9/batching|config.$ref'].class).toBe(CLASSES.KEEP)
      expect(byKey['inputs/jira|version'].class).toBe(CLASSES.KEEP)
    })
  })
})
