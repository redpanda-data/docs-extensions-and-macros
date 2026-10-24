'use strict'

const { detect, kinds } = require('./helpers')
const { parseGo, commandPath } = require('../../../tools/user-facing-changes/detectors/rpk')

const FILE = 'src/go/rpk/pkg/cli/shadow/create.go'

// A synthetic rpk command file in the shape of src/go/rpk/pkg/cli/**:
// one cobra.Command per file, flags registered directly and through a
// bound flag set. Nothing here is copied from the private repo.
const SOURCE = `// Copyright 2026 Fixture
package shadow

import (
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
)

// cobra.Command{Use: "in-a-comment"} must never count.

func newCreateCommand(fs afero.Fs, p *config.Params) *cobra.Command {
	var (
		dry     bool
		timeout time.Duration
		format  string
	)
	cmd := &cobra.Command{
		Use:   "create [NAME]",
		Short: "Create a shadow link",
		Long: \`Create a shadow link.

Use --dry to test the connection first, with examples like "rpk shadow create x".
\`,
		Args: cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			// not a flag: cmd.Flags().Lookup("dry")
		},
	}
	cmd.Flags().BoolVarP(&dry, "dry", "d", false, "Dry run: test the connection without creating the link")
	cmd.Flags().DurationVar(&timeout, "timeout", 30*time.Second, "How long to wait for the source cluster")
	cmd.Flags().StringP("format", "f", "text", "Output format, one of text or json")
	f := cmd.Flags()
	f.IntVar(&retries, "retries", 3, "Number of retries before giving up")
	f.CountVarP(&verbose, "verbose", "v", "Log more")
	cmd.Flags().Bool("legacy", false, "Use the legacy path")
	cmd.Flags().MarkHidden("legacy")
	return cmd
}
`

const base = { [FILE]: SOURCE }
const edit = (from, to) => ({ [FILE]: SOURCE.replace(from, to) })

describe('parseGo', () => {
  test('reads the command and every registered flag with name, default and target', () => {
    const { commands, flags, hidden, unresolved } = parseGo([{ startLine: 1, text: SOURCE }])
    expect(unresolved).toEqual([])
    expect([...commands.keys()]).toEqual(['create'])
    expect(commands.get('create')).toMatchObject({ use: 'create', hidden: false, deprecated: null, line: 17 })
    // Keyed by command and flag name, so two commands in one file keep their own flags.
    expect([...flags.keys()]).toEqual(['dry', 'timeout', 'format', 'retries', 'verbose', 'legacy'].map((n) => `create\t${n}`))
    expect(flags.get('create\tdry')).toMatchObject({ defaultText: 'false', target: '&dry', method: 'BoolVarP', line: 29 })
    expect(flags.get('create\ttimeout').defaultText).toBe('30*time.Second')
    expect(flags.get('create\tformat')).toMatchObject({ defaultText: '"text"', target: null })
    expect(flags.get('create\tretries')).toMatchObject({ defaultText: '3', target: '&retries' })
    // Count flags have no default argument.
    expect(flags.get('create\tverbose').defaultText).toBeNull()
    expect([...hidden]).toEqual(['legacy'])
  })

  test('commandPath derives the command from the directory tree and the Use token', () => {
    expect(commandPath('src/go/rpk/pkg/cli/shadow/create.go', 'create')).toBe('rpk shadow create')
    expect(commandPath('src/go/rpk/pkg/cli/shadow/shadow.go', 'shadow')).toBe('rpk shadow')
    expect(commandPath('src/go/rpk/pkg/cli/topic/delete.go', null)).toBe('rpk topic delete')
    expect(commandPath('src/go/rpk/pkg/cli/root.go', 'rpk')).toBe('rpk')
    expect(commandPath('src/go/rpk/pkg/cli/cluster/config/edit.go', 'edit')).toBe('rpk cluster config edit')
  })
})

