'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { detect, kinds } = require('./helpers')
const { parseCppConstants, parseGoConstants } = require('../../../tools/user-facing-changes/detectors/constants')

const H = 'src/v/config/configuration.h'
const CC = 'src/v/config/configuration.cc'
const OTHER_H = 'src/v/config/other.h'
const GO = 'src/go/rpk/pkg/cli/topic/create.go'
const GO_CONST = 'src/go/rpk/pkg/cli/topic/defaults.go'

const header = (v, extra = '') => `#pragma once
#include "config/other.h"
namespace config {
inline constexpr int default_rpc_conns = ${v};
${extra}struct configuration final : public config_store {
    property<int> rpc_server_max_conns;
    property<size_t> log_segment_size;
};
}
`
const source = (segDefault = 'default_segment_size') => `#include "config/configuration.h"
namespace config {
configuration::configuration()
  : rpc_server_max_conns(
      *this,
      "rpc_server_max_conns",
      "The maximum number of connections.",
      {.needs_restart = needs_restart::yes, .visibility = visibility::user},
      config::default_rpc_conns,
      {.min = 8})
  , log_segment_size(
      *this,
      "log_segment_size",
      "Default log segment size in bytes.",
      {.needs_restart = needs_restart::no, .visibility = visibility::tunable},
      ${segDefault}) {}
}
`
const otherHeader = (v) => `#pragma once
namespace config {
static constexpr size_t default_segment_size{${v}};
constexpr int unused_knob = 7;
}
`
const cpp = (h, o = '128_MiB', unused = '7') => ({
  [H]: header(h),
  [CC]: source(),
  [OTHER_H]: otherHeader(o).replace('unused_knob = 7', `unused_knob = ${unused}`)
})

const goFile = (inline = '') => `package topic

func newCreateCommand() *cobra.Command {
	var partitions int32
	cmd := &cobra.Command{
		Use:   "create [TOPICS...]",
		Short: "Create topics",
	}
	cmd.Flags().Int32VarP(&partitions, "partitions", "p", defaultPartitions, "Number of partitions")
	cmd.Flags().StringVar(&format, "format", defaultFormat, "Output format")
	${inline}
	return cmd
}
`
const goConsts = (p, f = '"text"', pkg = 'topic') => `package ${pkg}

const (
	defaultPartitions = ${p}
	unusedThing       = 9
)

var defaultFormat string = ${f}
`
const go = (p, f, pkg) => ({ [GO]: goFile(), [GO_CONST]: goConsts(p, f, pkg) })

describe('parsing constants', () => {
  test('C++ forms: inline constexpr, static constexpr with braces, plain constexpr', () => {
    const { defs } = parseCppConstants([{ startLine: 1, text: header(128) + otherHeader('128_MiB') }])
    expect(defs.get('default_rpc_conns')).toMatchObject({ value: '128', line: 4 })
    expect(defs.get('default_segment_size').value).toBe('128_MiB')
    expect(defs.get('unused_knob').value).toBe('7')
    expect(defs.has('rpc_server_max_conns')).toBe(false)
  })

  test('Go forms: const block, typed var; iota is skipped', () => {
    const { defs } = parseGoConstants([{ startLine: 1, text: goConsts(1) + 'const (\n\tA = iota\n)\n' }])
    expect(defs.get('defaultPartitions')).toMatchObject({ value: '1', line: 4 })
    expect(defs.get('defaultFormat').value).toBe('"text"')
    expect(defs.has('A')).toBe(false)
  })
})

