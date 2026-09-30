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
    // The tree's 'create' node carries the same text as the override above,
    // so this fixture's prose fields classify REDUNDANT once a tree is given.
    const rpkExtracted = {
      tree: {
        name: 'rpk',
        commands: [
          {
            name: 'topic',
            commands: [
              {
                name: 'create',
                description: 'Create topics.',
                flags: [{ name: 'partitions', description: 'Number of partitions.' }]
              }
            ]
          }
        ]
      }
    }

    test('classifies matching prose as REDUNDANT and docs structure as KEEP', () => {
      const result = runAudit({
        overrides: writeFixture('rpk-overrides.json', rpkOverrides),
        extracted: writeFixture('rpk-extracted.json', rpkExtracted),
        surface: 'rpk'
      })

      const byKey = Object.fromEntries(result.manifest.map((row) => [`${row.name}|${row.field}`, row]))
      expect(byKey['rpk topic create|description'].class).toBe(CLASSES.REDUNDANT)
      expect(byKey['rpk topic create|description'].content_hash).toMatch(/^[0-9a-f]{16}$/)
      expect(byKey['rpk topic create --partitions|flags.description'].class).toBe(CLASSES.REDUNDANT)
      expect(byKey['rpk topic create|seeAlso'].class).toBe(CLASSES.KEEP)
      expect(byKey['rpk topic create|introducedInVersion'].class).toBe(CLASSES.KEEP)
      expect(byKey['rpk topic create|pageAliases'].class).toBe(CLASSES.KEEP)
      // Shared flag definitions aren't tied to one command's tree node, so
      // they stay REVIEW/TODO regardless of whether a tree was given.
      expect(byKey['definitions/common-tls-flags --tls-cert|flags.description'].class).toBe(CLASSES.REVIEW)
      expect(byKey['definitions/common-tls-flags --tls-cert|flags.description'].note).toContain('TODO')
    })

    test('command not found in the extracted tree stays REVIEW (existing behavior)', () => {
      const result = runAudit({
        overrides: writeFixture('rpk-overrides-stale.json', {
          commands: { 'rpk gone command': { description: 'Stale.' } }
        }),
        extracted: writeFixture('rpk-extracted.json', rpkExtracted),
        surface: 'rpk'
      })
      expect(result.manifest[0].class).toBe(CLASSES.REVIEW)
      expect(result.manifest[0].note).toContain('not found in the extracted rpk tree')
    })

    test('no --extracted at all stays REVIEW with the TODO note (existing behavior)', () => {
      const result = runAudit({
        overrides: writeFixture('rpk-overrides-no-tree.json', rpkOverrides),
        surface: 'rpk'
      })
      const byKey = Object.fromEntries(result.manifest.map((row) => [`${row.name}|${row.field}`, row]))
      expect(byKey['rpk topic create|description'].class).toBe(CLASSES.REVIEW)
      expect(byKey['rpk topic create|description'].note).toContain('TODO')
      expect(byKey['rpk topic create --partitions|flags.description'].class).toBe(CLASSES.REVIEW)
      expect(byKey['rpk topic create --partitions|flags.description'].note).toContain('TODO')
    })

    test('UPSTREAMABLE rows carry source_file/source_line when --locations resolves one', () => {
      const result = runAudit({
        overrides: writeFixture('rpk-overrides-diff.json', {
          commands: {
            'rpk topic create': {
              description: 'Create one or more topics.',
              flags: { partitions: { description: 'How many partitions to create.' } }
            }
          }
        }),
        extracted: writeFixture('rpk-extracted.json', rpkExtracted),
        locations: writeFixture('rpk-locations.json', {
          'rpk topic create': {
            description: { file: 'pkg/cli/topic/create.go', line: 40 },
            flags: { partitions: { file: 'pkg/cli/topic/create.go', line: 141 } }
          }
        }),
        surface: 'rpk'
      })
      const byKey = Object.fromEntries(result.manifest.map((row) => [`${row.name}|${row.field}`, row]))
      const desc = byKey['rpk topic create|description']
      expect(desc.class).toBe(CLASSES.UPSTREAMABLE)
      expect(desc.source_file).toBe('pkg/cli/topic/create.go')
      expect(desc.source_line).toBe(40)
      const flag = byKey['rpk topic create --partitions|flags.description']
      expect(flag.class).toBe(CLASSES.UPSTREAMABLE)
      expect(flag.source_file).toBe('pkg/cli/topic/create.go')
      expect(flag.source_line).toBe(141)
    })

    test('UPSTREAMABLE row with no matching location gets an explanatory note, not a guess', () => {
      const result = runAudit({
        overrides: writeFixture('rpk-overrides-diff2.json', {
          commands: { 'rpk topic create': { description: 'Create one or more topics.' } }
        }),
        extracted: writeFixture('rpk-extracted.json', rpkExtracted),
        locations: writeFixture('rpk-locations-empty.json', {}),
        surface: 'rpk'
      })
      const row = result.manifest[0]
      expect(row.class).toBe(CLASSES.UPSTREAMABLE)
      expect(row.source_file).toBeUndefined()
      expect(row.note).toContain('No static source location was found')
    })

    test('flag not found on an otherwise-found command stays REVIEW', () => {
      const result = runAudit({
        overrides: writeFixture('rpk-overrides-stale-flag.json', {
          commands: {
            'rpk topic create': { flags: { gone: { description: 'No longer exists.' } } }
          }
        }),
        extracted: writeFixture('rpk-extracted.json', rpkExtracted),
        surface: 'rpk'
      })
      expect(result.manifest[0].class).toBe(CLASSES.REVIEW)
      expect(result.manifest[0].note).toContain('Flag not found')
    })

    test('findCommandNode walks the tree by full command name', () => {
      expect(findCommandNode(rpkExtracted.tree, 'rpk topic create')).toBe(rpkExtracted.tree.commands[0].commands[0])
      expect(findCommandNode(rpkExtracted.tree, 'rpk topic delete')).toBeNull()
      expect(findCommandNode(rpkExtracted.tree, 'other root')).toBeNull()
    })

    describe('quality logic', () => {
      /**
       * Run the rpk audit with one command's description and (optionally)
       * flags against a matching extracted tree node, returning the
       * description row.
       *
       * @param {Object} opts - { overrideDescription, sourceDescription, textTransformations }.
       * @returns {Object} The 'rpk widget|description' manifest row.
       */
      function auditDescription ({ overrideDescription, sourceDescription, textTransformations }) {
        const overrides = {
          textTransformations: textTransformations || { replacements: [] },
          commands: {
            'rpk widget': { description: overrideDescription }
          }
        }
        const extracted = {
          tree: {
            name: 'rpk',
            commands: [{ name: 'widget', description: sourceDescription }]
          }
        }
        const result = runAudit({
          overrides: writeFixture('overrides.json', overrides),
          extracted: writeFixture('extracted.json', extracted),
          surface: 'rpk'
        })
        return result.manifest.find((row) => row.name === 'rpk widget' && row.field === 'description')
      }

      test('command description matching source after normalization is REDUNDANT', () => {
        const row = auditDescription({
          overrideDescription: 'Create  topics.',
          sourceDescription: 'Create topics.'
        })
        expect(row.class).toBe(CLASSES.REDUNDANT)
      })

      test('command description that differs and is markup-free is UPSTREAMABLE', () => {
        const row = auditDescription({
          overrideDescription: 'Creates one or more topics with the given configuration.',
          sourceDescription: 'Create topics.'
        })
        expect(row.class).toBe(CLASSES.UPSTREAMABLE)
        expect(row.upstream_candidate_text).toBe('Creates one or more topics with the given configuration.')
        expect(row.source_text).toBe('Create topics.')
      })

      test('command description with markup that strips to match source is KEEP', () => {
        const row = auditDescription({
          overrideDescription: 'List topics. See xref:manage:kafka.adoc[Kafka API docs].',
          sourceDescription: 'List topics. See Kafka API docs.'
        })
        expect(row.class).toBe(CLASSES.KEEP)
        expect(row.note).toContain('Markup-only enrichment')
      })

      test('command description with markup that still differs once stripped is KEEP_UNTIL_UPSTREAMED (SPLIT)', () => {
        const row = auditDescription({
          overrideDescription: 'List topics. See xref:manage:kafka.adoc[Kafka API docs].',
          sourceDescription: 'List all topics in the cluster.'
        })
        expect(row.class).toBe(CLASSES.KEEP_UNTIL_UPSTREAMED)
        expect(row.note).toMatch(/^SPLIT:/)
        expect(row.upstream_candidate_text).toBe('List topics. See Kafka API docs.')
        expect(row.source_text).toBe('List all topics in the cluster.')
      })

      test('only the mainDescription portion before an ALL-CAPS section header is compared', () => {
        const row = auditDescription({
          overrideDescription: 'List topics in a cluster.',
          sourceDescription: 'List topics in a cluster.\n\nFIELDS\nsome field docs here that describe columns'
        })
        // If the full raw text (including the FIELDS section body) were
        // compared instead of just parseDescriptionSections(...).mainDescription,
        // this would differ from the override and misclassify as UPSTREAMABLE.
        expect(row.class).toBe(CLASSES.REDUNDANT)
      })

      test('textTransformations must actually be applied for the comparison to be REDUNDANT', () => {
        const overrideDescription = 'Manage `rpk` ai connections.'
        const sourceDescription = 'Manage rpai connections.'

        const withoutTransform = auditDescription({ overrideDescription, sourceDescription, textTransformations: { replacements: [] } })
        expect(withoutTransform.class).not.toBe(CLASSES.REDUNDANT)

        const withTransform = auditDescription({
          overrideDescription,
          sourceDescription,
          textTransformations: { replacements: [{ pattern: 'rpai', replacement: 'rpk ai', flags: 'g' }] }
        })
        expect(withTransform.class).toBe(CLASSES.REDUNDANT)
      })

      test('flag description REDUNDANT and UPSTREAMABLE cases', () => {
        const redundantOverrides = {
          textTransformations: { replacements: [] },
          commands: {
            'rpk topic create': { flags: { partitions: { description: 'Number of partitions.' } } }
          }
        }
        const upstreamableOverrides = {
          textTransformations: { replacements: [] },
          commands: {
            'rpk topic create': { flags: { partitions: { description: 'Number of partitions to create for this topic.' } } }
          }
        }
        const extracted = {
          tree: {
            name: 'rpk',
            commands: [
              {
                name: 'topic',
                commands: [
                  {
                    name: 'create',
                    flags: [{ name: 'partitions', description: 'Number of partitions.' }]
                  }
                ]
              }
            ]
          }
        }

        const redundantResult = runAudit({
          overrides: writeFixture('flag-redundant.json', redundantOverrides),
          extracted: writeFixture('flag-extracted.json', extracted),
          surface: 'rpk'
        })
        const redundantRow = redundantResult.manifest.find((row) => row.field === 'flags.description')
        expect(redundantRow.class).toBe(CLASSES.REDUNDANT)

        const upstreamableResult = runAudit({
          overrides: writeFixture('flag-upstreamable.json', upstreamableOverrides),
          extracted: writeFixture('flag-extracted.json', extracted),
          surface: 'rpk'
        })
        const upstreamableRow = upstreamableResult.manifest.find((row) => row.field === 'flags.description')
        expect(upstreamableRow.class).toBe(CLASSES.UPSTREAMABLE)
        expect(upstreamableRow.upstream_candidate_text).toBe('Number of partitions to create for this topic.')
        expect(upstreamableRow.source_text).toBe('Number of partitions.')
      })
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
