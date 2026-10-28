'use strict'

// Each test quotes its source from the real repos: docs 84bd0514, cloud-docs
// 089d5cf, adp-docs c4fdb86. The scan runs through scanAll, the same path the
// CLI takes, with the fixture as an explicit --data-file.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { scanAll } = require('../../../tools/reference-values')

const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'rpkval', 'rpk-v26.2.2-sample.json')
const temps = []

function repo (files, { name = 'streaming', version = '26.2', attributes = {}, data } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-scan-'))
  temps.push(dir)
  const attrs = Object.entries(attributes).map(([k, v]) => `    ${k}: ${v}`).join('\n')
  fs.writeFileSync(path.join(dir, 'antora.yml'), `name: ${name}\nversion: ${version === '' ? '~' : `'${version}'`}\n${attrs ? `asciidoc:\n  attributes:\n${attrs}\n` : ''}`)
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), content)
  }
  const dataFile = path.join(dir, 'rpk-v26.2.2.json')
  fs.writeFileSync(dataFile, data ? JSON.stringify(data) : fs.readFileSync(FIXTURE))
  return { dir, dataFile }
}

const scan = (files, opts = {}) => {
  const { dir, dataFile } = repo(files, opts)
  return scanAll({ docsDir: dir, dataFiles: [dataFile], kinds: ['rpk'], kindsExplicit: true, failOn: opts.failOn || 'mismatch' })
}
const findings = (files, opts) => scan(files, opts).kinds.rpk.findings
const block = (...lines) => ['[,bash]', '----', ...lines, '----', ''].join('\n')
const page = (body) => `= Page\n\n${body}\n`

afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
})

describe('rpk reference findings on real lines', () => {
  test('docs develop/pages/data-transforms/deploy.adoc:85: --from-timestamp is unknown-flag', () => {
    const [f] = findings({ 'modules/develop/pages/deploy.adoc': page(block('rpk transform deploy --from-timestamp @<unix-timestamp>')) })
    expect(f).toMatchObject({ status: 'reference', reason: 'unknown-flag', severity: 'error', command: 'rpk transform deploy', flag: 'from-timestamp', failing: true })
  })

  test('docs manage-throughput.adoc:565: rpk cluster quotas delete is unknown-command', () => {
    const [f] = findings({ 'modules/manage/pages/manage-throughput.adoc': page(block('rpk cluster quotas delete --name user=alice')) })
    expect(f).toMatchObject({ status: 'reference', reason: 'unknown-command', severity: 'error', command: 'rpk cluster quotas delete' })
  })

  test('docs continuous-data-balancing.adoc:101: movement-cancel is unknown-command, suggesting move-cancel', () => {
    const [f] = findings({ 'modules/manage/pages/cdb.adoc': page(block('rpk cluster partitions movement-cancel --node 1')) })
    expect(f).toMatchObject({ reason: 'unknown-command' })
    expect(f.note).toContain('Did you mean: move-cancel?')
  })

  test('docs failover-runbook.adoc:54: --brokers is unknown-flag, maybe hidden or legacy', () => {
    const [f] = findings({ 'modules/manage/pages/runbook.adoc': page(block('# Check if the primary cluster is responding', 'rpk cluster info --brokers prod-cluster-1.example.com:9092,prod-cluster-2.example.com:9092')) })
    expect(f).toMatchObject({ reason: 'unknown-flag', flag: 'brokers', line: 6 })
    expect(f.note).toBe('--brokers is not documented for rpk cluster info in rpk v26.2.2; it may be hidden or legacy')
  })

  test('cloud-docs cloud-authentication.adoc:800: --tls-enabled is unknown-flag', () => {
    const list = findings({ 'modules/security/pages/auth.adoc': page(block('rpk topic create test-topic --tls-enabled --tls-cert=/path/to/tls.crt --tls-key=/path/to/tls.key')) }, { name: 'cloud-data-platform', version: '', attributes: { 'env-cloud': true } })
    expect(list.map((f) => [f.reason, f.flag])).toEqual([['unknown-flag', 'tls-enabled'], ['unknown-flag', 'tls-cert'], ['unknown-flag', 'tls-key']])
  })

  test('cloud-docs monitor-redpanda.adoc:225: --datasource on a continuation line is unknown-flag, on its own line', () => {
    const list = findings({ 'modules/manage/partials/monitor.adoc': page(block('rpk generate grafana-dashboard \\', '  --datasource prometheus \\', '  --metrics-endpoint <broker-address>:9644/metrics > redpanda-dashboard.json')) })
    expect(list.map((f) => [f.flag, f.line])).toEqual([['datasource', 6], ['metrics-endpoint', 7]])
  })

  test('docs migrate/pages/console-v3.adoc:738: --principal is unknown-flag', () => {
    const [f] = findings({ 'modules/migrate/pages/console-v3.adoc': page(block('# Check existing ACLs for user', 'rpk security acl list --principal User:alice')) })
    expect(f).toMatchObject({ reason: 'unknown-flag', flag: 'principal' })
  })

  test('rpk registry --schema-context .staging mode set resolves cleanly', () => {
    expect(findings({ 'modules/manage/pages/contexts.adoc': page(block('rpk registry --schema-context .staging mode set')) })).toEqual([])
  })

  test('docs io-optimization.adoc:25: rpk redpanda start --io-properties-file is pass-through', () => {
    const [f] = findings({ 'modules/manage/pages/io-optimization.adoc': page(block("rpk redpanda start --io-properties-file '<io-properties-file-path>'")) })
    expect(f).toMatchObject({ status: 'unverifiable', reason: 'pass-through', failing: false })
  })

  test('docs iceberg-topics-aws-glue.adoc:78: rpk cloud byoc aws apply is runtime-plugin', () => {
    const [f] = findings({ 'modules/manage/pages/glue.adoc': page("For clusters created before March 2026, you must re-run `rpk cloud byoc aws apply --redpanda-id=<cluster-id>` to provision the Glue IAM policy before enabling Iceberg.") })
    expect(f).toMatchObject({ status: 'unverifiable', reason: 'runtime-plugin', failing: false })
  })

  test('a helm --set line produces no finding (docs k-production-deployment.adoc:57)', () => {
    expect(findings({ 'modules/deploy/pages/k.adoc': page('```bash\nhelm repo add jetstack https://charts.jetstack.io\nhelm install cert-manager jetstack/cert-manager \\\n  --set crds.enabled=true \\\n  --namespace cert-manager\n```') })).toEqual([])
  })

  test('a non-shell block is not read', () => {
    expect(findings({ 'modules/x/pages/y.adoc': page('[source,yaml]\n----\nrpk: topic create --nope\n----') })).toEqual([])
  })
})

