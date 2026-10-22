'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { detect, kinds, makeDiff } = require('./helpers')
const { DETECTORS, detectUserFacingChanges, buildDocImpact, CAP } = require('../../../tools/user-facing-changes')
const { KINDS, severityFor, makeFinding } = require('../../../tools/user-facing-changes/finding')
const gatingFixture = (name) => fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'enterprise-gating', name), 'utf8')

const CC = 'src/v/config/configuration.cc'
const H = 'src/v/config/configuration.h'
const SOURCE = `configuration::configuration(ctor_key)
  : audit_enabled(
      *this,
      true, /* restricted */
      "audit_enabled",
      "Enables audit logging.",
      {.needs_restart = needs_restart::no, .visibility = visibility::user},
      false)
  , enable_rack_awareness(
      *this,
      "enable_rack_awareness",
      "Enable rack-aware replica assignment.",
      {.needs_restart = needs_restart::no, .visibility = visibility::user},
      false) {}
`
const HEADER = `struct configuration final : public config_store {
    enterprise<property<bool>> audit_enabled;
    property<bool> enable_rack_awareness;
};
`

describe('the registry', () => {
  test('every detector has the contract the registry relies on, and every kind maps to a severity', () => {
    expect(DETECTORS.map((d) => d.id)).toEqual(['properties', 'rpk', 'metrics', 'api', 'helm', 'crd', 'enums', 'enterprise-gating', 'constants'])
    for (const d of DETECTORS) {
      expect(typeof d.detect).toBe('function')
      expect(Array.isArray(d.routes) && d.routes.length > 0).toBe(true)
      expect(typeof d.surface).toBe('string')
    }
    expect(KINDS).toEqual(['added', 'removed', 'renamed', 'default-changed', 'deprecated', 'enterprise-gated', 'behaviour'])
    for (const k of KINDS) expect(['high', 'medium', 'low']).toContain(severityFor(k))
    expect(() => makeFinding({ change_kind: 'nope' })).toThrow(/unknown change_kind/)
  })

  test('an empty diff, a binary-only diff and a diff of unrouted files all yield nothing, with no notes', () => {
    expect(detectUserFacingChanges('')).toEqual({ findings: [], notes: [], byDetector: expect.any(Object), routed: expect.any(Object) })
    const binary = 'diff --git a/docs/x.png b/docs/x.png\nindex 1..2 100644\nBinary files a/docs/x.png and b/docs/x.png differ\n'
    expect(detectUserFacingChanges(binary).findings).toEqual([])
    const r = detect({ 'README.md': 'a\n', 'tests/rptest/tests/tls_metrics_test.py': 'x = 1\n' }, { 'README.md': 'b\n', 'tests/rptest/tests/tls_metrics_test.py': 'x = 2\n' })
    expect(r.findings).toEqual([])
    expect(r.notes).toEqual([])
    expect(Object.values(r.byDetector).every((n) => n === 0)).toBe(true)
  })

  test('a crashing detector is a note, never a lost run for the others', () => {
    const broken = { id: 'boom', surface: 'x', routes: [/^src\/v\/config\//], detect: () => { throw new Error('kaboom') } }
    DETECTORS.push(broken)
    try {
      const r = detect({ [CC]: SOURCE, [H]: HEADER }, { [CC]: SOURCE.replace('      false) {}', '      true) {}'), [H]: HEADER })
      expect(kinds(r)).toEqual([['default-changed', 'enable_rack_awareness']])
      expect(r.notes).toEqual([expect.objectContaining({ detector: 'boom', message: 'detector crashed: kaboom' })])
    } finally {
      DETECTORS.pop()
    }
  })

  test('findings sort high first, then by surface, file and line, and carry the mechanical marker', () => {
    const r = detect({ [CC]: SOURCE, [H]: HEADER }, {
      [CC]: SOURCE.replace('      false) {}', '      true) {}').replace('  , enable_rack_awareness(', '  , new_knob(\n      *this,\n      "new_knob",\n      "A new knob.",\n      {.needs_restart = needs_restart::no, .visibility = visibility::user},\n      1)\n  , enable_rack_awareness('),
      [H]: HEADER.replace('    property<bool> enable_rack_awareness;', '    property<int> new_knob;\n    property<bool> enable_rack_awareness;')
    })
    expect(kinds(r)).toEqual([['default-changed', 'enable_rack_awareness'], ['added', 'new_knob']])
    for (const f of r.findings) {
      expect(f.confidence).toBe('mechanical')
      expect(f.affected_pages).toHaveLength(1)
      expect(f.affected_pages[0]).toMatch(/^https:\/\/docs\.redpanda\.com\//)
      for (const k of ['surface', 'name', 'change_kind', 'summary', 'severity', 'file', 'detector', 'evidence']) expect(typeof f[k]).toBe('string')
      expect(typeof f.line).toBe('number')
    }
  })
})

describe('the enterprise-gating detector in the registry', () => {
  test('the PR 579 hunks yield one enterprise-gated finding with evidence and the gating kind as detail', () => {
    const r = detectUserFacingChanges(gatingFixture('se-579-enum-added.patch'))
    expect(kinds(r)).toEqual([['enterprise-gated', 'manual_finalization']])
    expect(r.findings[0]).toMatchObject({
      surface: 'enterprise-feature',
      severity: 'medium',
      detail: 'enterprise-feature-added',
      file: 'src/v/features/enterprise_features.h',
      line: 37,
      detector: 'enterprise-gating',
      affected_pages: ['https://docs.redpanda.com/streaming/current/get-started/licensing/overview/']
    })
    expect(r.findings[0].evidence).toMatch(/^\+    manual_finalization,$/m)
  })

  test('a property wrapped in enterprise<> is reported once, not by both detectors that read configuration.h', () => {
    const r = detectUserFacingChanges(gatingFixture('se-property-gate-added.patch'))
    expect(kinds(r)).toEqual([['enterprise-gated', 'features_auto_finalization']])
  })

  test('losing a gate is high; the restricted value is read through the header at HEAD', () => {
    const r = detect({ [CC]: SOURCE, [H]: HEADER }, { [CC]: SOURCE, [H]: HEADER.replace('enterprise<property<bool>> audit_enabled;', 'property<bool> audit_enabled;') })
    expect(kinds(r)).toEqual([['enterprise-gated', 'audit_enabled']])
    expect(r.findings[0]).toMatchObject({ severity: 'high', detail: 'enterprise-gate-removed' })
    const r2 = detect({ [CC]: SOURCE, [H]: HEADER }, { [CC]: SOURCE.replace('      true, /* restricted */', '      false, /* restricted */'), [H]: HEADER })
    expect(kinds(r2)).toEqual([['enterprise-gated', 'audit_enabled']])
    expect(r2.findings[0]).toMatchObject({ severity: 'high', detail: 'enterprise-restricted-value-changed', file: CC })
  })
})

describe('cross-surface negative controls', () => {
  test('a refactor-only diff across every routed surface yields zero findings', () => {
    const base = {
      [CC]: SOURCE,
      [H]: HEADER,
      'src/go/rpk/pkg/cli/topic/delete.go': 'package topic\n\nfunc helper(a int) int {\n\treturn a\n}\n\nfunc newDeleteCommand() *cobra.Command {\n\tcmd := &cobra.Command{Use: "delete", Short: "Delete topics"}\n\tcmd.Flags().BoolVar(&re, "regex", false, "Parse arguments as regular expressions")\n\treturn cmd\n}\n',
      'src/v/cluster/probe.cc': 'void probe::setup() {\n    _metrics.add_group(\n      prometheus_sanitize::metrics_name("cluster:x"),\n      {sm::make_gauge("y", [this] { return _y; }, sm::description("Y"))});\n}\n',
      'proto/redpanda/api/dataplane/v1/x.proto': 'syntax = "proto3";\nmessage X {\n  string a = 1;\n}\nservice S {\n  rpc Get(X) returns (X) {}\n}\n',
      'charts/redpanda/chart/values.yaml': 'a:\n  b: 1\n',
      'operator/api/v1/types.go': 'package v1\n\ntype Spec struct {\n\t// A.\n\tA string `json:"a"`\n}\n',
      'src/v/features/feature_table.h': 'enum class feature : std::uint64_t {\n    one = 1ULL << 0U,\n};\n'
    }
    const head = {
      ...base,
      [CC]: SOURCE.replace('{.needs_restart = needs_restart::no, .visibility = visibility::user},\n      false) {}', '{.needs_restart = needs_restart::no,\n       .visibility = visibility::user},\n      false) {}'),
      'src/go/rpk/pkg/cli/topic/delete.go': base['src/go/rpk/pkg/cli/topic/delete.go'].replace('func helper(a int) int {\n\treturn a\n}', 'func helper(a int) int {\n\tb := a\n\treturn b\n}'),
      'src/v/cluster/probe.cc': base['src/v/cluster/probe.cc'].replace('[this] { return _y; }', '[this] { return _y.load(); }'),
      'proto/redpanda/api/dataplane/v1/x.proto': base['proto/redpanda/api/dataplane/v1/x.proto'].replace('  rpc Get(X) returns (X) {}', '  rpc Get(X) returns (X) {\n  }'),
      'charts/redpanda/chart/values.yaml': 'a:\n  b: 1 # a comment\n',
      'operator/api/v1/types.go': base['operator/api/v1/types.go'].replace('\t// A.\n', '\t// A is a.\n'),
      'src/v/features/feature_table.h': base['src/v/features/feature_table.h'].replace('one = 1ULL << 0U', 'one = 1ULL << 0U // first')
    }
    const r = detect(base, head)
    expect(r.findings).toEqual([])
    expect(r.notes).toEqual([])
  })

  test('a test-only diff across surfaces yields zero findings', () => {
    const files = {
      'src/v/config/tests/configuration_test.cc': SOURCE,
      'src/go/rpk/pkg/cli/topic/delete_test.go': 'cmd.Flags().BoolVar(&re, "regex", false, "x")\n',
      'src/v/cluster/tests/probe_test.cc': 'sm::make_gauge("y", [] { return 1; }, sm::description("Y"))\n',
      'operator/api/v1/types_test.go': 'type Spec struct {\n\tA string `json:"a"`\n}\n',
      'tests/rptest/tests/x_test.py': 'x = 1\n'
    }
    const head = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.replace(/false|1/, 'true')]))
    expect(detect(files, head).findings).toEqual([])
  })
})

