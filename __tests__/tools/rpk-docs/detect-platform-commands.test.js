'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  detectLinuxOnlyFromSource,
  findLinuxConstrainedFiles,
  warnIfDetectionLooksBroken,
  fileBuildsOn,
  goosFromFileName,
  evaluateBuildExpr,
  evaluatePlusBuildLines,
  parseConstructors,
  parseAddCommandRefs
} = require('../../../tools/rpk-docs/detect-platform-commands.js')

const { addPlatformMarkersFromSource } = require('../../../tools/rpk-docs/rpk-docs-handler.js')

/**
 * Write a synthetic source tree: {relativePath: content} pairs
 */
function writeSourceTree(root, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relPath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content)
  }
}

describe('detect-platform-commands', () => {
  let tempDir

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-platform-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('goosFromFileName', () => {
    test('detects GOOS suffix', () => {
      expect(goosFromFileName('redpanda_darwin.go')).toBe('darwin')
      expect(goosFromFileName('bundle_linux.go')).toBe('linux')
      expect(goosFromFileName('root_windows.go')).toBe('windows')
    })

    test('detects GOOS_GOARCH suffix', () => {
      expect(goosFromFileName('cpu_linux_arm64.go')).toBe('linux')
    })

    test('GOARCH alone does not constrain the OS', () => {
      expect(goosFromFileName('cpu_arm64.go')).toBeNull()
    })

    test('non-GOOS words after underscore are not constraints', () => {
      expect(goosFromFileName('bundle_all.go')).toBeNull()
      expect(goosFromFileName('bundle_k8s.go')).toBeNull()
      expect(goosFromFileName('start.go')).toBeNull()
    })

    test('embedded GOOS word only counts as trailing suffix', () => {
      // bundle_k8s_linux.go -> linux; linux_thing.go -> no constraint
      expect(goosFromFileName('bundle_k8s_linux.go')).toBe('linux')
      expect(goosFromFileName('linux_thing.go')).toBeNull()
    })
  })

  describe('evaluateBuildExpr', () => {
    test('plain GOOS tag', () => {
      expect(evaluateBuildExpr('linux', 'linux')).toBe(true)
      expect(evaluateBuildExpr('linux', 'darwin')).toBe(false)
      expect(evaluateBuildExpr('darwin', 'darwin')).toBe(true)
    })

    test('negation', () => {
      expect(evaluateBuildExpr('!linux', 'darwin')).toBe(true)
      expect(evaluateBuildExpr('!linux', 'linux')).toBe(false)
    })

    test('boolean operators and parentheses', () => {
      expect(evaluateBuildExpr('linux || darwin', 'darwin')).toBe(true)
      expect(evaluateBuildExpr('linux && amd64', 'linux')).toBe(true)
      expect(evaluateBuildExpr('linux && amd64', 'darwin')).toBe(false)
      expect(evaluateBuildExpr('(linux || darwin) && !windows', 'linux')).toBe(true)
    })

    test('unix matches both linux and darwin', () => {
      expect(evaluateBuildExpr('unix', 'linux')).toBe(true)
      expect(evaluateBuildExpr('unix', 'darwin')).toBe(true)
    })

    test('unknown custom tags are unset by default', () => {
      expect(evaluateBuildExpr('withasan', 'linux')).toBe(false)
      expect(evaluateBuildExpr('!integration', 'linux')).toBe(true)
    })
  })

  describe('evaluatePlusBuildLines', () => {
    test('single OS', () => {
      expect(evaluatePlusBuildLines(['linux'], 'linux')).toBe(true)
      expect(evaluatePlusBuildLines(['linux'], 'darwin')).toBe(false)
    })

    test('space is OR, comma is AND, lines are AND', () => {
      expect(evaluatePlusBuildLines(['linux darwin'], 'darwin')).toBe(true)
      expect(evaluatePlusBuildLines(['linux,amd64'], 'linux')).toBe(true)
      expect(evaluatePlusBuildLines(['linux', '!darwin'], 'linux')).toBe(true)
      expect(evaluatePlusBuildLines(['linux', 'darwin'], 'linux')).toBe(false)
    })
  })

  describe('fileBuildsOn', () => {
    test('combines filename suffix and explicit tag', () => {
      expect(fileBuildsOn('foo_linux.go', 'package foo\n', 'linux')).toBe(true)
      expect(fileBuildsOn('foo_linux.go', 'package foo\n', 'darwin')).toBe(false)
      expect(fileBuildsOn('foo.go', '//go:build linux\n\npackage foo\n', 'darwin')).toBe(false)
      expect(fileBuildsOn('foo.go', 'package foo\n', 'darwin')).toBe(true)
    })

    test('build tags after the package clause are ignored', () => {
      const content = 'package foo\n\n// mentions //go:build linux in a comment\n'
      expect(fileBuildsOn('foo.go', content, 'darwin')).toBe(true)
    })
  })

  describe('parseConstructors', () => {
    test('extracts Use name and exclusion markers', () => {
      const content = `package redpanda

func NewCommand(fs afero.Fs) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "redpanda",
		Short: "Interact with a local Redpanda process",
	}
	return cmd
}

func NewAdminCommand(fs afero.Fs) *cobra.Command {
	return &cobra.Command{
		Use:        "admin",
		Hidden:     true,
		Deprecated: "use rpk cluster",
	}
}
`
      const ctors = parseConstructors(content)
      expect(ctors.NewCommand.useName).toBe('redpanda')
      expect(ctors.NewCommand.excluded).toBe(false)
      expect(ctors.NewAdminCommand.useName).toBe('admin')
      expect(ctors.NewAdminCommand.excluded).toBe(true)
    })

    test('takes only the first token of a Use line with arguments', () => {
      const content = `package foo
func NewCommand() *cobra.Command {
	return &cobra.Command{Use: "create [TOPIC]..."}
}
`
      expect(parseConstructors(content).NewCommand.useName).toBe('create')
    })
  })

  describe('parseAddCommandRefs', () => {
    test('captures qualified and unqualified constructor calls', () => {
      const content = `package cli
func addCmds(cmd *cobra.Command) {
	cmd.AddCommand(
		redpanda.NewCommand(fs, p, rp.NewLauncher()),
		iotune.NewCommand(fs, p),
		NewStartCommand(fs, p),
	)
}
`
      const refs = parseAddCommandRefs(content)
      const asStrings = refs.map(r => `${r.qualifier || ''}.${r.funcName}`)
      expect(asStrings).toContain('redpanda.NewCommand')
      expect(asStrings).toContain('iotune.NewCommand')
      expect(asStrings).toContain('.NewStartCommand')
    })
  })

  describe('detectLinuxOnlyFromSource', () => {
    /**
     * Synthetic source tree replicating the modern rpk layout
     * (pkg/cli/<command>/) and its platform-gating patterns as of
     * v26.2.1-rc2, including the dual-registration redpanda pattern.
     */
    const modernFixture = {
      'cmd/rpk/main.go': 'package main\n\nfunc main() {}\n',
      'pkg/cli/root.go': `package cli

func Execute() {
	root := &cobra.Command{Use: "rpk"}
	root.AddCommand(
		topic.NewCommand(fs, p),
		debug.NewCommand(fs, p),
	)
	addPlatformDependentCmds(fs, p, root)
}
`,
      // Filename-implied linux constraint (no explicit tag), like real rpk
      'pkg/cli/root_linux.go': `package cli

func addPlatformDependentCmds(fs afero.Fs, p *config.Params, cmd *cobra.Command) {
	cmd.AddCommand(
		redpanda.NewCommand(fs, p, rp.NewLauncher()),
		iotune.NewCommand(fs, p),
	)

	// deprecated
	cmd.AddCommand(
		newConfigCommand(fs, p),
		newTuneCommand(fs, p),
	)
}

func newConfigCommand(fs afero.Fs, p *config.Params) *cobra.Command {
	return cobraext.DeprecateCmd(redpanda.NewConfigCommand(fs, p), "rpk redpanda config")
}

func newTuneCommand(fs afero.Fs, p *config.Params) *cobra.Command {
	return cobraext.DeprecateCmd(tune.NewCommand(fs, p), "rpk redpanda tune")
}
`,
      'pkg/cli/root_darwin.go': `package cli

func addPlatformDependentCmds(fs afero.Fs, p *config.Params, cmd *cobra.Command) {
	cmd.AddCommand(redpanda.NewRedpandaDarwinCommand(fs, p))
}
`,
      'pkg/cli/topic/topic.go': `package topic

func NewCommand(fs afero.Fs, p *config.Params) *cobra.Command {
	return &cobra.Command{Use: "topic"}
}
`,
      // Dual registration: linux variant registers the full subtree
      'pkg/cli/redpanda/redpanda.go': `//go:build linux

package redpanda

func NewCommand(fs afero.Fs, p *config.Params, launcher rp.Launcher) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "redpanda",
		Short: "Interact with a local Redpanda process",
	}
	cmd.AddCommand(
		NewStartCommand(fs, p, launcher),
		NewStopCommand(fs, p),
		NewCheckCommand(fs, p),
		NewModeCommand(fs, p),
		NewConfigCommand(fs, p),

		tune.NewCommand(fs, p),
		// deprecated
		admin.NewCommand(fs, p),
	)
	return cmd
}
`,
      // ...while the darwin variant registers a reduced subtree
      'pkg/cli/redpanda/redpanda_darwin.go': `//go:build darwin

package redpanda

func NewRedpandaDarwinCommand(fs afero.Fs, p *config.Params) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "redpanda",
		Short: "Interact with a local or remote Redpanda process",
	}
	cmd.AddCommand(admin.NewCommand(fs, p))
	return cmd
}
`,
      'pkg/cli/redpanda/start.go': `//go:build linux

package redpanda

func NewStartCommand(fs afero.Fs, p *config.Params, launcher rp.Launcher) *cobra.Command {
	return &cobra.Command{Use: "start"}
}
`,
      'pkg/cli/redpanda/stop.go': `//go:build linux

package redpanda

func NewStopCommand(fs afero.Fs, p *config.Params) *cobra.Command {
	return &cobra.Command{Use: "stop"}
}
`,
      'pkg/cli/redpanda/check.go': `//go:build linux

package redpanda

func NewCheckCommand(fs afero.Fs, p *config.Params) *cobra.Command {
	return &cobra.Command{Use: "check"}
}
`,
      'pkg/cli/redpanda/mode.go': `//go:build linux

package redpanda

func NewModeCommand(fs afero.Fs, p *config.Params) *cobra.Command {
	return &cobra.Command{Use: "mode {development, production}"}
}
`,
      'pkg/cli/redpanda/config.go': `//go:build linux

package redpanda

func NewConfigCommand(fs afero.Fs, p *config.Params) *cobra.Command {
	return &cobra.Command{Use: "config"}
}
`,
      // Hidden + deprecated command, present on both platforms
      'pkg/cli/redpanda/admin/admin.go': `package admin

func NewCommand(fs afero.Fs, p *config.Params) *cobra.Command {
	return &cobra.Command{
		Use:        "admin",
		Hidden:     true,
		Deprecated: "use rpk cluster subcommands",
	}
}
`,
      // Whole package Linux-gated
      'pkg/cli/redpanda/tune/tune.go': `//go:build linux

package tune

func NewCommand(fs afero.Fs, p *config.Params) *cobra.Command {
	return &cobra.Command{Use: "tune"}
}
`,
      'pkg/cli/redpanda/tune/list.go': `//go:build linux

package tune

func newListCommand(fs afero.Fs, p *config.Params) *cobra.Command {
	return &cobra.Command{Use: "list"}
}
`,
      // Whole package Linux-gated (explicit tag)
      'pkg/cli/iotune/iotune.go': `//go:build linux

package iotune

func NewCommand(fs afero.Fs, p *config.Params) *cobra.Command {
	return &cobra.Command{Use: "iotune"}
}
`,
      'pkg/cli/debug/debug.go': `package debug

func NewCommand(fs afero.Fs, p *config.Params) *cobra.Command {
	cmd := &cobra.Command{Use: "debug"}
	cmd.AddCommand(bundle.NewCommand(fs, p))
	return cmd
}
`,
      // Linux-gated implementation WITH a darwin-buildable counterpart:
      // the command exists on both platforms and must NOT be Linux-only
      'pkg/cli/debug/bundle/bundle.go': `//go:build linux

package bundle

func NewCommand(fs afero.Fs, p *config.Params) *cobra.Command {
	return &cobra.Command{Use: "bundle"}
}
`,
      'pkg/cli/debug/bundle/bundle_all.go': `//go:build !linux

package bundle

func NewCommand(fs afero.Fs, p *config.Params) *cobra.Command {
	return &cobra.Command{Use: "bundle"}
}
`,
      'pkg/cli/debug/bundle/bundle_k8s_linux.go': `//go:build linux

package bundle

func executeK8SBundle() error { return nil }
`
    }

    test('modern pkg/cli layout: detects whole-package and dual-registration gating', () => {
      writeSourceTree(tempDir, modernFixture)
      const result = detectLinuxOnlyFromSource(tempDir)

      expect([...result].sort()).toEqual([
        'rpk iotune',
        'rpk redpanda check',
        'rpk redpanda config',
        'rpk redpanda mode',
        'rpk redpanda start',
        'rpk redpanda stop',
        'rpk redpanda tune'
      ])
    })

    test('dual registration keeps shared commands cross-platform', () => {
      writeSourceTree(tempDir, modernFixture)
      const result = detectLinuxOnlyFromSource(tempDir)

      // rpk redpanda exists on darwin too (reduced variant)
      expect(result.has('rpk redpanda')).toBe(false)
      // Hidden/deprecated admin never shows in --print-tree; not a diff
      expect(result.has('rpk redpanda admin')).toBe(false)
      // Cross-platform commands are untouched
      expect(result.has('rpk topic')).toBe(false)
      expect(result.has('rpk debug')).toBe(false)
    })

    test('linux-gated file with a !linux counterpart is not Linux-only', () => {
      writeSourceTree(tempDir, modernFixture)
      const result = detectLinuxOnlyFromSource(tempDir)
      expect(result.has('rpk debug bundle')).toBe(false)
    })

    test('deprecated top-level aliases are not reported', () => {
      writeSourceTree(tempDir, modernFixture)
      const result = detectLinuxOnlyFromSource(tempDir)
      // root_linux.go registers deprecated (hidden) rpk config / rpk tune
      expect(result.has('rpk config')).toBe(false)
      expect(result.has('rpk tune')).toBe(false)
      // Non-command helper arguments are not misread as commands
      expect(result.has('rpk rp')).toBe(false)
    })

    test('_linux.go filename suffix counts as a Linux constraint', () => {
      writeSourceTree(tempDir, {
        'pkg/cli/root.go': 'package cli\n',
        'pkg/cli/foo/foo_linux.go': `package foo

func NewCommand(fs afero.Fs) *cobra.Command {
	return &cobra.Command{Use: "foo"}
}
`
      })
      const result = detectLinuxOnlyFromSource(tempDir)
      expect(result.has('rpk foo')).toBe(true)
    })

    test('legacy pkg/cli/cmd layout with +build tags', () => {
      writeSourceTree(tempDir, {
        'pkg/cli/cmd/root.go': 'package cmd\n',
        'pkg/cli/cmd/iotune/iotune.go': `// +build linux

package iotune

func NewCommand(fs afero.Fs) *cobra.Command {
	return &cobra.Command{Use: "iotune"}
}
`
      })
      const result = detectLinuxOnlyFromSource(tempDir)
      expect(result.has('rpk iotune')).toBe(true)
    })

    test('legacy cmd/rpk layout', () => {
      writeSourceTree(tempDir, {
        'cmd/rpk/main.go': 'package main\n\nfunc main() {}\n',
        'cmd/rpk/iotune/iotune.go': `//go:build linux

package iotune

func NewCommand(fs afero.Fs) *cobra.Command {
	return &cobra.Command{Use: "iotune"}
}
`
      })
      const result = detectLinuxOnlyFromSource(tempDir)
      expect(result.has('rpk iotune')).toBe(true)
    })

    test('descendants of a Linux-only package are collapsed into the root path', () => {
      writeSourceTree(tempDir, modernFixture)
      const result = detectLinuxOnlyFromSource(tempDir)
      // rpk redpanda tune list is implied by rpk redpanda tune
      expect(result.has('rpk redpanda tune list')).toBe(false)
    })

    test('returns empty set for a source tree with no platform gating', () => {
      writeSourceTree(tempDir, {
        'pkg/cli/root.go': 'package cli\n',
        'pkg/cli/topic/topic.go': `package topic

func NewCommand(fs afero.Fs) *cobra.Command {
	return &cobra.Command{Use: "topic"}
}
`
      })
      expect(detectLinuxOnlyFromSource(tempDir).size).toBe(0)
    })

    test('missing scan roots return an empty set without throwing', () => {
      expect(detectLinuxOnlyFromSource(tempDir).size).toBe(0)
    })

    describe('v26.2.1-rc2 expected set (fixture frozen from empirical ground truth)', () => {
      // Ground truth generated 2026-07-28 by building rpk from the
      // v26.2.1-rc2 tag natively on macOS and in a Linux container,
      // running --print-tree on both, and diffing the trees.
      const RC2_LINUX_ONLY_ROOTS = [
        'rpk iotune',
        'rpk redpanda check',
        'rpk redpanda config',
        'rpk redpanda mode',
        'rpk redpanda start',
        'rpk redpanda stop',
        'rpk redpanda tune'
      ]

      const RC2_EXPANDED_LINUX_ONLY = [
        'rpk iotune',
        'rpk redpanda check',
        'rpk redpanda config',
        'rpk redpanda config bootstrap',
        'rpk redpanda config init',
        'rpk redpanda config print',
        'rpk redpanda config set',
        'rpk redpanda mode',
        'rpk redpanda start',
        'rpk redpanda stop',
        'rpk redpanda tune',
        'rpk redpanda tune help',
        'rpk redpanda tune list'
      ]

      test('static detection roots match the dynamic Linux-vs-Darwin diff', () => {
        writeSourceTree(tempDir, modernFixture)
        const result = detectLinuxOnlyFromSource(tempDir)
        expect([...result].sort()).toEqual(RC2_LINUX_ONLY_ROOTS)
      })

      test('marker expansion over the rc2 tree yields the full 13-path set', () => {
        // Minimal replica of the built-in Linux-only subtree at rc2
        const tree = {
          name: 'rpk',
          commands: [
            { name: 'iotune' },
            {
              name: 'redpanda',
              commands: [
                { name: 'check' },
                {
                  name: 'config',
                  commands: [
                    { name: 'bootstrap' }, { name: 'init' },
                    { name: 'print' }, { name: 'set' }
                  ]
                },
                { name: 'mode' },
                { name: 'start' },
                { name: 'stop' },
                { name: 'tune', commands: [{ name: 'help' }, { name: 'list' }] }
              ]
            },
            { name: 'topic', commands: [{ name: 'create' }] }
          ]
        }

        const marked = addPlatformMarkersFromSource(tree, new Set(RC2_LINUX_ONLY_ROOTS))
        expect(marked.linux_only_commands).toEqual(RC2_EXPANDED_LINUX_ONLY)

        const topic = marked.commands.find(c => c.name === 'topic')
        expect(topic.platforms).toEqual(['linux', 'darwin'])
        const redpanda = marked.commands.find(c => c.name === 'redpanda')
        expect(redpanda.platforms).toEqual(['linux', 'darwin'])
        expect(redpanda.commands.find(c => c.name === 'start').platforms).toEqual(['linux'])
      })
    })
  })

  describe('findLinuxConstrainedFiles', () => {
    test('lists files with explicit tags and filename suffixes', () => {
      writeSourceTree(tempDir, {
        'pkg/cli/iotune/iotune.go': '//go:build linux\n\npackage iotune\n',
        'pkg/cli/foo/foo_linux.go': 'package foo\n',
        'pkg/cli/topic/topic.go': 'package topic\n'
      })
      const files = findLinuxConstrainedFiles(tempDir)
      expect(files).toContain(path.join('pkg', 'cli', 'iotune', 'iotune.go'))
      expect(files).toContain(path.join('pkg', 'cli', 'foo', 'foo_linux.go'))
      expect(files).not.toContain(path.join('pkg', 'cli', 'topic', 'topic.go'))
    })
  })

  describe('warnIfDetectionLooksBroken (tripwire)', () => {
    let warnSpy

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      warnSpy.mockRestore()
    })

    test('fires when detection is empty but source has Linux-gated files', () => {
      writeSourceTree(tempDir, {
        'pkg/cli/iotune/iotune.go': '//go:build linux\n\npackage iotune\n'
      })
      const fired = warnIfDetectionLooksBroken(tempDir, new Set())
      expect(fired).toBe(true)
      const output = warnSpy.mock.calls.map(c => c.join(' ')).join('\n')
      expect(output).toContain('PLATFORM DETECTION TRIPWIRE')
      expect(output).toContain(path.join('pkg', 'cli', 'iotune', 'iotune.go'))
    })

    test('stays quiet when detection found commands', () => {
      writeSourceTree(tempDir, {
        'pkg/cli/iotune/iotune.go': '//go:build linux\n\npackage iotune\n'
      })
      const fired = warnIfDetectionLooksBroken(tempDir, new Set(['rpk iotune']))
      expect(fired).toBe(false)
      expect(warnSpy).not.toHaveBeenCalled()
    })

    test('stays quiet when the source has no platform gating at all', () => {
      writeSourceTree(tempDir, {
        'pkg/cli/topic/topic.go': 'package topic\n'
      })
      const fired = warnIfDetectionLooksBroken(tempDir, new Set())
      expect(fired).toBe(false)
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })
})
