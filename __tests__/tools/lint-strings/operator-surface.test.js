'use strict'

const fs = require('fs')
const path = require('path')

const operator = require('../../../tools/lint-strings/surfaces/operator')
const { runRules } = require('../../../tools/lint-strings/engine')
const { rulesFor, SURFACES } = require('../../../tools/lint-strings')
const { routeFile } = require('../../../tools/lint-strings/diff')

const REPO = path.join(__dirname, '../../../tools/lint-strings/fixtures/operator')
const FILE = 'operator/cmd/run/run.go'
const fixture = fs.readFileSync(path.join(REPO, FILE), 'utf8')

function lineOf (needle) {
  const index = fixture.indexOf(needle)
  if (index === -1) throw new Error(`Marker not found in fixture: ${needle}`)
  return fixture.slice(0, index).split('\n').length
}

/** One { rule, kind, name } entry per issue. */
function findingsFor (decls) {
  const { findings } = runRules(decls, rulesFor(operator))
  const kindOf = new Map(decls.map((d) => [`${d.line_start}:${d.name}`, d.meta.kind]))
  return findings.flatMap((f) => f.rules.map((r) => ({ rule: r.id, kind: kindOf.get(`${f.line_start}:${f.name}`), name: f.name })))
}

describe('operator scanner (scanFile)', () => {
  const declarations = operator.scanFile(fixture, FILE)
  const flags = new Map(declarations.filter((d) => d.meta.kind === 'flag').map((d) => [d.name, d]))
  const deprecations = new Map(declarations.filter((d) => d.meta.kind === 'deprecation').map((d) => [d.name, d]))

  test('finds Var, plain and generic Var registrations, and skips hidden-only flags', () => {
    expect([...flags.keys()].sort()).toEqual([
      '--allow-pv-rebinding',
      '--allow-pvc-deletion',
      '--clear-maintenance-mode-after',
      '--configurator-base-image',
      '--debug',
      '--leader-election-lease-duration',
      '--metrics-secure',
      '--old-secure',
      '--post-restart-caught-up-percent',
      '--unbind-pvcs-after',
      '--unbinder-label-selector'
    ])
    expect(flags.has('--unsafe-decommission-failed-brokers')).toBe(false)
  })

  test('records defaults as literal forms', () => {
    expect(flags.get('--leader-election-lease-duration').meta.default_forms).toEqual(['15s'])
    expect(flags.get('--clear-maintenance-mode-after').meta.default_forms).toEqual(['30m', '30m0s'])
    expect(flags.get('--post-restart-caught-up-percent').meta.default_forms).toEqual(['100'])
    expect(flags.get('--configurator-base-image').meta.default_forms).toEqual(['docker.redpanda.com/redpandadata/redpanda-operator'])
    expect(flags.get('--unbinder-label-selector').meta.default_text).toBeNull()
  })

  test('deprecated flags carry their message and emit a deprecation declaration', () => {
    const flag = flags.get('--allow-pv-rebinding')
    expect(flag.meta.deprecated).toBe("the PVCUnbinder's safety gates make it unsafe")
    const dep = deprecations.get('--allow-pv-rebinding')
    expect(dep.string).toBe(flag.meta.deprecated)
    expect(dep.line_start).toBe(lineOf('MarkDeprecated("allow-pv-rebinding"'))
    expect(flags.get('--debug').meta.deprecated).toBeNull()
  })

  test('spans are exact', () => {
    expect(flags.get('--unbinder-label-selector').line_start).toBe(lineOf('cmd.Flags().Var(&o.selector'))
  })
})