describe('rpk detector', () => {
  test('a new flag is added, named by command and flag (PR 597 shape)', () => {
    const removed = SOURCE.replace('\tcmd.Flags().BoolVarP(&dry, "dry", "d", false, "Dry run: test the connection without creating the link")\n', '')
    const r = detect({ [FILE]: removed }, base)
    expect(kinds(r)).toEqual([['added', 'rpk shadow create --dry']])
    expect(r.findings[0]).toMatchObject({ surface: 'rpk', severity: 'medium', file: FILE, line: 29 })
    expect(r.findings[0].summary).toMatch(/default `false`/)
    expect(r.findings[0].evidence).toMatch(/^\+\tcmd\.Flags\(\)\.BoolVarP\(&dry, "dry"/m)
    expect(r.findings[0].affected_pages).toEqual(['https://docs.redpanda.com/streaming/current/reference/rpk/'])
  })

  test('a removed flag is high, a changed default is high', () => {
    const r = detect(base, { [FILE]: SOURCE.replace('\tf.IntVar(&retries, "retries", 3, "Number of retries before giving up")\n', '') })
    expect(kinds(r)).toEqual([['removed', 'rpk shadow create --retries']])
    expect(r.findings[0].severity).toBe('high')
    const r2 = detect(base, edit('"timeout", 30*time.Second,', '"timeout", 60*time.Second,'))
    expect(kinds(r2)).toEqual([['default-changed', 'rpk shadow create --timeout']])
    expect(r2.findings[0].summary).toMatch(/from `30\*time\.Second` to `60\*time\.Second`/)
  })

  test('a flag re-registered under a new name with the same target is one rename, not a removal plus an addition', () => {
    const r = detect(base, edit('"dry", "d", false, "Dry run', '"dry-run", "d", false, "Dry run'))
    expect(kinds(r)).toEqual([['renamed', 'rpk shadow create --dry-run']])
    expect(r.findings[0].summary).toMatch(/`--dry` of `rpk shadow create` was renamed to `--dry-run`/)
  })

  test('MarkDeprecated and MarkHidden on an existing flag are deprecated and removed', () => {
    const r = detect(base, edit('\treturn cmd', '\tcmd.Flags().MarkDeprecated("retries", "use --timeout")\n\treturn cmd'))
    expect(kinds(r)).toEqual([['deprecated', 'rpk shadow create --retries']])
    const r2 = detect(base, edit('\treturn cmd', '\tcmd.Flags().MarkHidden("retries")\n\treturn cmd'))
    expect(kinds(r2)).toEqual([['removed', 'rpk shadow create --retries']])
    expect(r2.findings[0].detail).toBe('hidden')
  })

  test('a hidden flag that changes is never reported', () => {
    const r = detect(base, edit('cmd.Flags().Bool("legacy", false,', 'cmd.Flags().Bool("legacy", true,'))
    expect(r.findings).toEqual([])
  })

  test('a renamed command is one rename; a Deprecated field is a deprecation; Hidden removes it', () => {
    const r = detect(base, edit('Use:   "create [NAME]"', 'Use:   "add [NAME]"'))
    expect(kinds(r)).toEqual([['renamed', 'rpk shadow add']])
    const r2 = detect(base, edit('Short: "Create a shadow link",', 'Short: "Create a shadow link",\n\t\tDeprecated: "use rpk shadow add",'))
    expect(kinds(r2)).toEqual([['deprecated', 'rpk shadow create']])
    const r3 = detect(base, edit('Short: "Create a shadow link",', 'Short: "Create a shadow link",\n\t\tHidden: true,'))
    expect(kinds(r3)).toEqual([['removed', 'rpk shadow create']])
  })

  test('a new command file is one added command plus its flags', () => {
    const r = detect({}, base)
    // Source order: findings sort by severity, then file and line.
    expect(kinds(r)).toEqual([
      ['added', 'rpk shadow create'],
      ['added', 'rpk shadow create --dry'],
      ['added', 'rpk shadow create --timeout'],
      ['added', 'rpk shadow create --format'],
      ['added', 'rpk shadow create --retries'],
      ['added', 'rpk shadow create --verbose']
    ])
  })
})

describe('rpk detector: negative controls', () => {
  test('usage text, Short and Long changes are the lint\'s and yield nothing', () => {
    const r = detect(base, edit('"Dry run: test the connection without creating the link"', '"Dry run: tests the connection without creating the link."'))
    expect(r.findings).toEqual([])
    const r2 = detect(base, edit('Short: "Create a shadow link"', 'Short: "Create a shadow link to a source cluster"'))
    expect(r2.findings).toEqual([])
  })

  test('a Run body change (refactor) and a comment change yield nothing', () => {
    const r = detect(base, edit('// not a flag: cmd.Flags().Lookup("dry")', 'out.MaybeDie(err, "unable to create: %v", err)'))
    expect(r.findings).toEqual([])
    const r2 = detect(base, edit('// cobra.Command{Use: "in-a-comment"} must never count.', '// Renamed in a comment only: cobra.Command{Use: "other"}'))
    expect(r2.findings).toEqual([])
  })

  test('reordering flag registrations yields nothing', () => {
    const a = '\tcmd.Flags().DurationVar(&timeout, "timeout", 30*time.Second, "How long to wait for the source cluster")\n'
    const b = '\tcmd.Flags().StringP("format", "f", "text", "Output format, one of text or json")\n'
    const r = detect(base, { [FILE]: SOURCE.replace(a + b, b + a) })
    expect(r.findings).toEqual([])
  })

  test('a _test.go file and a file outside pkg/cli are not routed', () => {
    const T = 'src/go/rpk/pkg/cli/shadow/create_test.go'
    expect(detect({ [T]: SOURCE }, { [T]: SOURCE.replace('"dry", "d", false', '"dry", "d", true') }).findings).toEqual([])
    const O = 'src/go/rpk/pkg/config/params.go'
    expect(detect({ [O]: SOURCE }, { [O]: SOURCE.replace('"dry", "d", false', '"dry", "d", true') }).findings).toEqual([])
  })
})
