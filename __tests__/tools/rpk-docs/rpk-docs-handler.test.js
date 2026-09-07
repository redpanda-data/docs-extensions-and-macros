'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

// Only prepareSourceFromRef's and downloadRpkRelease's tests below use this;
// every other spawnSync call in this module (docker-based builds) is
// exercised by no test here, so auto-mocking child_process at the module
// boundary doesn't change behavior for the rest of the suite. Must be
// mocked before the handler module below is required: it destructures
// spawnSync from child_process at load time, so a later jest.spyOn on the
// child_process export would not reach that already-bound local reference.
jest.mock('child_process')
const { spawnSync } = require('child_process')

const {
  updateOverridesWithIntroducedVersions,
  isPluginStampAttributable,
  attributablePluginSet,
  pluginManifestVersionsCache,
  detectLinuxOnlyFromSource,
  addPlatformMarkersFromSource,
  countCommands,
  getRequiredGoVersion,
  prepareSourceFromRef,
  downloadRpkRelease
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
      // Clean up temp directory and all contents
      fs.rmSync(tempDir, { recursive: true, force: true })
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

      test('stamps plugin commands with the plugin version, core commands with the rpk version', () => {
        fs.writeFileSync(overridesPath, JSON.stringify({ commands: {} }))

        const diffData = {
          summary: { newCommands: 2 },
          details: {
            newCommands: [
              { path: 'rpk connect new-subcommand' },
              { path: 'rpk cluster new-command' }
            ],
            newFlags: [
              { commandPath: 'rpk connect run', flagName: 'new-flag' }
            ],
            removedCommands: [],
            removedFlags: [],
            changedDefaults: []
          }
        }

        updateOverridesWithIntroducedVersions(diffData, overridesPath, 'v26.2.0', { connect: '4.103.0' })

        const result = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
        expect(result.commands['rpk connect new-subcommand'].introducedInVersion).toBe('4.103.0')
        expect(result.commands['rpk cluster new-command'].introducedInVersion).toBe('v26.2.0')
        expect(result.commands['rpk connect run'].flags['new-flag'].introducedInVersion).toBe('4.103.0')
      })
    })

    describe('introduction-version attribution', () => {
      // Mirrors a real incident: 30 rpk ai commands shipped in 0.2.26 and
      // 0.2.28 were stamped "introduced in 0.2.32" because the baseline
      // snapshot was several plugin releases stale.
      afterEach(() => pluginManifestVersionsCache.clear())

      test('skips plugin entries when the plugin is not attributable, stamps core', () => {
        fs.writeFileSync(overridesPath, JSON.stringify({ commands: {} }))

        const diffData = {
          summary: { newCommands: 2 },
          details: {
            newCommands: [
              { path: 'rpk ai policy create' },
              { path: 'rpk cluster new-command' }
            ],
            newFlags: [{ commandPath: 'rpk ai policy', flagName: 'new-flag' }],
            removedCommands: [],
            removedFlags: [],
            changedDefaults: []
          }
        }

        updateOverridesWithIntroducedVersions(diffData, overridesPath, 'v26.2.1', { ai: '0.2.32' }, {
          attributablePlugins: []
        })

        const result = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
        expect(result.commands['rpk ai policy create']).toBeUndefined()
        expect(result.commands['rpk ai policy']).toBeUndefined()
        expect(result.commands['rpk cluster new-command'].introducedInVersion).toBe('v26.2.1')
      })

      test('stamps plugin entries when the plugin is attributable', () => {
        fs.writeFileSync(overridesPath, JSON.stringify({ commands: {} }))

        const diffData = {
          summary: { newCommands: 1 },
          details: {
            newCommands: [{ path: 'rpk ai policy create' }],
            newFlags: [],
            removedCommands: [],
            removedFlags: [],
            changedDefaults: []
          }
        }

        updateOverridesWithIntroducedVersions(diffData, overridesPath, 'v26.2.1', { ai: '0.2.32' }, {
          attributablePlugins: ['ai']
        })

        const result = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
        expect(result.commands['rpk ai policy create'].introducedInVersion).toBe('0.2.32')
      })

      test('isPluginStampAttributable requires a manifest-adjacent baseline', () => {
        pluginManifestVersionsCache.set('ai', ['0.2.30', '0.2.31', '0.2.32'])
        expect(isPluginStampAttributable('ai', '0.2.31', '0.2.32')).toBe(true)
        expect(isPluginStampAttributable('ai', '0.2.32', '0.2.32')).toBe(true)
        // A gap means intermediate releases may own the "new" commands
        expect(isPluginStampAttributable('ai', '0.2.30', '0.2.32')).toBe(false)
        // Unknown baseline can never be attributed
        expect(isPluginStampAttributable('ai', undefined, '0.2.32')).toBe(false)
      })

      test('attributablePluginSet evaluates each plugin independently', () => {
        pluginManifestVersionsCache.set('ai', ['0.2.31', '0.2.32'])
        pluginManifestVersionsCache.set('connect', ['4.101.0', '4.102.0', '4.103.1'])
        const set = attributablePluginSet(
          { ai: '0.2.31', connect: '4.101.0' },
          { ai: '0.2.32', connect: '4.103.1' }
        )
        expect(set.has('ai')).toBe(true)
        expect(set.has('connect')).toBe(false)
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

  describe('getRequiredGoVersion', () => {
    let tempDir

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-go-version-test-'))
    })

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true })
    })

    test('returns version from go.mod — drives golang:<version> image selection', () => {
      fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module example.com/rpk\n\ngo 1.26.4\n')
      const version = getRequiredGoVersion(tempDir)
      expect(version).toBe('1.26.4')
      // Caller uses: requiredGoVersion ? `golang:${requiredGoVersion}` : 'golang:1'
      const goImage = version ? `golang:${version}` : 'golang:1'
      expect(goImage).toBe('golang:1.26.4')
    })

    test('returns null when go.mod is absent — drives golang:1 fallback', () => {
      const version = getRequiredGoVersion(tempDir)
      expect(version).toBeNull()
      const goImage = version ? `golang:${version}` : 'golang:1'
      expect(goImage).toBe('golang:1')
    })

    test('returns null when go.mod has no go directive', () => {
      fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module example.com/rpk\n')
      expect(getRequiredGoVersion(tempDir)).toBeNull()
    })

    test('handles two-part go version (no patch)', () => {
      fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module example.com/rpk\n\ngo 1.26\n')
      expect(getRequiredGoVersion(tempDir)).toBe('1.26')
    })
  })

  describe('prepareSourceFromRef (sparse-clone of the private streaming-enterprise repo)', () => {
    const TOKEN_VARS = ['GIT_CREDENTIALS', 'REDPANDA_GITHUB_TOKEN', 'ACTIONS_BOT_TOKEN', 'GITHUB_TOKEN', 'VBOT_GITHUB_API_TOKEN', 'GH_TOKEN']
    const savedEnv = {}

    beforeEach(() => {
      spawnSync.mockReset()
      for (const name of TOKEN_VARS) {
        savedEnv[name] = process.env[name]
        delete process.env[name]
      }
    })

    afterEach(() => {
      for (const name of TOKEN_VARS) {
        if (savedEnv[name] === undefined) delete process.env[name]
        else process.env[name] = savedEnv[name]
      }
    })

    test('throws a clear error when there is no token, without spawning git', () => {
      expect(() => prepareSourceFromRef('dev')).toThrow(/streaming-enterprise is a private repository/)
      expect(spawnSync).not.toHaveBeenCalled()
    })

    test('sparse-clones streaming-enterprise with the same credential helper on the clone and the sparse-checkout set', () => {
      process.env.GH_TOKEN = 'test-token-456'
      spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' })

      expect(() => prepareSourceFromRef('v26.2.0')).not.toThrow()
      expect(spawnSync).toHaveBeenCalledTimes(2)

      const [cloneCmd, cloneArgs, cloneOptions] = spawnSync.mock.calls[0]
      expect(cloneCmd).toBe('git')
      expect(cloneArgs).toEqual(expect.arrayContaining([
        'clone', '--branch', 'v26.2.0', 'https://github.com/redpanda-data/streaming-enterprise.git'
      ]))
      // The token must never appear in argv -- it travels through env-only
      // git config (a credential helper) instead of a -c argument.
      expect(cloneArgs.join(' ')).not.toContain('test-token-456')
      expect(cloneArgs.some((a) => a.includes('extraheader'))).toBe(false)
      expect(cloneOptions.env.RPK_SOURCE_CLONE_TOKEN).toBe('test-token-456')
      expect(cloneOptions.env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper')
      expect(cloneOptions.env.GIT_CONFIG_VALUE_1).toContain('$RPK_SOURCE_CLONE_TOKEN')

      const [sparseCmd, sparseArgs, sparseOptions] = spawnSync.mock.calls[1]
      expect(sparseCmd).toBe('git')
      expect(sparseArgs).toEqual(expect.arrayContaining(['sparse-checkout', 'set', 'src/go/rpk']))
      expect(sparseArgs.some((a) => a.includes('extraheader'))).toBe(false)
      // Same credential helper env on the follow-up invocation: with
      // --filter=blob:none, the rpk blobs are fetched lazily here, not by
      // the clone above.
      expect(sparseOptions.env.GIT_CONFIG_VALUE_1).toBe(cloneOptions.env.GIT_CONFIG_VALUE_1)
      expect(sparseOptions.env.RPK_SOURCE_CLONE_TOKEN).toBe('test-token-456')
    })

    test('surfaces a clear error when the clone itself fails', () => {
      process.env.GH_TOKEN = 'test-token-456'
      spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'fatal: repository not found' })

      expect(() => prepareSourceFromRef('nonexistent-ref')).toThrow(/Failed to clone streaming-enterprise repo/)
    })
  })

  describe('downloadRpkRelease (private streaming-enterprise release assets)', () => {
    const TOKEN_VARS = ['GIT_CREDENTIALS', 'REDPANDA_GITHUB_TOKEN', 'ACTIONS_BOT_TOKEN', 'GITHUB_TOKEN', 'VBOT_GITHUB_API_TOKEN', 'GH_TOKEN']
    const savedEnv = {}
    let tempDir

    beforeEach(() => {
      spawnSync.mockReset()
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-release-test-'))
      for (const name of TOKEN_VARS) {
        savedEnv[name] = process.env[name]
        delete process.env[name]
      }
    })

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true })
      for (const name of TOKEN_VARS) {
        if (savedEnv[name] === undefined) delete process.env[name]
        else process.env[name] = savedEnv[name]
      }
    })

    test('returns null without spawning curl when there is no token', () => {
      expect(downloadRpkRelease('v26.2.2', tempDir)).toBeNull()
      expect(spawnSync).not.toHaveBeenCalled()
    })

    test('resolves the asset through the release-by-tag API, never the browser download URL', () => {
      process.env.GH_TOKEN = 'test-token-789'
      // Release lookup succeeds (status 0); the actual asset download can
      // fail (status 1) without affecting what this test inspects.
      const osName = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform]
      const archName = { arm64: 'arm64', x64: 'amd64' }[process.arch]
      const assetName = `rpk-${osName}-${archName}.zip`
      const checksumAsset = 'rpk_26.2.2_checksums.txt'
      const release = {
        assets: [
          { name: assetName, url: 'https://api.github.com/repos/redpanda-data/streaming-enterprise/releases/assets/111' },
          { name: checksumAsset, url: 'https://api.github.com/repos/redpanda-data/streaming-enterprise/releases/assets/222' }
        ]
      }
      spawnSync
        .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(release), stderr: '' }) // release lookup
        .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not found' }) // asset download

      expect(downloadRpkRelease('v26.2.2', tempDir)).toBeNull()
      expect(spawnSync).toHaveBeenCalledTimes(2)

      const [lookupCmd, lookupArgs, lookupOpts] = spawnSync.mock.calls[0]
      expect(lookupCmd).toBe('curl')
      // The token must never appear in curl's argv (readable via ps//proc
      // while the transfer runs); it travels as a config file on stdin.
      expect(lookupArgs.join(' ')).not.toContain('test-token-789')
      expect(lookupArgs).toEqual(expect.arrayContaining(['--config', '-']))
      expect(lookupOpts.input).toBe('header = "Authorization: token test-token-789"')
      expect(lookupArgs.some((a) => typeof a === 'string' &&
        a === 'https://api.github.com/repos/redpanda-data/streaming-enterprise/releases/tags/v26.2.2')).toBe(true)

      const [dlCmd, dlArgs, dlOpts] = spawnSync.mock.calls[1]
      expect(dlCmd).toBe('curl')
      // The API's per-asset url (not the releases/download/... browser url,
      // which 404s for a private repo even with a valid token) is what
      // accepts the Authorization header.
      expect(dlArgs.join(' ')).not.toContain('test-token-789')
      expect(dlArgs).toEqual(expect.arrayContaining([
        '--config', '-',
        '-H', 'Accept: application/octet-stream'
      ]))
      expect(dlOpts.input).toBe('header = "Authorization: token test-token-789"')
      expect(dlArgs.some((a) => a === 'https://api.github.com/repos/redpanda-data/streaming-enterprise/releases/assets/111')).toBe(true)
      expect(dlArgs.some((a) => typeof a === 'string' && a.includes('releases/download/'))).toBe(false)
    })
  })
})
