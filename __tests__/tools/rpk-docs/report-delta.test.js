'use strict'

const {
  generateRpkDiff,
  printDiffReport,
  generateMarkdownSummary,
  flattenToMap,
  getFlagsMap,
  compareFlags
} = require('../../../tools/rpk-docs/report-delta.js')

describe('rpk Docs Diff Generation', () => {
  describe('flattenToMap', () => {
    test('flattens nested command tree to map', () => {
      const tree = {
        name: 'rpk',
        description: 'Root',
        commands: [
          {
            name: 'topic',
            description: 'Topic commands',
            commands: [
              { name: 'create', description: 'Create topic', commands: [] }
            ]
          }
        ]
      }

      const map = flattenToMap(tree)
      expect(map.size).toBe(3)
      expect(map.has('rpk')).toBe(true)
      expect(map.has('rpk topic')).toBe(true)
      expect(map.has('rpk topic create')).toBe(true)
    })

    test('handles empty commands array', () => {
      const tree = { name: 'rpk', description: 'Root', commands: [] }
      const map = flattenToMap(tree)
      expect(map.size).toBe(1)
    })

    test('handles missing commands property', () => {
      const tree = { name: 'rpk', description: 'Root' }
      const map = flattenToMap(tree)
      expect(map.size).toBe(1)
    })
  })

  describe('getFlagsMap', () => {
    test('returns map of flags by name', () => {
      const command = {
        flags: [
          { name: 'verbose', type: 'bool' },
          { name: 'output', type: 'string' }
        ]
      }

      const map = getFlagsMap(command)
      expect(map.size).toBe(2)
      expect(map.get('verbose').type).toBe('bool')
      expect(map.get('output').type).toBe('string')
    })

    test('returns empty map for missing flags', () => {
      const command = {}
      const map = getFlagsMap(command)
      expect(map.size).toBe(0)
    })
  })

  describe('compareFlags', () => {
    test('detects type change', () => {
      const oldFlag = { name: 'count', type: 'int' }
      const newFlag = { name: 'count', type: 'int32' }
      const changes = compareFlags(oldFlag, newFlag)
      expect(changes.type).toEqual({ old: 'int', new: 'int32' })
    })

    test('detects default change', () => {
      const oldFlag = { name: 'count', default: 1 }
      const newFlag = { name: 'count', default: 10 }
      const changes = compareFlags(oldFlag, newFlag)
      expect(changes.default).toEqual({ old: 1, new: 10 })
    })

    test('detects description change', () => {
      const oldFlag = { name: 'count', description: 'Old desc' }
      const newFlag = { name: 'count', description: 'New desc' }
      const changes = compareFlags(oldFlag, newFlag)
      expect(changes.description).toEqual({ old: 'Old desc', new: 'New desc' })
    })

    test('returns null for identical flags', () => {
      const flag = { name: 'count', type: 'int', default: 1 }
      const changes = compareFlags(flag, flag)
      expect(changes).toBeNull()
    })

    test('treats objects with same keys in different order as equal', () => {
      const oldFlag = { name: 'config', default: { a: 1, b: 2 } }
      const newFlag = { name: 'config', default: { b: 2, a: 1 } }
      const changes = compareFlags(oldFlag, newFlag)
      expect(changes).toBeNull()
    })

    test('detects actual object differences regardless of key order', () => {
      const oldFlag = { name: 'config', default: { a: 1, b: 2 } }
      const newFlag = { name: 'config', default: { b: 3, a: 1 } }
      const changes = compareFlags(oldFlag, newFlag)
      expect(changes.default).toEqual({ old: { a: 1, b: 2 }, new: { b: 3, a: 1 } })
    })
  })

  describe('generateRpkDiff', () => {
    const oldTree = {
      name: 'rpk',
      description: 'Root',
      commands: [
        {
          name: 'topic',
          description: 'Topic commands',
          flags: [{ name: 'verbose', type: 'bool', default: false }],
          commands: [
            {
              name: 'create',
              description: 'Create topic',
              flags: [{ name: 'partitions', type: 'int', default: 1 }],
              commands: []
            },
            {
              name: 'delete',
              description: 'Delete topic',
              flags: [],
              commands: []
            }
          ]
        }
      ]
    }

    const newTree = {
      name: 'rpk',
      description: 'Root',
      commands: [
        {
          name: 'topic',
          description: 'Topic commands updated',
          flags: [{ name: 'verbose', type: 'bool', default: false }],
          commands: [
            {
              name: 'create',
              description: 'Create topic',
              flags: [
                { name: 'partitions', type: 'int32', default: 1 },
                { name: 'replication', type: 'int', default: 3 }
              ],
              commands: []
            },
            {
              name: 'list',
              description: 'List topics',
              flags: [],
              commands: []
            }
          ]
        }
      ]
    }

    test('detects new commands', () => {
      const diff = generateRpkDiff(oldTree, newTree, { oldVersion: 'v1', newVersion: 'v2' })
      expect(diff.summary.newCommands).toBe(1)
      expect(diff.details.newCommands[0].path).toBe('rpk topic list')
    })

    test('detects removed commands', () => {
      const diff = generateRpkDiff(oldTree, newTree, { oldVersion: 'v1', newVersion: 'v2' })
      expect(diff.summary.removedCommands).toBe(1)
      expect(diff.details.removedCommands[0].path).toBe('rpk topic delete')
    })

    test('detects new flags', () => {
      const diff = generateRpkDiff(oldTree, newTree, { oldVersion: 'v1', newVersion: 'v2' })
      expect(diff.summary.newFlags).toBe(1)
      expect(diff.details.newFlags[0].flagName).toBe('replication')
    })

    test('detects description changes', () => {
      const diff = generateRpkDiff(oldTree, newTree, { oldVersion: 'v1', newVersion: 'v2' })
      expect(diff.summary.descriptionChanges).toBe(1)
      expect(diff.details.descriptionChanges[0].path).toBe('rpk topic')
    })

    test('includes version info', () => {
      const diff = generateRpkDiff(oldTree, newTree, { oldVersion: 'v1.0.0', newVersion: 'v2.0.0' })
      expect(diff.comparison.oldVersion).toBe('v1.0.0')
      expect(diff.comparison.newVersion).toBe('v2.0.0')
      expect(diff.comparison.timestamp).toBeDefined()
    })
  })

  describe('generateMarkdownSummary', () => {
    test('generates markdown table', () => {
      const diff = {
        comparison: { oldVersion: 'v1', newVersion: 'v2' },
        summary: {
          newCommands: 2,
          removedCommands: 1,
          newFlags: 3,
          removedFlags: 0,
          changedDefaults: 1
        },
        details: {
          newCommands: [
            { path: 'rpk topic list' },
            { path: 'rpk topic describe' }
          ],
          removedCommands: [{ path: 'rpk topic old' }],
          newFlags: [],
          removedFlags: [],
          changedDefaults: []
        }
      }

      const markdown = generateMarkdownSummary(diff)
      expect(markdown).toContain('## rpk Documentation Changes')
      expect(markdown).toContain('v1 → v2')
      expect(markdown).toContain('| New commands | 2 |')
      expect(markdown).toContain('`rpk topic list`')
      expect(markdown).toContain('~~`rpk topic old`~~')
    })

    test('skips empty sections', () => {
      const diff = {
        comparison: { oldVersion: 'v1', newVersion: 'v2' },
        summary: {
          newCommands: 0,
          removedCommands: 0,
          newFlags: 0,
          removedFlags: 0,
          changedDefaults: 0
        },
        details: {
          newCommands: [],
          removedCommands: [],
          newFlags: [],
          removedFlags: [],
          changedDefaults: []
        }
      }

      const markdown = generateMarkdownSummary(diff)
      expect(markdown).not.toContain('### New Commands')
      expect(markdown).not.toContain('### Removed Commands')
    })

    test('truncates long flag lists', () => {
      const manyFlags = Array.from({ length: 25 }, (_, i) => ({
        commandPath: 'rpk topic',
        flagName: `flag${i}`,
        type: 'string'
      }))

      const diff = {
        comparison: { oldVersion: 'v1', newVersion: 'v2' },
        summary: {
          newCommands: 0,
          removedCommands: 0,
          newFlags: 25,
          removedFlags: 0,
          changedDefaults: 0
        },
        details: {
          newCommands: [],
          removedCommands: [],
          newFlags: manyFlags,
          removedFlags: [],
          changedDefaults: []
        }
      }

      const markdown = generateMarkdownSummary(diff)
      expect(markdown).toContain('25 new flags added')
      expect(markdown).toContain('See diff JSON for details')
    })
  })

  describe('printDiffReport', () => {
    test('prints to console without error', () => {
      const diff = {
        comparison: { oldVersion: 'v1', newVersion: 'v2', timestamp: '2026-06-01T00:00:00Z' },
        summary: {
          newCommands: 1,
          removedCommands: 0,
          newFlags: 2,
          removedFlags: 0,
          changedDefaults: 0,
          descriptionChanges: 0
        },
        details: {
          newCommands: [{ path: 'rpk topic list', description: 'List topics' }],
          removedCommands: [],
          newFlags: [
            { commandPath: 'rpk topic', flagName: 'output', type: 'string' }
          ],
          removedFlags: [],
          changedDefaults: [],
          descriptionChanges: []
        }
      }

      // Should not throw
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
      printDiffReport(diff)
      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })
})
