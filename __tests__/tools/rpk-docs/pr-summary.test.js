'use strict'

const { generatePRSummary } = require('../../../tools/rpk-docs/rpk-docs-handler.js')

describe('generatePRSummary change reporting', () => {
  const baseOptions = {
    rpkVersion: 'v2.0.0',
    commandCount: 100,
    filesGenerated: 100,
    outputDir: 'modules/reference/pages/rpk'
  }

  const diffWith = (summary, details) => ({
    comparison: { oldVersion: 'v1.0.0', newVersion: 'v2.0.0' },
    summary: {
      newCommands: 0,
      removedCommands: 0,
      newFlags: 0,
      removedFlags: 0,
      changedDefaults: 0,
      changedFlagTypes: 0,
      changedFlagRequirements: 0,
      changedFlagDescriptions: 0,
      descriptionChanges: 0,
      ...summary
    },
    details: {
      newCommands: [],
      removedCommands: [],
      newFlags: [],
      removedFlags: [],
      changedDefaults: [],
      changedFlagTypes: [],
      changedFlagRequirements: [],
      changedFlagDescriptions: [],
      descriptionChanges: [],
      ...details
    }
  })

  test('renders changed flag defaults with values', () => {
    const summary = generatePRSummary({
      ...baseOptions,
      diffData: diffWith(
        { changedDefaults: 1 },
        { changedDefaults: [{ commandPath: 'rpk topic create', flagName: 'timeout', oldDefault: '5s', newDefault: '30s' }] }
      )
    })
    expect(summary).toContain('| Changed flag defaults | 1 |')
    expect(summary).toContain('`--timeout` default `5s` → `30s`')
  })

  test('renders array defaults as JSON', () => {
    const summary = generatePRSummary({
      ...baseOptions,
      diffData: diffWith(
        { changedDefaults: 1 },
        { changedDefaults: [{ commandPath: 'rpk x', flagName: 'brokers', oldDefault: ['a'], newDefault: ['b'] }] }
      )
    })
    expect(summary).toContain('["b"]')
    expect(summary).not.toContain('[object Object]')
  })

  test('renders command description changes using the correct field name', () => {
    const summary = generatePRSummary({
      ...baseOptions,
      diffData: diffWith(
        { descriptionChanges: 2 },
        { descriptionChanges: [{ path: 'rpk topic' }, { path: 'rpk cluster' }] }
      )
    })
    expect(summary).toContain('| Changed command descriptions | 2 |')
    expect(summary).toContain('`rpk topic`')
  })

  test('defaults-only changes do not report "no changes"', () => {
    const summary = generatePRSummary({
      ...baseOptions,
      diffData: diffWith(
        { changedDefaults: 1 },
        { changedDefaults: [{ commandPath: 'rpk x', flagName: 'y', oldDefault: 1, newDefault: 2 }] }
      )
    })
    expect(summary).not.toContain('No command, flag, or default changes detected.')
  })

  test('reports no changes when the diff is empty', () => {
    const summary = generatePRSummary({ ...baseOptions, diffData: diffWith({}, {}) })
    expect(summary).toContain('No command, flag, or default changes detected.')
  })

  test('lists removed flags and flag type changes', () => {
    const summary = generatePRSummary({
      ...baseOptions,
      diffData: diffWith(
        { removedFlags: 1, changedFlagTypes: 1 },
        {
          removedFlags: [{ commandPath: 'rpk topic create', flagName: 'legacy' }],
          changedFlagTypes: [{ commandPath: 'rpk topic create', flagName: 'partitions', oldType: 'int', newType: 'int32' }]
        }
      )
    })
    expect(summary).toContain('Removed Flags')
    expect(summary).toContain('`--legacy`')
    expect(summary).toContain('type `int` → `int32`')
  })

  test('renders deprecated commands when present', () => {
    const summary = generatePRSummary({
      ...baseOptions,
      diffData: diffWith(
        { newlyDeprecatedCommands: 1 },
        { newlyDeprecatedCommands: [{ path: 'rpk redpanda admin', message: 'use rpk cluster instead', hidden: true }] }
      )
    })
    expect(summary).toContain('| Deprecated commands | 1 |')
    expect(summary).toContain('use rpk cluster instead')
    expect(summary).toContain('_(hidden from help output)_')
  })
})

describe('computeDescriptionCoverage', () => {
  const { computeDescriptionCoverage } = require('../../../tools/rpk-docs/rpk-docs-handler.js')

  const tree = {
    name: 'rpk',
    commands: [
      { name: 'group', description: 'x'.repeat(2000), commands: [] },
      { name: 'version', description: 'Prints the version.', commands: [] }
    ]
  }

  test('flags overrides that hide substantially longer source help', () => {
    const overrides = { commands: {
      'rpk group': { description: 'Manage groups.' },
      'rpk version': { description: 'Print version info.' }
    } }
    const result = computeDescriptionCoverage(tree, overrides)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ commandPath: 'rpk group', sourceChars: 2000 })
  })

  test('ignores overrides without descriptions and unknown commands', () => {
    const overrides = { commands: {
      'rpk group': { flags: {} },
      'rpk nonexistent': { description: 'x' }
    } }
    expect(computeDescriptionCoverage(tree, overrides)).toEqual([])
  })
})
