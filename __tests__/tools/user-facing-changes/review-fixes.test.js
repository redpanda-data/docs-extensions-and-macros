'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { detect, kinds, makeDiff } = require('./helpers')
const { detectUserFacingChanges, buildDocImpact, fingerprint } = require('../../../tools/user-facing-changes')
const { parseDiff } = require('../../../tools/user-facing-changes/diff')
const { parseInitializers } = require('../../../tools/user-facing-changes/detectors/properties')
const { parseMetrics } = require('../../../tools/user-facing-changes/detectors/metrics')
const { parseCppConstants } = require('../../../tools/user-facing-changes/detectors/constants')

/**
 * Cases from the review of the detectors against real redpanda,
 * redpanda-operator and helm-charts commits. Each one failed (a junk
 * finding, or a missed change with no note) before the fix it pins, so
 * each is its own negative control: run against the earlier detectors,
 * the assertion here fails. The sources are synthetic, in the shapes of
 * the commits named.
 */

const CLI = path.join(__dirname, '..', '..', '..', 'bin', 'doc-tools.js')

// ---------------------------------------------------------------------------
// Moves across files (review blocker 1)
// ---------------------------------------------------------------------------

const PLUGIN_DIR = 'src/go/rpk/pkg/cli/plugin'
const goFile = (body) => `package plugin\n\nimport (\n\t"github.com/spf13/cobra"\n)\n\n${body}`
const INSTALL_FN = `func newInstallCommand(fs afero.Fs) *cobra.Command {
	var (
		dir    string
		update bool
	)
	cmd := &cobra.Command{
		Use:   "install [NAME]",
		Short: "Install an rpk plugin",
	}
	cmd.Flags().StringVar(&dir, "dir", "", "Destination directory")
	cmd.Flags().BoolVarP(&update, "update", "u", false, "Update the plugin")
	return cmd
}
`
const PARENT_FN = `func NewCommand(fs afero.Fs) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "plugin",
		Short: "List, download, update, and remove rpk plugins",
	}
	cmd.AddCommand(
		newInstallCommand(fs),
	)
	return cmd
}
`