describe('operator rules', () => {
  const findings = findingsFor(operator.scanFile(fixture, FILE))
  const by = (rule) => findings.filter((f) => f.rule === rule).map((f) => `${f.kind}:${f.name}`).sort()

  test('the conforming flags raise nothing', () => {
    const clean = findings.filter((f) => ['--unbind-pvcs-after', '--leader-election-lease-duration'].includes(f.name))
    expect(clean).toEqual([])
  })

  test('a registration written one argument per line, with gofmt\'s trailing comma, is linted', () => {
    const src = [
      'package run',
      '',
      'func register(cmd *cobra.Command, o *options) {',
      '\tcmd.Flags().StringVar(',
      '\t\t&o.mode,',
      '\t\t"multiline-mode",',
      '\t\t"standard",',
      '\t\t"bad usage.",',
      '\t)',
      '}',
      ''
    ].join('\n')
    const decls = operator.scanFile(src, FILE)
    const flag = decls.find((d) => d.name === '--multiline-mode')
    expect(flag.string).toBe('bad usage.')
    expect(flag.meta.default_text).toBe('"standard"')
    expect(flag.meta.unverifiable).toBe(false)
    const rules = findingsFor(decls).map((f) => f.rule).sort()
    expect(rules).toEqual(['operator-terminal-period', 'starts-lowercase'])
  })

  test('lowercase start and terminal period fire on usage strings only', () => {
    // The lowercase deprecation messages are correct: cobra prints them
    // after "Flag --x has been deprecated,".
    expect(by('starts-lowercase')).toEqual(['flag:--unbinder-label-selector'])
    expect(by('operator-terminal-period')).toEqual(['flag:--unbinder-label-selector'])
  })

  test('restated defaults are caught in all three shapes', () => {
    expect(by('operator-restated-default')).toEqual([
      'flag:--clear-maintenance-mode-after',
      'flag:--configurator-base-image',
      'flag:--post-restart-caught-up-percent'
    ])
  })

  test('any backtick in a usage or deprecation string is an error (cli-backtick)', () => {
    expect(by('cli-backtick')).toEqual(['deprecation:--old-secure', 'flag:--metrics-secure'])
    const rule = rulesFor(operator).find((r) => r.name === 'cli-backtick')
    expect(rule.severity).toBe('error')
    expect(rule.why).toMatch(/value placeholder/)
    expect(rule.standard).toBeTruthy()
    expect(operator.rules.find((r) => r.name === 'operator-backtick')).toBeUndefined()
  })

  test('never asks for backticks: the page formats every code token kind', () => {
    expect(operator.convention.auto_inline_code.kinds).toEqual(['identifier', 'flag', 'path'])
    expect(by('missing-inline-code')).toEqual([])
  })

  test('the terminal-period rule no longer calls the string a one-line label', () => {
    const rule = operator.rules.find((r) => r.name === 'operator-terminal-period')
    expect(rule.why).not.toMatch(/one-line label/)
    expect(rule.why).toMatch(/adds the period/)
  })

  test('deprecation hygiene', () => {
    expect(by('operator-unmarked-deprecation')).toEqual(['flag:--debug'])
    expect(by('operator-deprecation-no-alternative')).toEqual(['deprecation:--allow-pv-rebinding'])
  })
})

describe('operator extract and routing', () => {
  test('is registered and routed for operator/cmd/run only', () => {
    expect(SURFACES.operator).toBe(operator)
    expect(routeFile('operator/cmd/run/run.go')).toBe('operator')
    expect(routeFile('operator/cmd/run/run_flags_test.go')).toBeNull()
    expect(routeFile('operator/cmd/run/testdata/x.go')).toBeNull()
    expect(routeFile('operator/cmd/sidecar/sidecar.go')).toBeNull()
    expect(routeFile('operator/api/redpanda/v1alpha2/redpanda_types.go')).toBe('crd')
  })

  test('whole-repo extract walks operator/cmd/run', () => {
    const decls = operator.extract({ repo: REPO })
    expect(decls.filter((d) => d.meta.kind === 'flag')).toHaveLength(11)
    expect(decls.every((d) => d.declaration_text)).toBe(true)
  })

  test('diff-mode extract takes only the given files', () => {
    expect(operator.extract({ repo: REPO, files: new Set([FILE, 'operator/cmd/run/run_test.go']) })).toHaveLength(14)
  })
})
