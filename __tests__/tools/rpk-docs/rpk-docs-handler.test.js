'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const {
  updateOverridesWithIntroducedVersions,
  detectLinuxOnlyFromSource,
  addPlatformMarkersFromSource,
  countCommands
} = require('../../../tools/rpk-docs/rpk-docs-handler.js')

describe('rpk Docs Handler', () => {
  describe('updateOverridesWithIntroducedVersions', () => {
    let tempDir
    let overridesPath

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-handler-test-'))
      overridesPath = path.join(tempDir, 'overrides.json')
    })

    afterEach(() => {
      // Clean up temp files
      if (fs.existsSync(overridesPath)) {
        fs.unlinkSync(overridesPath)
      }
      fs.rmdirSync(tempDir)
    })

    describe('command version tracking', () => {
      test('adds introducedInVersion for new commands', () => {
        // Start with empty overrides file
        fs.writeFileSync(overridesPath, JSON.stringify({ commands: {} }))

        const diffData = {
          summary: { newCommands: 1 },
          details: {
            newCommands: [{ path: 'rpk topic new-command' }],
            newFlags: [],
            removedCommands: [],
            removedFlags: [],
            changedDefaults: []
          }
        }

        updateOverridesWithIntroducedVersions(diffData, overridesPath, 'v26.2.0')

        const result = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
        expect(result.commands['rpk topic new-command']).toBeDefined()
        expect(result.commands['rpk topic new-command'].introducedInVersion).toBe('v26.2.0')
      })

      test('does not overwrite existing introducedInVersion for commands', () => {
        // Start with existing version
        fs.writeFileSync(overridesPath, JSON.stringify({
          commands: {
            'rpk topic existing': {
              introducedInVersion: 'v26.1.0'
            }
          }
        }))

        const diffData = {
          summary: { newCommands: 1 },
          details: {
            newCommands: [{ path: 'rpk topic existing' }],
            newFlags: [],
            removedCommands: [],
            removedFlags: [],
            changedDefaults: []
          }
        }

        updateOverridesWithIntroducedVersions(diffData, overridesPath, 'v26.2.0')

        const result = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
        expect(result.commands['rpk topic existing'].introducedInVersion).toBe('v26.1.0')
      })
    })

    describe('flag version tracking', () => {
      test('adds introducedInVersion for new flags', () => {
        fs.writeFileSync(overridesPath, JSON.stringify({ commands: {} }))

        const diffData = {
          summary: { newFlags: 1 },
          details: {
            newCommands: [],
            newFlags: [
              { commandPath: 'rpk topic create', flagName: 'new-flag' }
            ],
            removedCommands: [],
            removedFlags: [],
            changedDefaults: []
          }
        }

        updateOverridesWithIntroducedVersions(diffData, overridesPath, 'v26.2.0')

        const result = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
        expect(result.commands['rpk topic create']).toBeDefined()
        expect(result.commands['rpk topic create'].flags).toBeDefined()
        expect(result.commands['rpk topic create'].flags['new-flag']).toBeDefined()
        expect(result.commands['rpk topic create'].flags['new-flag'].introducedInVersion).toBe('v26.2.0')
      })

      test('adds multiple new flags to same command', () => {
        fs.writeFileSync(overridesPath, JSON.stringify({ commands: {} }))

        const diffData = {
          summary: { newFlags: 2 },
          details: {
            newCommands: [],
            newFlags: [
              { commandPath: 'rpk topic create', flagName: 'flag-a' },
              { commandPath: 'rpk topic create', flagName: 'flag-b' }
            ],
            removedCommands: [],
            removedFlags: [],
            changedDefaults: []
          }
        }

        updateOverridesWithIntroducedVersions(diffData, overridesPath, 'v26.2.0')

        const result = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
        expect(result.commands['rpk topic create'].flags['flag-a'].introducedInVersion).toBe('v26.2.0')
        expect(result.commands['rpk topic create'].flags['flag-b'].introducedInVersion).toBe('v26.2.0')
      })

      test('adds flags to different commands', () => {
        fs.writeFileSync(overridesPath, JSON.stringify({ commands: {} }))

        const diffData = {
          summary: { newFlags: 2 },
          details: {
            newCommands: [],
            newFlags: [
              { commandPath: 'rpk topic create', flagName: 'partitions' },
              { commandPath: 'rpk topic delete', flagName: 'force' }
            ],
            removedCommands: [],
            removedFlags: [],
            changedDefaults: []
          }
        }

        updateOverridesWithIntroducedVersions(diffData, overridesPath, 'v26.2.0')

        const result = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
        expect(result.commands['rpk topic create'].flags['partitions'].introducedInVersion).toBe('v26.2.0')
        expect(result.commands['rpk topic delete'].flags['force'].introducedInVersion).toBe('v26.2.0')
      })

      test('does not overwrite existing flag introducedInVersion', () => {
        fs.writeFileSync(overridesPath, JSON.stringify({
          commands: {
            'rpk topic create': {
              flags: {
                'existing-flag': {
                  introducedInVersion: 'v26.1.0',
                  description: 'Custom description'
                }
              }
            }
          }
        }))

        const diffData = {
          summary: { newFlags: 1 },
          details: {
            newCommands: [],
            newFlags: [
              { commandPath: 'rpk topic create', flagName: 'existing-flag' }
            ],
            removedCommands: [],
            removedFlags: [],
            changedDefaults: []
          }
        }

        updateOverridesWithIntroducedVersions(diffData, overridesPath, 'v26.2.0')

        const result = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
        expect(result.commands['rpk topic create'].flags['existing-flag'].introducedInVersion).toBe('v26.1.0')
        expect(result.commands['rpk topic create'].flags['existing-flag'].description).toBe('Custom description')
      })

      test('preserves existing flag properties when adding introducedInVersion', () => {
        fs.writeFileSync(overridesPath, JSON.stringify({
          commands: {
            'rpk topic create': {
              flags: {
                'some-flag': {
                  description: 'Preserved description',
                  type: 'string'
                }
              }
            }
          }
        }))

        const diffData = {
          summary: { newFlags: 1 },
          details: {
            newCommands: [],
            newFlags: [
              { commandPath: 'rpk topic create', flagName: 'some-flag' }
            ],
            removedCommands: [],
            removedFlags: [],
            changedDefaults: []
          }
        }

        updateOverridesWithIntroducedVersions(diffData, overridesPath, 'v26.2.0')

        const result = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
        expect(result.commands['rpk topic create'].flags['some-flag'].introducedInVersion).toBe('v26.2.0')
        expect(result.commands['rpk topic create'].flags['some-flag'].description).toBe('Preserved description')
        expect(result.commands['rpk topic create'].flags['some-flag'].type).toBe('string')
      })

      test('does not modify file when no new commands or flags', () => {
        const initialContent = JSON.stringify({ commands: { existing: {} } })
        fs.writeFileSync(overridesPath, initialContent)

        const diffData = {
          summary: { newCommands: 0, newFlags: 0 },
          details: {
            newCommands: [],
            newFlags: [],
            removedCommands: [],
            removedFlags: [],
            changedDefaults: []
          }
        }

        updateOverridesWithIntroducedVersions(diffData, overridesPath, 'v26.2.0')

        // File should be unchanged
        const result = fs.readFileSync(overridesPath, 'utf8')
        expect(result).toBe(initialContent)
      })

      test('handles both new commands and new flags in same diff', () => {
        fs.writeFileSync(overridesPath, JSON.stringify({ commands: {} }))

        const diffData = {
          summary: { newCommands: 1, newFlags: 1 },
          details: {
            newCommands: [{ path: 'rpk new command' }],
            newFlags: [
              { commandPath: 'rpk topic create', flagName: 'new-flag' }
            ],
            removedCommands: [],
            removedFlags: [],
            changedDefaults: []
          }
        }

        updateOverridesWithIntroducedVersions(diffData, overridesPath, 'v26.2.0')

        const result = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
        expect(result.commands['rpk new command'].introducedInVersion).toBe('v26.2.0')
        expect(result.commands['rpk topic create'].flags['new-flag'].introducedInVersion).toBe('v26.2.0')
      })
    })

    describe('file handling', () => {
      test('creates commands object if missing', () => {
        fs.writeFileSync(overridesPath, JSON.stringify({}))

        const diffData = {
          summary: { newFlags: 1 },
          details: {
            newCommands: [],
            newFlags: [
              { commandPath: 'rpk topic', flagName: 'test-flag' }
            ],
            removedCommands: [],
            removedFlags: [],
            changedDefaults: []
          }
        }

        updateOverridesWithIntroducedVersions(diffData, overridesPath, 'v26.2.0')

        const result = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
        expect(result.commands).toBeDefined()
        expect(result.commands['rpk topic'].flags['test-flag'].introducedInVersion).toBe('v26.2.0')
      })

      test('creates overrides file if missing', () => {
        // Don't create the file - it shouldn't exist
        expect(fs.existsSync(overridesPath)).toBe(false)

        const diffData = {
          summary: { newFlags: 1 },
          details: {
            newCommands: [],
            newFlags: [
              { commandPath: 'rpk topic', flagName: 'test-flag' }
            ],
            removedCommands: [],
            removedFlags: [],
            changedDefaults: []
          }
        }

        updateOverridesWithIntroducedVersions(diffData, overridesPath, 'v26.2.0')

        expect(fs.existsSync(overridesPath)).toBe(true)
        const result = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
        expect(result.commands['rpk topic'].flags['test-flag'].introducedInVersion).toBe('v26.2.0')
      })
    })
  })

  describe('addPlatformMarkersFromSource', () => {
    test('marks commands based on provided Linux-only set', () => {
      const tree = {
        name: 'rpk',
        commands: [
          { name: 'topic' },
          { name: 'redpanda', commands: [{ name: 'tune' }] }
        ]
      }
      const linuxOnly = new Set(['rpk redpanda tune'])

      const result = addPlatformMarkersFromSource(tree, linuxOnly)
      const topic = result.commands.find(c => c.name === 'topic')
      const redpanda = result.commands.find(c => c.name === 'redpanda')
      const tune = redpanda.commands.find(c => c.name === 'tune')

      expect(topic.platforms).toEqual(['linux', 'darwin'])
      expect(tune.platforms).toEqual(['linux']) // Linux-only
    })

    test('marks all commands cross-platform when no Linux-only set', () => {
      const tree = {
        name: 'rpk',
        commands: [{ name: 'topic' }, { name: 'cluster' }]
      }
      const linuxOnly = new Set()

      const result = addPlatformMarkersFromSource(tree, linuxOnly)
      expect(result.commands[0].platforms).toEqual(['linux', 'darwin'])
      expect(result.commands[1].platforms).toEqual(['linux', 'darwin'])
    })

    test('handles nested Linux-only commands', () => {
      const tree = {
        name: 'rpk',
        commands: [{ name: 'iotune' }]
      }
      const linuxOnly = new Set(['rpk iotune'])

      const result = addPlatformMarkersFromSource(tree, linuxOnly)
      expect(result.linux_only_commands).toContain('rpk iotune')
      expect(result.commands[0].platforms).toEqual(['linux'])
    })
  })

  describe('countCommands', () => {
    test('counts nested commands', () => {
      const tree = {
        name: 'rpk',
        commands: [
          {
            name: 'topic',
            commands: [
              { name: 'create', commands: [] },
              { name: 'delete', commands: [] }
            ]
          },
          { name: 'cluster', commands: [] }
        ]
      }

      expect(countCommands(tree)).toBe(5) // rpk, topic, create, delete, cluster
    })

    test('counts single command', () => {
      const tree = { name: 'rpk' }
      expect(countCommands(tree)).toBe(1)
    })

    test('handles empty commands array', () => {
      const tree = { name: 'rpk', commands: [] }
      expect(countCommands(tree)).toBe(1)
    })
  })
})