describe('constants detector: C++', () => {
  test('a constant in the header the initializer file includes is a default change of the property that passes it', () => {
    const r = detect(cpp(128), cpp(256))
    expect(kinds(r)).toEqual([['default-changed', 'rpc_server_max_conns']])
    expect(r.findings[0]).toMatchObject({ surface: 'properties', severity: 'high', file: H, line: 4, detector: 'constants', detail: 'via-constant' })
    expect(r.findings[0].summary).toMatch(/from `128` to `256`.*passes `default_rpc_conns`/)
    expect(r.findings[0].evidence).toBe('@@ -1,7 +1,7 @@\n-inline constexpr int default_rpc_conns = 128;\n+inline constexpr int default_rpc_conns = 256;')
  })

  test('a constant in a header the source does not include directly is not followed', () => {
    // other.h is included by configuration.h, not by configuration.cc.
    const r = detect(cpp(128, '128_MiB'), cpp(128, '256_MiB'))
    expect(r.findings).toEqual([])
  })

  test('the same, once configuration.cc includes it, is found; a value-preserving rewrite is not', () => {
    const inc = (files) => ({ ...files, [CC]: `#include "config/other.h"\n${files[CC]}` })
    expect(kinds(detect(inc(cpp(128, '128_MiB')), inc(cpp(128, '256_MiB'))))).toEqual([['default-changed', 'log_segment_size']])
    expect(detect(inc(cpp(128, '128_MiB')), inc(cpp(128, '134217728'))).findings).toEqual([])
  })

  test('a changed constant that no default uses yields nothing', () => {
    expect(detect(cpp(128, '128_MiB', '7'), cpp(128, '128_MiB', '8')).findings).toEqual([])
  })

  test('a constant defined twice on one side is ambiguous and skipped', () => {
    const twice = (v) => ({ ...cpp(v), [H]: header(v, `inline constexpr int default_rpc_conns = ${v};\n`) })
    expect(detect(twice(128), twice(256)).findings).toEqual([])
  })

  test('without a checkout the search is limited to the diff, and a note says so', () => {
    const r = detect(cpp(128), cpp(256), { whole: false })
    expect(r.findings).toEqual([])
    expect(r.notes).toEqual([expect.objectContaining({ detector: 'constants', message: expect.stringMatching(/default_rpc_conns changed value; without a checkout/) })])
  })
})

describe('constants detector: Go', () => {
  test('a const in the same package is a default change of the flag that passes it', () => {
    const r = detect(go(1), go(3))
    expect(kinds(r)).toEqual([['default-changed', 'rpk topic create --partitions']])
    expect(r.findings[0]).toMatchObject({ surface: 'rpk', file: GO_CONST, line: 4, detail: 'via-constant' })
    expect(r.findings[0].summary).toMatch(/from `1` to `3`.*passes `defaultPartitions`/)
    expect(kinds(detect(go(1, '"text"'), go(1, '"json"')))).toEqual([['default-changed', 'rpk topic create --format']])
  })

  test('a value-preserving rewrite, an unused constant and another package yield nothing', () => {
    expect(detect(go('1_000'), go('1000')).findings).toEqual([])
    const unused = (v) => ({ [GO]: goFile(), [GO_CONST]: goConsts(1).replace('unusedThing       = 9', `unusedThing       = ${v}`) })
    expect(detect(unused(9), unused(10)).findings).toEqual([])
    expect(detect(go(1, '"text"', 'other'), go(3, '"text"', 'other')).findings).toEqual([])
  })

  test('a flag in another directory is not the same package', () => {
    const elsewhere = (v) => ({ 'src/go/rpk/pkg/cli/group/list.go': goFile(), [GO_CONST]: goConsts(v) })
    expect(detect(elsewhere(1), elsewhere(3)).findings).toEqual([])
  })
})

describe('the CLI on a diff with constant changes and value-preserving rewrites', () => {
  const FX = path.join(__dirname, '..', '..', 'fixtures', 'user-facing-changes', 'value-rewrites')
  const git = (cwd, args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout
  }
  let repo
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-const-'))
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.email', 't@example.com'])
    git(repo, ['config', 'user.name', 't'])
    fs.cpSync(path.join(FX, 'base'), repo, { recursive: true })
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'base'])
    git(repo, ['checkout', '-q', '-b', 'feat'])
    fs.cpSync(path.join(FX, 'head'), repo, { recursive: true })
    git(repo, ['commit', '-q', '-am', 'feat'])
  })
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }))

  test('reports the two constant changes and none of chrono, size-literal or YAML 1.1 rewrites', () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', '..', 'bin', 'doc-tools.js'), 'detect-user-facing-changes', '--repo', repo, '--diff', 'main', '--head', 'feat'], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    const report = JSON.parse(r.stdout)
    expect(report.findings.map((f) => [f.surface, f.change_kind, f.name])).toEqual([
      ['properties', 'default-changed', 'rpc_server_max_conns'],
      ['rpk', 'default-changed', 'rpk topic create --partitions']
    ])
    expect(report.summary.notes).toEqual([])
  })
})