describe('a declaration moved to another file is not a removal plus an addition', () => {
  const base = { [`${PLUGIN_DIR}/plugin.go`]: goFile(PARENT_FN + '\n' + INSTALL_FN) }
  const head = {
    [`${PLUGIN_DIR}/plugin.go`]: goFile(PARENT_FN),
    [`${PLUGIN_DIR}/install.go`]: goFile(INSTALL_FN)
  }

  test('rpk: a command and its flags split into their own file (9cc703c882 shape)', () => {
    expect(detect(base, head, { detectors: ['rpk'] }).findings).toEqual([])
  })

  test('rpk: a default that changed on the way is one default-changed finding', () => {
    const changed = { ...head, [`${PLUGIN_DIR}/install.go`]: goFile(INSTALL_FN.replace('"update", "u", false', '"update", "u", true')) }
    expect(kinds(detect(base, changed, { detectors: ['rpk'] }))).toEqual([['default-changed', 'rpk plugin install --update']])
  })

  // Review 412 round 3: a move between published pages leaves both pages
  // stale, so it must stay a removal plus an addition.
  describe('across published pages', () => {
    const store = (cls, extra) => `${cls}::${cls}()\n  : keep_me(*this, "keep_me", "Keep.", {}, 1)${extra}\n{}\n`
    const PROP = '\n  , foo_enabled(*this, "foo_enabled", "Foo.", {}, false)'
    test('a property moved from node_config.cc (broker page) to configuration.cc (cluster page) is reported', () => {
      const N = 'src/v/config/node_config.cc'
      const C = 'src/v/config/configuration.cc'
      const r = detect({ [N]: store('node_config', PROP), [C]: store('configuration', '') }, { [N]: store('node_config', ''), [C]: store('configuration', PROP) }, { detectors: ['properties'] })
      expect(kinds(r).sort()).toEqual([['added', 'foo_enabled'], ['removed', 'foo_enabled']])
    })
    test('a property moved between two files of the cluster page is still a quiet move', () => {
      const C = 'src/v/config/configuration.cc'
      const D = 'src/v/config/cloud_configuration.cc'
      const r = detect({ [C]: store('configuration', PROP), [D]: store('cloud_configuration', '') }, { [C]: store('configuration', ''), [D]: store('cloud_configuration', PROP) }, { detectors: ['properties'] })
      expect(r.findings).toEqual([])
    })
    test('a Helm key moved from the redpanda chart to the console chart is reported', () => {
      const R = 'charts/redpanda/values.yaml'
      const K = 'charts/console/values.yaml'
      const r = detect({ [R]: 'keep: 1\nfoo:\n  enabled: true\n', [K]: 'keep: 1\n' }, { [R]: 'keep: 1\n', [K]: 'keep: 1\nfoo:\n  enabled: true\n' }, { detectors: ['helm'] })
      expect(r.findings.map((f) => [f.change_kind, f.file])).toEqual(expect.arrayContaining([['removed', R], ['added', K]]))
    })
    test('the same key changed in two charts is reported for each chart', () => {
      const R = 'charts/redpanda/values.yaml'
      const K = 'charts/console/values.yaml'
      const v = (cpu) => `resources:\n  cpu: ${cpu}\n`
      const r = detect({ [R]: v(1), [K]: v(1) }, { [R]: v(2), [K]: v(2) }, { detectors: ['helm'] })
      expect(r.findings.map((f) => f.file).sort()).toEqual([K, R])
    })
  })

  test('rpk: flags moved into a helper in the same package (3004b8f049 shape)', () => {
    const B = 'src/go/rpk/pkg/cli/debug/bundle/bundle.go'
    const C = 'src/go/rpk/pkg/cli/debug/bundle/common.go'
    const bundle = (flags) => `package bundle

func NewCommand(fs afero.Fs) *cobra.Command {
	var opts Options
	cmd := &cobra.Command{
		Use:   "bundle",
		Short: "Collect a debug bundle",
	}
	f := cmd.Flags()
${flags}
	return cmd
}
`
    const direct = '\tf.StringVar(&opts.since, "logs-since", "", "Logs since")\n\tf.IntVar(&opts.samples, "metrics-samples", 2, "Samples")'
    const helper = `package bundle

func (o *Options) InstallFlags(f *pflag.FlagSet) {
	f.StringVar(&o.since, "logs-since", "", "Logs since")
	f.IntVar(&o.samples, "metrics-samples", 2, "Samples")
}
`
    const r = detect({ [B]: bundle(direct) }, { [B]: bundle('\topts.InstallFlags(f)'), [C]: helper }, { detectors: ['rpk'] })
    expect(r.findings).toEqual([])
    // Negative control: the helper changing a default is still seen.
    const r2 = detect({ [B]: bundle(direct) }, { [B]: bundle('\topts.InstallFlags(f)'), [C]: helper.replace('"metrics-samples", 2', '"metrics-samples", 5') }, { detectors: ['rpk'] })
    expect(kinds(r2)).toEqual([['default-changed', 'rpk debug bundle --metrics-samples']])
  })

  test('api: a message moved into a common package keeps its fields (3ba142fe14 shape)', () => {
    const LINK = 'proto/redpanda/core/admin/v2/shadow_link.proto'
    const TLS = 'proto/redpanda/core/common/v1/tls.proto'
    const tls = 'message TLSSettings {\n  bool enabled = 1;\n  string ca_path = 2;\n}\n'
    const opts = (type) => `syntax = "proto3";\npackage redpanda.core.admin.v2;\n\nmessage ShadowLinkClientOptions {\n  ${type} tls_settings = 1;\n}\n`
    const r = detect(
      { [LINK]: opts('TLSSettings') + tls },
      { [LINK]: opts('redpanda.core.common.v1.TLSSettings'), [TLS]: 'syntax = "proto3";\npackage redpanda.core.common.v1;\n\n' + tls }
    )
    expect(r.findings).toEqual([])
  })

  test('api: a type that only changed package is the same type (9f6f065168 shape)', () => {
    const F = 'proto/redpanda/core/admin/v2/acl.proto'
    const msg = (t) => `syntax = "proto3";\nmessage ACLResourceFilter {\n  ${t} resource_type = 1;\n}\n`
    expect(detect({ [F]: msg('common.ACLResourceType') }, { [F]: msg('common.v1.ACLResourceType') }).findings).toEqual([])
    // Negative control: a different type is still a change.
    expect(kinds(detect({ [F]: msg('common.ACLResourceType') }, { [F]: msg('common.v1.ACLPatternType') }))).toEqual([['behaviour', 'ACLResourceFilter.resource_type']])
  })
})

// ---------------------------------------------------------------------------
// Helm (review blockers 2 and 5, nits)
// ---------------------------------------------------------------------------

