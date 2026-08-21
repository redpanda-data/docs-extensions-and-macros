'use strict'

const fs = require('fs')
const path = require('path')

const rpk = require('../../../tools/lint-strings/surfaces/rpk')
const { runRules } = require('../../../tools/lint-strings/engine')
const { rulesFor } = require('../../../tools/lint-strings')

const FIXTURE_PATH = path.join(__dirname, '../../../tools/lint-strings/fixtures/rpk/lint_cmd.go')
const fixture = fs.readFileSync(FIXTURE_PATH, 'utf8')

/** 1-indexed line of the first occurrence of a marker string. */
function lineOf (needle) {
  const index = fixture.indexOf(needle)
  if (index === -1) throw new Error(`Marker not found in fixture: ${needle}`)
  return fixture.slice(0, index).split('\n').length
}

describe('rpk scanner (scanFile)', () => {
  const declarations = rpk.scanFile(fixture, 'src/go/rpk/pkg/cli/lint_cmd.go')
  const byKey = new Map(declarations.map((d) => [`${d.meta.kind}:${d.name}`, d]))

  test('finds every cobra.Command Short/Long and every flag registration', () => {
    const kinds = declarations.reduce((acc, d) => {
      acc[d.meta.kind] = (acc[d.meta.kind] || 0) + 1
      return acc
    }, {})
    expect(kinds).toEqual({ short: 3, long: 2, flag: 7 })
    // cobra.Command in a comment never matches (comment masking)
    expect(declarations.some((d) => d.name === 'fake')).toBe(false)
  })

  test('command name comes from the first Use token; spans are exact', () => {
    const short = byKey.get('short:badshort')
    expect(short.string).toBe('queries cluster for health overview.')
    expect(short.line_start).toBe(lineOf('Short: "queries'))

    // Use with positional args resolves to the leaf token
    expect(byKey.has('short:widget')).toBe(true)

    const flag = byKey.get('flag:watch')
    expect(flag.string).toBe('Blocks and writes out all changes')
    expect(flag.line_start).toBe(lineOf('cmd.Flags().BoolVarP(&watch'))
    expect(flag.line_end).toBe(flag.line_start)
  })

  test('raw-string Long resolves through a package-level constant', () => {
    const long = byKey.get('long:widget')
    expect(long.string).toContain('resolved through a package-level constant')
    expect(long.meta.unverifiable).toBe(false)
  })

  test('flag-set variables (f := cmd.Flags()) are followed', () => {
    expect(byKey.get('flag:retries').string).toBe('Number of retries before giving up')
    expect(byKey.get('flag:timeout').meta.method).toBe('DurationVar')
  })

  test('dynamic usage strings are unverifiable, never guessed', () => {
    const help = byKey.get('flag:help')
    expect(help.meta.unverifiable).toBe(true)
    expect(help.string).toBeNull()
  })
})

describe('rpk hidden/deprecated flag exclusion', () => {
  test('MarkHidden and MarkDeprecated flags are not part of the docs contract', () => {
    const source = `package x
func f(cmd *cobra.Command) {
	cmd.Flags().String("secret-knob", "", "")
	cmd.Flags().MarkHidden("secret-knob")
	cmd.Flags().IntVar(new(int), "old-num", 1, "")
	cmd.Flags().MarkDeprecated("old-num", "use --num")
	cmd.Flags().String("published", "", "Publishes things")
}
`
    const declarations = rpk.scanFile(source, 'x.go')
    const names = declarations.filter((d) => d.meta.kind === 'flag').map((d) => d.name)
    expect(names).toEqual(['published'])
  })
})

describe('rpk surface end-to-end (fixture file)', () => {
  const os = require('os')
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-rpk-'))
  const relPath = path.join('src', 'go', 'rpk', 'pkg', 'cli', 'lint_cmd.go')

  beforeAll(() => {
    fs.mkdirSync(path.join(repo, path.dirname(relPath)), { recursive: true })
    fs.copyFileSync(FIXTURE_PATH, path.join(repo, relPath))
  })

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  test('known-bads are flagged with the expected rule ids; conforming counterparts stay clean', () => {
    const declarations = rpk.extract({ repo })
    const { findings, summary } = runRules(declarations, rulesFor(rpk))
    const byKey = new Map(findings.map((f) => [`${f.line_start}:${f.name}`, f]))

    // lowercase Short with a trailing period
    const badShort = byKey.get(`${lineOf('Short: "queries')}:badshort`)
    expect(badShort.rules.map((r) => r.id).sort()).toEqual(['rpk-terminal-period', 'starts-lowercase'])

    // Long: intended ALLCAPS heading is info; the stray ==== run is a warning
    const badLong = byKey.get(`${lineOf('Long: `Query')}:badshort`)
    const longRules = badLong.rules.map((r) => r.id)
    expect(longRules).toContain('rpk-long-allcaps-heading')
    expect(longRules).toContain('rpk-long-block-delimiter')
    expect(badLong.rules.find((r) => r.id === 'rpk-long-allcaps-heading').severity).toBe('info')
    expect(badLong.rules.find((r) => r.id === 'rpk-long-block-delimiter').severity).toBe('warning')

    // flag usage with a trailing period
    const trailing = byKey.get(`${lineOf('"trailing-period"')}:trailing-period`)
    expect(trailing.rules.map((r) => r.id)).toEqual(['rpk-terminal-period'])

    // flag usage that merely echoes the flag name
    const echo = byKey.get(`${lineOf('"verbose-output"')}:verbose-output`)
    expect(echo.rules.map((r) => r.id).sort()).toEqual(['name-echo', 'starts-lowercase'])

    // Multiline Short. This was the one rule in the linter with no coverage at
    // all: it is live code that fires correctly, but no test referenced it and
    // no fixture exercised it, so a regression in it would have shipped
    // silently. Everything else about this Short conforms, so it isolates the
    // rule, and the span must cover BOTH lines of the raw string literal.
    const multiline = byKey.get(`${lineOf('Short: `Manage the widget cache')}:multiline`)
    expect(multiline.rules.map((r) => r.id)).toEqual(['rpk-short-multiline'])
    expect(multiline.rules[0].severity).toBe('warning')
    expect(multiline.line_start).toBe(lineOf('Short: `Manage the widget cache'))
    expect(multiline.line_end).toBe(lineOf('and everything attached to it'))

    // Conforming counterparts: zero findings (false-positive guard)
    const flagged = new Set(findings.map((f) => f.name))
    expect(flagged.has('widget')).toBe(false)
    expect(flagged.has('watch')).toBe(false)
    expect(flagged.has('retries')).toBe(false)
    expect(flagged.has('timeout')).toBe(false)
    expect(flagged.has('format')).toBe(false)

    // One-line Shorts and flag usages must never trip the generic too-short
    // rule (rpk skips it), and dynamic strings never error.
    expect(summary.byRule['too-short']).toBeUndefined()
    expect(summary.errors).toBe(0)

    // declaration_text carries the exact source lines
    expect(trailing.declaration_text).toContain('"trailing-period"')
  })
})