describe('buildDocImpact', () => {
  const finding = (i, severity = 'medium') => makeFinding({
    detector: 'properties', surface: 'properties', name: `p${i}`, change_kind: severity === 'high' ? 'removed' : 'added', file: CC, line: i, evidence: '+x',
    page: 'https://docs.redpanda.com/streaming/current/reference/properties/cluster-properties/', summary: `about p${i}`
  })

  test('nothing to report is null, so the caller writes no file', () => {
    expect(buildDocImpact({ findings: [] })).toBeNull()
    expect(buildDocImpact(null)).toBeNull()
  })

  test('the report has the shape the dispatch step validates and Jira can render', () => {
    const report = buildDocImpact({ findings: [finding(1, 'high'), finding(2)] })
    expect(report.findings).toHaveLength(2)
    expect(report.proposed_ticket.title).toBe('Document user-facing changes: p1, p2')
    expect(report.proposed_ticket.title.length).toBeLessThanOrEqual(255)
    expect(report.proposed_ticket.body).toMatch(/^- p1 \(removed, high\): about p1 Evidence: src\/v\/config\/configuration\.cc:1\.$/m)
    expect(report.proposed_ticket.body).toMatch(/2 user-facing change\(s\) were detected mechanically from the diff \(1 high, 1 medium\)/)
    // Jira renders only backticks, "- " bullets and bare URLs.
    expect(report.proposed_ticket.body).not.toMatch(/\[[^\]]+\]\(https?:/)
    expect(report.proposed_ticket.body).not.toMatch(/^#/m)
  })

  test('findings are capped at ten and the ticket names only the ones it carries', () => {
    const report = buildDocImpact({ findings: Array.from({ length: 13 }, (_, i) => finding(i)) })
    expect(report.findings).toHaveLength(CAP)
    expect(report.proposed_ticket.title).toMatch(/p9 and 3 more$/)
    expect(report.proposed_ticket.body).toMatch(/^- 3 more change\(s\) are not listed here/m)
    expect(report.proposed_ticket.body).not.toMatch(/p12/)
  })

  test('a long title is cut to fit Jira\'s 255-character summary', () => {
    const long = Array.from({ length: 20 }, (_, i) => ({ ...finding(i), name: `a_very_long_property_name_number_${i}_padding_padding` }))
    expect(buildDocImpact({ findings: long }).proposed_ticket.title.length).toBeLessThanOrEqual(255)
  })
})

describe('the CLI against a git checkout', () => {
  const git = (cwd, args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const run = (args, cwd) => spawnSync(process.execPath, [path.join(__dirname, '..', '..', '..', 'bin', 'doc-tools.js'), 'detect-user-facing-changes', ...args], { cwd, encoding: 'utf8' })

  let repo
  let baseSha
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-repo-'))
    git(repo, ['init', '-q', '-b', 'dev'])
    git(repo, ['config', 'user.email', 't@example.com'])
    git(repo, ['config', 'user.name', 't'])
    fs.mkdirSync(path.join(repo, 'src/v/config'), { recursive: true })
    fs.writeFileSync(path.join(repo, CC), SOURCE)
    fs.writeFileSync(path.join(repo, H), HEADER)
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'base'])
    baseSha = git(repo, ['rev-parse', 'HEAD'])
    // The base branch moves on after the PR branches, as it does in a
    // real PR: --diff must use the merge base, not the branch tip.
    git(repo, ['checkout', '-q', '-b', 'feature'])
    fs.writeFileSync(path.join(repo, CC), SOURCE.replace('      false) {}', '      true) {}'))
    git(repo, ['commit', '-q', '-am', 'flip the default, touch no doc string'])
    git(repo, ['checkout', '-q', 'dev'])
    fs.writeFileSync(path.join(repo, 'README.md'), 'moved on\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'dev moves on'])
    git(repo, ['checkout', '-q', 'feature'])
  })
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }))

  test('--repo --diff finds the default change through git, whole files, merge base', () => {
    const r = run(['--repo', repo, '--diff', 'dev', '--format', 'json'], os.tmpdir())
    expect(r.status).toBe(0)
    const report = JSON.parse(r.stdout)
    expect(report.findings.map((f) => [f.change_kind, f.name])).toEqual([['default-changed', 'enable_rack_awareness']])
    expect(report.summary).toMatchObject({ total: 1, bySeverity: { high: 1 }, notes: [] })
    expect(report.proposed_ticket.title).toMatch(/enable_rack_awareness/)
    expect(r.stderr).toBe('')
  })

  test('--patch with --repo and --base reads whole files; --patch alone works from the hunks', () => {
    const patch = path.join(repo, '..', `ufc-${path.basename(repo)}.patch`)
    fs.writeFileSync(patch, git(repo, ['diff', baseSha, 'HEAD']) + '\n')
    const whole = run(['--patch', patch, '--repo', repo, '--base', baseSha, '--format', 'json'], os.tmpdir())
    expect(JSON.parse(whole.stdout).findings.map((f) => f.name)).toEqual(['enable_rack_awareness'])
    const hunks = run(['--patch', patch, '--format', 'human'], os.tmpdir())
    expect(hunks.status).toBe(0)
    // The default is five lines below its member name, outside the -U3
    // window, so hunks alone cannot name it: the run says so instead of
    // guessing, which is the contract the workflow's job summary relies on.
    expect(hunks.stdout).toMatch(/No user-facing changes detected\./)
    expect(hunks.stdout).toMatch(/note \[properties\]: .*changed line\(s\) fall outside every initializer the hunks show.*run with --repo/)
    fs.rmSync(patch)
  })

  test('a git failure prints an empty report and the reason, and exits 0', () => {
    const r = run(['--repo', repo, '--diff', 'no-such-ref', '--format', 'json'], os.tmpdir())
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ findings: [], summary: expect.objectContaining({ total: 0 }) })
    expect(r.stderr).toMatch(/merge-base/)
    const r2 = run(['--format', 'json'], os.tmpdir())
    expect(r2.status).toBe(0)
    expect(JSON.parse(r2.stdout).findings).toEqual([])
    expect(r2.stderr).toMatch(/needs --repo <path> and --diff <base>, or --patch <file>/)
  })

  test('--detectors limits the run and the registered ids are in --help', () => {
    const r = run(['--repo', repo, '--diff', 'dev', '--detectors', 'rpk,metrics', '--format', 'json'], os.tmpdir())
    expect(JSON.parse(r.stdout).findings).toEqual([])
    const help = run(['--help'], os.tmpdir())
    // commander wraps long option help across lines.
    expect(help.stdout.replace(/\s+/g, ' ')).toMatch(/Registered: properties, rpk, metrics, api, helm, crd, enums, enterprise-gating/)
  })

  test('makeDiff produces what git diff produces', () => {
    const fromGit = git(repo, ['diff', baseSha, 'HEAD', '--', CC]).split('\n').filter((l) => !/^index /.test(l))
    const fromHelper = makeDiff({ [CC]: SOURCE }, { [CC]: SOURCE.replace('      false) {}', '      true) {}') }).trimEnd().split('\n').filter((l) => !/^index /.test(l))
    expect(fromHelper).toEqual(fromGit)
  })
})