describe('helm', () => {
  const V = 'charts/redpanda/chart/values.yaml'
  const values = (tag) => `statefulset:\n  sideCars:\n    image:\n      tag: ${tag}\n      repository: docker.redpanda.com/redpandadata/redpanda-operator\n`

  test('a release cut that bumps an image tag is low and opens no dispatch (redpanda-operator#2010)', () => {
    const r = detect({ [V]: values('v26.2.4') }, { [V]: values('v26.2.5') })
    expect(r.findings.map((f) => [f.severity, f.name])).toEqual([['low', 'statefulset.sideCars.image.tag']])
    expect(buildDocImpact(r)).toBeNull()
    // Negative control: a real value change still opens it.
    const r2 = detect({ [V]: values('v26.2.4').replace('redpanda-operator', 'other') }, { [V]: values('v26.2.4').replace('redpanda-operator', 'other2') })
    expect(r2.findings[0].severity).toBe('high')
    expect(buildDocImpact(r2)).not.toBeNull()
  })

  test('a key helm-docs ignores is not reported', () => {
    const doc = (v) => `# -- Shown.\nshown: 1\n# @ignored\n# Hidden from the reference.\nmulticluster:\n  enabled: ${v}\n`
    expect(detect({ [V]: doc('false') }, { [V]: doc('true') }).findings).toEqual([])
  })

  test('operator/chart/values.yaml is routed to the operator Helm reference', () => {
    const O = 'operator/chart/values.yaml'
    const r = detect({ [O]: 'monitoring:\n  enabled: false\n' }, { [O]: 'monitoring:\n  enabled: false\n  clusterLabel:\n    enabled: false\n' })
    expect(kinds(r)).toEqual([['added', 'monitoring.clusterLabel']])
    expect(r.findings[0].affected_pages).toEqual(['https://docs.redpanda.com/streaming/current/reference/k-operator-helm-spec/'])
  })

  test('an empty map that becomes a scalar is a changed default', () => {
    expect(kinds(detect({ [V]: 'a: {}\n' }, { [V]: 'a: 5\n' }))).toEqual([['default-changed', 'a']])
  })
})

// ---------------------------------------------------------------------------
// C++ digit separators (review blocker 3)
// ---------------------------------------------------------------------------

describe('digit separators', () => {
  const CC = 'src/v/config/configuration.cc'
  const src = (v) => `configuration::configuration()
  : group_new_member_join_timeout(
      *this,
      "group_new_member_join_timeout",
      "Timeout for new member joins.",
      {.needs_restart = needs_restart::no, .visibility = visibility::tunable},
      ${v})
  , next_property(*this, "next_property", "Next.", {}, 1)
{}
`
  test('an initializer with a separator parses, and its default is compared by value', () => {
    const { decls, unresolved } = parseInitializers([{ startLine: 1, text: src("30'000ms") }])
    expect(unresolved).toEqual([])
    expect(decls.get('group_new_member_join_timeout').defaultText).toBe("30'000ms")
    expect(decls.has('next_property')).toBe(true)
    expect(kinds(detect({ [CC]: src("30'000ms") }, { [CC]: src("45'000ms") }))).toEqual([['default-changed', 'group_new_member_join_timeout']])
    expect(detect({ [CC]: src("30'000ms") }, { [CC]: src('30s') }).findings).toEqual([])
  })

  test('a char literal is still a char literal', () => {
    const { decls } = parseInitializers([{ startLine: 1, text: src("'a'") }])
    expect(decls.get('group_new_member_join_timeout').defaultText).toBe("'a'")
  })

  test('constants and metrics read past a separator', () => {
    const { defs } = parseCppConstants([{ startLine: 1, text: "constexpr int64_t a = 1'000;\nconstexpr int64_t b = 2;\n" }])
    expect([...defs.keys()]).toEqual(['a', 'b'])
    const text = `void p::setup() {
    _metrics.add_group("kafka", {
      sm::make_gauge("a", [] { return 1'000'000'000; }, sm::description("A")),
      sm::make_gauge("in_progress", [] { return 1; }, sm::description("B")),
    });
}
`
    expect([...parseMetrics([{ startLine: 1, text }]).metrics.keys()]).toEqual(['vectorized_kafka_a', 'vectorized_kafka_in_progress'])
  })

  test('with whole files, an initializer that still does not parse is a note, not silence', () => {
    const r = detect({ [CC]: src('1') }, { [CC]: src('broken(') })
    expect(r.notes.map((n) => n.message).join('\n')).toMatch(/could not parse the initializer of group_new_member_join_timeout/)
  })
})

// ---------------------------------------------------------------------------
// CRD (review blocker 4, should-fix 10, nits)
// ---------------------------------------------------------------------------