describe('rpk flag defaults in prose and tables', () => {
  // docs troubleshoot/pages/debug-bundle/configure/kubernetes.adoc:56-95.
  const DEBUG_BUNDLE = [
    '[[multicluster-debug-bundle]]',
    '=== Multicluster operator debug bundle',
    '',
    'The xref:reference:rpk/rpk-k8s/rpk-k8s-multicluster-bundle.adoc[`rpk k8s multicluster bundle`] command collects the operator Pod and Deployment, logs, `/metrics` samples, Raft status, and TLS material from every Kubernetes cluster in a Stretch Cluster, and writes one ZIP file to your local machine.',
    '',
    '==== Prerequisites',
    '',
    '- xref:reference:rpk/index.adoc[`rpk`] version 26.2 or later with the xref:reference:rpk/rpk-k8s/rpk-k8s.adoc[`k8s` plugin]. `rpk` installs the plugin the first time you run an `rpk k8s` command, or you can install it in advance with `rpk k8s install`.',
    '',
    '==== Capture options',
    '',
    'Set these flags when you run the command. There is no persistent configuration.',
    '',
    '[cols="2,1,3"]',
    '|===',
    '| Option | Default | Description',
    '',
    '| `--include-private-keys`',
    '| off',
    '| Keep `tls.key` and the cached peer `kubeconfig.yaml` payloads in the serialized Secrets. By default both are redacted. Leave this off unless Redpanda Support asks for the keys.',
    '',
    '| `--logs-size-limit`, `--logs-tail-lines`',
    '| `5M`, `5000`',
    '| Cap the operator log collected from each cluster, by bytes and by lines.',
    '',
    '| `--metrics-samples`, `--metrics-interval`',
    '| `2`, `10s`',
    '| Number of `/metrics` scrapes per cluster, minimum `2`, and the interval between them.',
    '',
    '| `--namespace`',
    '| `redpanda`',
    '| The namespace that the Redpanda Operator runs in.',
    '|===',
  ].join('\n')

  test('the kubernetes.adoc Default table: 5000, 2 and 10s exact; 5M and redpanda exact after quote stripping; off is plugin-unknown; none auto-safe', () => {
    const list = findings({ 'modules/troubleshoot/pages/debug-bundle/configure/kubernetes.adoc': page(DEBUG_BUNDLE) })
    const by = Object.fromEntries(list.map((f) => [f.flag, f]))
    for (const flag of ['logs-size-limit', 'logs-tail-lines', 'metrics-samples', 'metrics-interval', 'namespace']) {
      expect(by[flag]).toMatchObject({ status: 'exact', command: 'rpk k8s multicluster bundle', association: 'table-default-column', autoSafe: false, source: 'help' })
    }
    expect(by['logs-size-limit'].dataValue).toBe('5M')
    expect(by.namespace.dataValue).toBe('redpanda')
    expect(by['include-private-keys']).toMatchObject({ status: 'unverifiable', reason: 'plugin-unknown' })
    expect(list.some((f) => f.autoSafe)).toBe(false)
  })

  // adp-docs modules/monitor/pages/audit-log.adoc:213-259.
  const AUDIT_LOG = [
    '[[read-from-the-cli]]',
    '== Read the audit log from the CLI',
    '',
    'The same events are available from the command line with `rpk ai auditlog`, which is useful for scripted reviews and for pulling a window of events into a file.',
    '',
    '[,bash]',
    '----',
    'rpk ai auditlog list --since 1h --denied',
    '----',
    '',
    'The window defaults to the last 24 hours. Pass `--since` an RFC 3339 timestamp, a duration such as `15m`, `24h`, `7d`, or `2w`, or `all` for no lower bound, and `--until` to close the window.',
    '',
    'A listing prints at most 50 entries by default. Pass `--limit 0` to return everything.',
  ].join('\n')

  test('adp-docs audit-log.adoc:259: --limit 50 is exact and not auto-safe (scraped)', () => {
    const list = findings({ 'modules/monitor/pages/audit-log.adoc': page(AUDIT_LOG) }, { name: 'agentic-data-plane', version: '', attributes: { 'env-adp': true } })
    const limit = list.find((f) => f.flag === 'limit')
    expect(limit).toMatchObject({ status: 'exact', written: '50', dataValue: '50', command: 'rpk ai auditlog list', source: 'help', autoSafe: false })
  })

  test('adp-docs audit-log.adoc:230: "24 hours" is equivalent to 24h', () => {
    const list = findings({ 'modules/monitor/pages/audit-log.adoc': page(AUDIT_LOG) }, { name: 'agentic-data-plane', version: '', attributes: { 'env-adp': true } })
    expect(list.find((f) => f.flag === 'since')).toMatchObject({ status: 'equivalent', written: '24 hours', dataValue: '24h', association: 'next-sentence' })
  })

  test('adp-docs cli/pages/index.adoc:227: --timeout "30 seconds" is unverifiable plugin-unknown', () => {
    const text = [
      '== Inspect an MCP server',
      '',
      '[,bash]',
      '----',
      'rpk ai mcp-server ping handbook',
      '----',
      '',
      'The `ping`, `resources`, `resource-templates`, and `prompts` commands print JSON, or YAML with `-o yaml`. Each command accepts `--timeout`, which covers the connection and the request together and defaults to 30 seconds.',
    ].join('\n')
    const [f] = findings({ 'modules/cli/pages/index.adoc': page(text) }, { name: 'agentic-data-plane', version: '', attributes: { 'env-adp': true } })
    expect(f).toMatchObject({ status: 'unverifiable', reason: 'plugin-unknown', command: 'rpk ai mcp-server ping', flag: 'timeout' })
  })

  test('a core flag stated in the same sentence is exact and auto-safe', () => {
    const [f] = findings({ 'modules/develop/pages/t.adoc': page('The `rpk topic create` flag `--partitions` defaults to -1.') })
    expect(f).toMatchObject({ status: 'exact', autoSafe: false })
    const [g] = findings({ 'modules/develop/pages/t.adoc': page('== Create\n\n[,bash]\n----\nrpk topic create orders\n----\n\nThe `--partitions` flag defaults to -1.') })
    expect(g).toMatchObject({ status: 'exact', autoSafe: true, proposed: 'rpkval:partitions[command=rpk topic create]', command: 'rpk topic create', commandFrom: 'section' })
  })

  test('a mutated fixture default turns a matching claim into mismatch for a core flag and plugin-help-default for a plugin flag', () => {
    const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
    data.tree.commands.find((c) => c.name === 'topic').commands.find((c) => c.name === 'create').flags.find((f) => f.name === 'partitions').default = 3
    data.tree.commands.find((c) => c.name === 'ai').commands.find((c) => c.name === 'auditlog').commands.find((c) => c.name === 'list').flags.find((f) => f.name === 'limit').default = '"40"'
    const core = findings({ 'modules/develop/pages/t.adoc': page('== Create\n\n[,bash]\n----\nrpk topic create orders\n----\n\nThe `--partitions` flag defaults to -1.') }, { data })
    expect(core[0]).toMatchObject({ status: 'mismatch', failing: true, dataValue: '3' })
    const plugin = findings({ 'modules/monitor/pages/audit-log.adoc': page(AUDIT_LOG) }, { name: 'agentic-data-plane', version: '', attributes: { 'env-adp': true }, data })
    expect(plugin.find((f) => f.flag === 'limit')).toMatchObject({ status: 'unverifiable', reason: 'plugin-help-default', failing: false })
  })

  test('docs release-notes/redpanda.adoc:171: a --console-image default in release notes is historical and never fails', () => {
    const result = scan({ 'modules/get-started/pages/release-notes/redpanda.adoc': page('* xref:reference:rpk/rpk-container/rpk-container-start.adoc[`rpk container start`]: `--console-image` default changed from `redpandadata/console:v3.7.1` to `redpandadata/console:v3.8.0`\n\n' + block('rpk cluster quotas delete')) }, { failOn: 'any' })
    expect(result.kinds.rpk.findings.length).toBeGreaterThan(0)
    expect(result.kinds.rpk.findings.every((f) => !f.failing)).toBe(true)
    expect(result.failing).toBe(0)
  })

  test('a flag no command defines (a helm or operator flag) is ignored', () => {
    expect(findings({ 'modules/x/pages/y.adoc': page('The `--wipe-stale-disk-after` flag defaults to 5m.') })).toEqual([])
  })

  test('a known flag with no command nearby is no-command-context', () => {
    const [f] = findings({ 'modules/x/pages/y.adoc': page('The `--if-not-exists` flag defaults to false.') })
    expect(f).toMatchObject({ status: 'unverifiable', reason: 'no-command-context' })
  })

  test('a Cloud scan marks a selfHostedOnly command cloud-unavailable', () => {
    const [f] = findings({ 'modules/x/pages/y.adoc': page('The `rpk cluster self-test start` flag `--disk-duration-ms` defaults to 30000.') }, { name: 'cloud-data-platform', version: '', attributes: { 'env-cloud': true } })
    expect(f).toMatchObject({ status: 'unverifiable', reason: 'cloud-unavailable' })
  })
})