describe('crd', () => {
  const T = 'operator/api/redpanda/v1alpha2/shadow_link_types.go'
  const struct = (name, extra = '') => `package v1alpha2\n\ntype ${name} struct { // the spec\n\t// +kubebuilder:default={"a":1}\n\tOptions *Options \`json:"options,omitempty"\`\n${extra}}\n`

  test('generated apply configurations, zz_generated and conversion files are not routed', () => {
    for (const p of ['operator/api/applyconfiguration/redpanda/v1alpha2/shadowlinkspec.go', 'operator/api/redpanda/v1alpha2/zz_generated.deepcopy.go', 'operator/api/redpanda/v1alpha2/conversion/convert.go']) {
      expect(detect({ [p]: struct('X') }, { [p]: struct('X', '\tEnabled bool `json:"enabled"`\n') }).findings).toEqual([])
    }
    // Negative control: the same change in the real types file is a finding.
    expect(kinds(detect({ [T]: struct('X') }, { [T]: struct('X', '\tEnabled bool `json:"enabled"`\n') }))).toEqual([['added', 'X.enabled']])
  })

  test('a JSON default that only changed layout is the same default', () => {
    expect(detect({ [T]: struct('X') }, { [T]: struct('X').replace('{"a":1}', '{"a": 1}') }).findings).toEqual([])
    expect(kinds(detect({ [T]: struct('X') }, { [T]: struct('X').replace('{"a":1}', '{"a": 2}') }))).toEqual([['default-changed', 'X.options']])
  })

  test('a Go type rename with the same json fields is not removals plus additions (ea7d12de shape)', () => {
    const plain = (n) => struct(n).replace(' // the spec', '')
    expect(detect({ [T]: plain('Migration') }, { [T]: plain('DeprecatedMigration') }).findings).toEqual([])
  })

  test('a struct opener with a trailing comment is parsed', () => {
    expect(kinds(detect({ [T]: struct('X') }, { [T]: struct('X', '\tEnabled bool `json:"enabled"`\n') }))).toEqual([['added', 'X.enabled']])
  })

  test('a new Enum marker value is reported', () => {
    const e = (v) => `package v1alpha2\n\n// +kubebuilder:validation:Enum=${v}\ntype SchemaType string\n`
    expect(kinds(detect({ [T]: e('avro;protobuf') }, { [T]: e('avro;protobuf;json') }))).toEqual([['added', 'SchemaType=json']])
  })
})

// ---------------------------------------------------------------------------
// Workflow-facing CLI behaviour (review should-fix 7 and 14, nits)
// ---------------------------------------------------------------------------