describe('skips and suppression', () => {
  test('// value-check: ignore suppresses the finding on the next line and in the next block', () => {
    const result = scan({ 'modules/x/pages/y.adoc': page('// value-check: ignore\n' + block('rpk cluster quotas delete') + '\n' + block('rpk transform deploy --from-timestamp 1')) })
    expect(result.ignored).toBe(1)
    expect(result.kinds.rpk.findings.map((f) => f.reason)).toEqual(['unknown-flag'])
  })

  test('rpk reference pages and stub pages are skipped', () => {
    const result = scan({
      'modules/reference/pages/rpk/rpk-topic/rpk-topic-create.adoc': page(block('rpk cluster quotas delete')),
      'modules/reference/partials/rpk-topic/x.adoc': page(block('rpk cluster quotas delete')),
      'modules/manage/pages/stub.adoc': '= Stub\n:page-aliases: a.adoc\n\n// comment\ninclude::streaming:manage:page$x.adoc[]\n',
      'modules/manage/pages/real.adoc': page(block('rpk cluster quotas delete')),
    })
    expect(result.kinds.rpk.findings.map((f) => f.file)).toEqual(['modules/manage/pages/real.adoc'])
    expect(result.kinds.rpk.skippedStubs).toBe(1)
  })

  test('generated files are skipped', () => {
    const result = scan({ 'modules/x/pages/g.adoc': '= G\n// This content is autogenerated. Do not edit manually.\n\n' + block('rpk cluster quotas delete') })
    expect(result.kinds.rpk.findings).toEqual([])
    expect(result.kinds.rpk.skippedGenerated).toBe(1)
  })
})