describe('the CLI', () => {
  const run = (args) => spawnSync(process.execPath, [CLI, 'detect-user-facing-changes', ...args], { encoding: 'utf8' })

  test('an unreadable patch reports an error, not an empty clean report', () => {
    const r = run(['--patch', path.join(os.tmpdir(), 'no-such.diff'), '--format', 'json'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.findings).toEqual([])
    expect(out.error).toMatch(/no-such\.diff/)
  })

  test('an unknown detector id is an error, not a clean run', () => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-')), 'x.diff')
    fs.writeFileSync(p, '')
    const out = JSON.parse(run(['--patch', p, '--detectors', 'propertys', '--format', 'json']).stdout)
    expect(out.error).toMatch(/unknown detector id\(s\): propertys/)
  })

  test('a detector crash is an error on the report', () => {
    const { DETECTORS } = require('../../../tools/user-facing-changes')
    const rpk = DETECTORS.find((d) => d.id === 'rpk')
    const orig = rpk.detect
    rpk.detect = () => { throw new Error('boom') }
    try {
      const r = detect({ 'src/go/rpk/pkg/cli/x.go': 'package x\n' }, { 'src/go/rpk/pkg/cli/x.go': 'package x\n// y\n' })
      expect(r.errors).toEqual(['rpk: boom'])
    } finally { rpk.detect = orig }
  })

  test('--dispatched leaves out findings an earlier push dispatched, by a fingerprint that ignores line shifts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-'))
    const patch = path.join(dir, 'p.diff')
    // A saved diff of a new property (readable from the hunks alone).
    const CC = 'src/v/config/configuration.cc'
    const prop = (extra) => `configuration::configuration()\n  : a(*this, "a", "A.", {}, 1)${extra}\n{}\n`
    fs.writeFileSync(patch, makeDiff({ [CC]: prop('') }, { [CC]: prop('\n  , b(*this, "b", "B.", {}, 2)') }))
    const first = JSON.parse(run(['--patch', patch, '--format', 'json']).stdout)
    expect(first.findings.map((f) => f.name)).toEqual(['b'])
    // Every finding's fingerprint, past the ticket's cap too, for the workflow to record.
    expect(first.summary.fingerprints).toEqual([first.findings[0].fingerprint])
    const seen = path.join(dir, 'seen.txt')
    fs.writeFileSync(seen, first.findings[0].fingerprint + '\n')
    const second = JSON.parse(run(['--patch', patch, '--dispatched', seen, '--format', 'json']).stdout)
    expect(second.findings).toEqual([])
    expect(second.summary.alreadyDispatched).toBe(1)
    // The same finding at another line keeps its fingerprint.
    const f = first.findings[0]
    expect(fingerprint({ ...f, line: f.line + 10, summary: f.summary.replace(/:(\d+)/g, (_, n) => `:${Number(n) + 10}`) })).toBe(f.fingerprint)
  })

  test('--patch --repo without --base reads the pre-image at the parent of --head', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-repo-'))
    const git = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' })
    git('init', '-q')
    const F = 'src/go/rpk/pkg/cli/debug/bundle.go'
    fs.mkdirSync(path.join(repo, path.dirname(F)), { recursive: true })
    const body = (d) => `package debug\n\nfunc NewCommand() *cobra.Command {\n\tcmd := &cobra.Command{\n\t\tUse: "bundle",\n\t}\n\tf := cmd.Flags()\n${'\t// pad\n'.repeat(8)}\tf.StringVar(&since, "logs-since", ${d}, "Since")\n\treturn cmd\n}\n`
    fs.writeFileSync(path.join(repo, F), body('""'))
    git('add', '.'); git('commit', '-qm', 'a')
    fs.writeFileSync(path.join(repo, F), body('"yesterday"'))
    git('commit', '-qam', 'b')
    const patch = path.join(repo, '..', `${path.basename(repo)}.diff`)
    fs.writeFileSync(patch, git('diff', '-U1', 'HEAD^', 'HEAD').stdout)
    const out = JSON.parse(spawnSync(process.execPath, [CLI, 'detect-user-facing-changes', '--patch', patch, '--repo', repo, '--format', 'json'], { encoding: 'utf8' }).stdout)
    expect(out.findings.map((x) => [x.change_kind, x.name])).toEqual([['default-changed', 'rpk debug bundle --logs-since']])
  })
})

// ---------------------------------------------------------------------------
// rpk command paths, helpers and deprecations (should-fix 8, 9, 10)
// ---------------------------------------------------------------------------

describe('rpk', () => {
  const ST = 'src/go/rpk/pkg/cli/cluster/selftest'
  const selftest = `package selftest\n\nfunc NewSelfTestCommand() *cobra.Command {\n\tcmd := &cobra.Command{\n\t\tUse: "self-test",\n\t}\n\tcmd.AddCommand(newStartCommand())\n\treturn cmd\n}\n`
  const start = (flag) => `package selftest\n\nfunc newStartCommand() *cobra.Command {\n\tvar d int\n\tcmd := &cobra.Command{\n\t\tUse: "start",\n\t}\n${flag}\treturn cmd\n}\n`

  test('a directory is named by its own command\'s Use (selftest is self-test)', () => {
    const b = { [`${ST}/selftest.go`]: selftest, [`${ST}/start.go`]: start('') }
    const h = { ...b, [`${ST}/start.go`]: start('\tcmd.Flags().IntVar(&d, "duration", 1, "How long")\n') }
    expect(kinds(detect(b, h, { detectors: ['rpk'] }))).toEqual([['added', 'rpk cluster self-test start --duration']])
  })

  test('each flag belongs to the command its function builds (cluster/logdirs.go)', () => {
    const F = 'src/go/rpk/pkg/cli/cluster/logdirs.go'
    const src = (extra) => `package cluster

func newLogdirsCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use: "logdirs",
	}
	cmd.AddCommand(newLogdirsDescribeCommand())
	return cmd
}

func newLogdirsDescribeCommand() *cobra.Command {
	var broker int32
	cmd := &cobra.Command{
		Use: "describe",
	}
	cmd.Flags().Int32VarP(&broker, "broker", "b", -1, "Broker")
${extra}	return cmd
}
`
    const r = detect({ [F]: src('') }, { [F]: src('\tcmd.Flags().BoolVar(&human, "human-readable", false, "Human")\n') }, { detectors: ['rpk'] })
    expect(kinds(r)).toEqual([['added', 'rpk cluster logdirs describe --human-readable']])
  })

  test('a rename that keeps the old name as an alias says so, at medium (7f5d10c74b)', () => {
    const F = 'src/go/rpk/pkg/cli/cluster/info.go'
    const src = (use, aliases) => `package cluster\n\nfunc newInfoCommand() *cobra.Command {\n\tcmd := &cobra.Command{\n\t\tUse:     "${use}",\n\t\tAliases: []string{${aliases}},\n\t}\n\treturn cmd\n}\n`
    const r = detect({ [F]: src('metadata', '"status", "info"') }, { [F]: src('info', '"status", "metadata"') }, { detectors: ['rpk'] })
    expect(kinds(r)).toEqual([['renamed', 'rpk cluster info']])
    expect(r.findings[0].severity).toBe('medium')
    expect(r.findings[0].summary).toMatch(/stays as an alias/)
  })

  test('DeprecateCmd around a child built in a sibling file is that command\'s deprecation (7bca849722)', () => {
    const D = 'src/go/rpk/pkg/cli/redpanda/admin/config'
    const parent = (wrap) => `package config\n\nfunc NewCommand() *cobra.Command {\n\tcmd := &cobra.Command{\n\t\tUse: "config",\n\t}\n\tcmd.AddCommand(\n\t\t${wrap ? 'cobraext.DeprecateCmd(newPrintCommand(), "rpk cluster config list --node-id <ID>")' : 'newPrintCommand()'},\n\t)\n\treturn cmd\n}\n`
    const print = 'package config\n\nfunc newPrintCommand() *cobra.Command {\n\tcmd := &cobra.Command{\n\t\tUse: "print",\n\t}\n\treturn cmd\n}\n'
    const b = { [`${D}/config.go`]: parent(false), [`${D}/print.go`]: print }
    const r = detect(b, { ...b, [`${D}/config.go`]: parent(true) }, { detectors: ['rpk'] })
    expect(kinds(r)).toEqual([['deprecated', 'rpk redpanda admin config print']])
  })

  test('a helper flag from an imported rpk package (InstallFormatFlag) is the command\'s flag', () => {
    const P = 'src/go/rpk/pkg/config/params.go'
    const F = 'src/go/rpk/pkg/cli/shadow/list.go'
    const params = 'package config\n\nfunc (p *Params) InstallFormatFlag(cmd *cobra.Command) {\n\tpf := cmd.PersistentFlags()\n\tpf.StringVar(&p.Kind, "format", "text", "Output format")\n}\n'
    const list = (install) => `package shadow\n\nimport (\n\t"github.com/redpanda-data/redpanda/src/go/rpk/pkg/config"\n)\n\nfunc newListCommand(p *config.Params) *cobra.Command {\n\tcmd := &cobra.Command{\n\t\tUse: "list",\n\t}\n${install ? '\tp.InstallFormatFlag(cmd)\n' : ''}\treturn cmd\n}\n`
    const r = detect({ [P]: params, [F]: list(true) }, { [P]: params, [F]: list(false) }, { detectors: ['rpk'] })
    expect(kinds(r)).toEqual([['removed', 'rpk shadow list --format']])
  })

  test('a default that only moved package is not a change (14ba431b2d)', () => {
    const F = 'src/go/rpk/pkg/cli/container/start.go'
    const src = (pkg) => `package container\n\nfunc newStartCommand() *cobra.Command {\n\tvar image string\n\tcmd := &cobra.Command{\n\t\tUse: "start",\n\t}\n\tcmd.Flags().StringVar(&image, "image", ${pkg}.DefaultRedpandaImage(), "Image")\n\treturn cmd\n}\n`
    expect(detect({ [F]: src('common') }, { [F]: src('containerutil') }, { detectors: ['rpk'] }).findings).toEqual([])
    expect(kinds(detect({ [F]: src('common') }, { [F]: src('common').replace('DefaultRedpandaImage', 'DefaultConsoleImage') }, { detectors: ['rpk'] }))).toEqual([['default-changed', 'rpk container start --image']])
  })

  test('strings.Count is not a flag', () => {
    const F = 'src/go/rpk/pkg/cli/topic/x.go'
    const src = (n) => `package topic\n\nfunc newXCommand() *cobra.Command {\n\tcmd := &cobra.Command{\n\t\tUse: "x",\n\t}\n\t_ = strings.Count("abc", "${n}")\n\treturn cmd\n}\n`
    expect(detect({ [F]: src('a') }, { [F]: src('b') }, { detectors: ['rpk'] }).findings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Properties (should-fix 11)
// ---------------------------------------------------------------------------

describe('properties', () => {
  const CC = 'src/v/config/configuration.cc'
  const src = (meta, def, rest = '') => `configuration::configuration()
  : disable_metrics(
      *this,
      "disable_metrics",
      "Disable the internal metrics endpoint.",
      ${meta},
      ${def}${rest})
{}
`
  test('base_property::metadata and a metadata-only .usable_before_ready are metadata, not the default (029d793085)', () => {
    const before = src('{.needs_restart = needs_restart::no}', 'false')
    expect(detect({ [CC]: before }, { [CC]: src('base_property::metadata{.usable_before_ready = usable_before_ready::yes}', 'false') }).findings).toEqual([])
    // Negative control: the real default changing under that metadata is seen.
    const meta = 'base_property::metadata{.usable_before_ready = usable_before_ready::yes}'
    expect(kinds(detect({ [CC]: src(meta, 'false') }, { [CC]: src(meta, 'true') }))).toEqual([['default-changed', 'disable_metrics']])
  })

  test('bounds and a legacy default are compared; a validator is not', () => {
    const m = '{.needs_restart = needs_restart::no}'
    expect(kinds(detect({ [CC]: src(m, '1_MiB', ',\n      {.min = 1_MiB}') }, { [CC]: src(m, '1_MiB', ',\n      {.min = 991_MiB}') }))).toEqual([['behaviour', 'disable_metrics']])
    const legacy = ',\n      property<bool>::noop_validator,\n      legacy_default<bool>(false, legacy_version{17})'
    const r = detect({ [CC]: src(m, 'true', legacy) }, { [CC]: src(m, 'true', ',\n      property<bool>::noop_validator') })
    expect(r.findings.map((f) => [f.detail, f.severity])).toEqual([['constraints-changed', 'high']])
    expect(detect({ [CC]: src(m, 'true', ',\n      [](bool) { return std::nullopt; }') }, { [CC]: src(m, 'true', ',\n      [](bool v) { return v ? std::nullopt : std::nullopt; }') }).findings).toEqual([])
  })

  test('a member renamed with its name literal unchanged is no change (9c71f3bcf4)', () => {
    const p = (member) => `configuration::configuration()\n  : ${member}(*this, "default_topic_replication", "Replicas.", {}, 1)\n{}\n`
    expect(detect({ [CC]: p('default_topic_replication') }, { [CC]: p('default_topic_replications') }).findings).toEqual([])
  })

  test('the proxy, schema registry and client config stores are routed to the broker page', () => {
    const P = 'src/v/pandaproxy/schema_registry/configuration.cc'
    const s = (extra) => `configuration::configuration()\n  : schema_registry_api(*this, "schema_registry_api", "API.", {}, 1)${extra}\n{}\n`
    const r = detect({ [P]: s('') }, { [P]: s('\n  , mode_mutability(*this, "mode_mutability", "Mode.", {}, true)') })
    expect(kinds(r)).toEqual([['added', 'mode_mutability']])
    expect(r.findings[0].affected_pages).toEqual(['https://docs.redpanda.com/streaming/current/reference/properties/broker-properties/'])
  })
})

// ---------------------------------------------------------------------------
// Metrics (should-fix 12)
// ---------------------------------------------------------------------------

describe('metrics', () => {
  test('an accessor receiver is a group, and the declared type picks the registry (group_probe.h, archival probe)', () => {
    const text = `class group_probe {
    void setup() {
        _public_metrics.emplace();
        _public_metrics.value().add_group(
          prometheus_sanitize::metrics_name("kafka:consumer:group"),
          {sm::make_gauge("lag_max", [] { return 1; }, sm::description("Lag"))});
        _service_metrics.add_group("cloud_storage", {sm::make_counter("uploaded_bytes", [] { return 1; }, sm::description("Up"))});
    }
    std::optional<metrics::public_metric_groups> _public_metrics;
    metrics::public_metric_groups _service_metrics;
};
`
    expect([...parseMetrics([{ startLine: 1, text }]).metrics.keys()]).toEqual(['redpanda_kafka_consumer_group_lag_max', 'redpanda_cloud_storage_uploaded_bytes'])
  })

  test('a parameter typed public_metric_groups is public even if another function reuses the name (net/probes.cc)', () => {
    const text = `void a(metrics::internal_metric_groups& mgs) {
    mgs.add_group("rpc", {sm::make_gauge("x", [] { return 1; }, sm::description("X"))});
}
void b(metrics::public_metric_groups& mgs) {
    mgs.add_group("rpc", {sm::make_gauge("y", [] { return 1; }, sm::description("Y"))});
}
`
    expect([...parseMetrics([{ startLine: 1, text }]).metrics.keys()]).toEqual(['vectorized_rpc_x', 'redpanda_rpc_y'])
  })

  test('a family replicated to the public endpoint is a new public metric (0e7f157e37)', () => {
    const F = 'src/v/redpanda/application.cc'
    const s = (extra) => `void application::setup_public_metrics() {\n    seastar::metrics::replicate_metric_families(\n      seastar::metrics::default_handle(),\n      {{"network_bytes_sent", metrics::public_metrics_handle}${extra}})\n      .get();\n}\n`
    expect(kinds(detect({ [F]: s('') }, { [F]: s(',\n       {"reactor_aio_reads", metrics::public_metrics_handle}') }))).toEqual([['added', 'redpanda_reactor_aio_reads']])
  })

  test('definitions pushed into a vector that both registries take are reported under both', () => {
    const text = `void p() {
    std::vector<sm::metric_definition> defs;
    defs.emplace_back(sm::make_gauge("leaders", [] { return 1; }, sm::description("L")));
    _metrics.add_group("raft", defs);
    _public_metrics.add_group("raft", defs);
}
metrics::internal_metric_groups _metrics;
metrics::public_metric_groups _public_metrics;
`
    expect([...parseMetrics([{ startLine: 1, text }]).metrics.keys()].sort()).toEqual(['redpanda_raft_leaders', 'vectorized_raft_leaders'])
  })

  test('a group name held in a constant is resolved (controller_probe.cc)', () => {
    const text = 'void p() {\n    constexpr static auto prefix = "cluster";\n    _public_metrics->add_group(prometheus_sanitize::metrics_name(prefix), {sm::make_gauge("brokers", [] { return 1; }, sm::description("B"))});\n}\n'
    expect([...parseMetrics([{ startLine: 1, text }]).metrics.keys()]).toEqual(['redpanda_cluster_brokers'])
  })
})

// ---------------------------------------------------------------------------
// Diff parsing and names (nits)
// ---------------------------------------------------------------------------

describe('diff parsing', () => {
  test('a quoted non-ASCII path is its own file', () => {
    const d = [
      'diff --git a/src/a.go b/src/a.go', '--- a/src/a.go', '+++ b/src/a.go', '@@ -1 +1 @@', '-x', '+y',
      'diff --git "a/src/caf\\303\\251.go" "b/src/caf\\303\\251.go"', '--- "a/src/caf\\303\\251.go"', '+++ "b/src/caf\\303\\251.go"', '@@ -1 +1 @@', '-p', '+q', ''
    ].join('\n')
    expect(parseDiff(d).map((f) => [f.path, f.hunks.length])).toEqual([['src/a.go', 1], ['src/café.go', 1]])
  })

  test('a path with a space loses git\'s trailing TAB', () => {
    const d = ['diff --git a/a b.go b/a b.go', '--- a/a b.go\t', '+++ b/a b.go\t', '@@ -1 +1 @@', '-x', '+y', ''].join('\n')
    expect(parseDiff(d)[0].path).toBe('a b.go')
  })

  test('a removed line whose text starts "-- " is hunk content', () => {
    const d = ['diff --git a/x.sql b/x.sql', '--- a/x.sql', '+++ b/x.sql', '@@ -1,2 +1,1 @@', '--- a comment', ' keep', ''].join('\n')
    const f = parseDiff(d)[0]
    expect(f.oldPath).toBe('x.sql')
    expect(f.hunks[0].lines.map((l) => l.sign + l.text)).toEqual(['--- a comment', ' keep'])
  })

  test('a finding name cannot carry a newline into a ticket title or a log line', () => {
    const V = 'charts/redpanda/values.yaml'
    const r = detect({ [V]: 'a: 1\n' }, { [V]: 'a: 1\n"x\\n::warning title=x::pwned": 1\n' })
    expect(r.findings[0].name).toBe('x ::warning title=x::pwned')
    expect(r.findings[0].name).not.toMatch(/\n/)
  })

  test('the whole registry runs clean over an unrouted diff (no regression from the move pairing)', () => {
    expect(detectUserFacingChanges(makeDiff({ 'README.md': 'a\n' }, { 'README.md': 'b\n' })).findings).toEqual([])
  })
})
