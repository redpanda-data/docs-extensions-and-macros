'use strict'

// Each test quotes its source from the real repos: cloud-docs 089d5cf and
// rp-connect-docs af33755. The scan runs through scanAll with the trimmed
// connect-4.114.0 fixture as an explicit --data-file.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { scanAll } = require('../../../tools/reference-values')

const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'connectval', 'connect-4.114.0-sample.json')
const temps = []

function repo (files, { name = 'connect', version = '', attributes = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-scan-'))
  temps.push(dir)
  const attrs = Object.entries(attributes).map(([k, v]) => `    ${k}: ${v}`).join('\n')
  fs.writeFileSync(path.join(dir, 'antora.yml'), `name: ${name}\nversion: ${version === '' ? '~' : `'${version}'`}\n${attrs ? `asciidoc:\n  attributes:\n${attrs}\n` : ''}`)
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), content)
  }
  const dataFile = path.join(dir, 'connect-4.114.0.json')
  fs.copyFileSync(FIXTURE, dataFile)
  return { dir, dataFile }
}
const scan = (files, opts = {}) => {
  const { dir, dataFile } = repo(files, opts)
  return scanAll({ docsDir: dir, dataFiles: [dataFile], kinds: ['connect'], kindsExplicit: true, failOn: opts.failOn || 'mismatch' })
}
// Link findings are tested in connect-links.test.js: these checkouts have no
// Connect pages, so every component xref in them is broken.
const findings = (files, opts) => scan(files, opts).kinds.connect.findings.filter((f) => f.check !== 'link')
const yaml = (...lines) => ['[source,yaml]', '----', ...lines, '----', ''].join('\n')
const page = (body) => `= Page\n\n${body}\n`
const CLOUD = { name: 'cloud-data-platform', attributes: { 'env-cloud': true } }

afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
})

// cloud-docs modules/develop/pages/connect/connect-quickstart.adoc:203-237.
const QUICKSTART = yaml(
  'input:',
  '  redpanda:',
  '    seed_brokers: # Required in Redpanda Cloud',
  '      - ${REDPANDA_BROKERS}',
  '    client_id: benthos # Optional (default: "benthos")',
  '    tls:',
  '      enabled: true # Optional (default: false)',
  '      client_certs: []',
  '    sasl:',
  '      - mechanism: SCRAM-SHA-256',
  '        username: ${secrets.KAFKA_USER_CONNECT}',
  '        password: ${secrets.KAFKA_PASSWORD_CONNECT}',
  '    metadata_max_age: 5m # Optional (default: "5m")',
  '    request_timeout_overhead: 10s # Optional (default: "10s")',
  '    topics: # Required (mutually exclusive with regexp_topics)',
  '      - dad-jokes',
  '    regexp_topics: false # Optional (default: false). Mutually exclusive with topics.',
  '    start_from_oldest: true # Optional (default: true)',
  'output:',
  '  drop: {}',
)

describe('Connect YAML on real lines', () => {
  const list = () => findings({ 'modules/develop/pages/connect/connect-quickstart.adoc': page(QUICKSTART) }, CLOUD)
  const at = (line, reason) => list().find((f) => f.line === line && (f.reason === reason || f.verdict === reason))

  test('connect-quickstart.adoc:208: the client_id comment default is stale', () => {
    expect(at(9, 'stale')).toMatchObject({ status: 'example-output', verdict: 'stale', fieldPath: 'client_id', written: 'benthos', dataValue: 'redpanda-connect', failing: true, target: 'connectval:[inputs/redpanda.client_id,default]' })
  })

  test('connect-quickstart.adoc:216: the metadata_max_age comment default is stale', () => {
    expect(at(17, 'stale')).toMatchObject({ fieldPath: 'metadata_max_age', written: '5m', dataValue: '1m' })
  })

  test('connect-quickstart.adoc:221 and :225 are deprecated fields, and their comments match', () => {
    expect(at(21, 'deprecated-field')).toMatchObject({ status: 'reference', severity: 'warning', fieldPath: 'regexp_topics', failing: false })
    expect(at(22, 'deprecated-field')).toMatchObject({ fieldPath: 'start_from_oldest' })
    expect(at(21, 'matches')).toBeDefined()
  })

  test('a nested field comment matches (tls.enabled)', () => {
    expect(at(11, 'matches')).toMatchObject({ fieldPath: 'tls.enabled', written: 'false' })
  })

  test('cloud-docs develop/examples/connect/producer-pipeline.yaml:54: the tls.enabled comment matches', () => {
    const text = [
      'output:',
      '  redpanda:',
      '    seed_brokers: # Required in Redpanda Cloud',
      '      - ${REDPANDA_BROKERS}',
      '    tls:',
      '      enabled: true # Optional (default: false)',
      '      client_certs: []',
      '    topic: dad-jokes # Optional',
    ].join('\n')
    const [f] = findings({ 'modules/develop/examples/connect/producer-pipeline.yaml': text }, CLOUD)
    expect(f).toMatchObject({ file: 'modules/develop/examples/connect/producer-pipeline.yaml', line: 6, verdict: 'matches', fieldPath: 'tls.enabled' })
  })

  test('rp-connect-docs cookbooks/pages/redpanda_migrator.adoc:301: regexp_topics is a deprecated field and kafka_franz a deprecated component', () => {
    const text = yaml(
      'http:',
      '  enabled: false',
      '',
      'input:',
      '  kafka_franz:',
      '    seed_brokers: [ "localhost:9092" ]',
      '    topics:',
      "      - '^[^_]' # Skip topics which start with `_`",
      '    regexp_topics: true',
      '    consumer_group: foobar',
      '',
      'output:',
      '  stdout: {}',
    )
    const list = findings({ 'modules/cookbooks/pages/redpanda_migrator.adoc': page(text) })
    expect(list.map((f) => [f.reason, f.component, f.fieldPath || ''])).toEqual([
      ['deprecated-component', 'kafka_franz', ''],
      ['deprecated-field', 'kafka_franz', 'regexp_topics'],
    ])
  })

  test('a typo field is unknown-field with a suggestion', () => {
    const [f] = findings({ 'modules/x/pages/y.adoc': page(yaml('input:', '  redpanda:', '    clinet_id: x')) })
    expect(f).toMatchObject({ status: 'reference', reason: 'unknown-field', severity: 'error', failing: true })
    expect(f.note).toContain('Did you mean: client_id?')
  })

  test('a kafka input and a kafka output resolve by their parent key', () => {
    const list = findings({ 'modules/x/pages/y.adoc': page(yaml('input:', '  kafka:', '    addresses: [ x ]', '    nope: 1', 'output:', '  kafka:', '    topic: t', '    nope: 1')) })
    expect(list.filter((f) => f.reason === 'deprecated-component').map((f) => f.componentType)).toEqual(['input', 'output'])
    expect(list.filter((f) => f.reason === 'unknown-field').map((f) => `${f.componentType}:${f.line}`)).toEqual(['input:8', 'output:12'])
  })

  test('${! } interpolation and ${VAR} parse', () => {
    const result = scan({ 'modules/x/pages/y.adoc': page(yaml('output:', '  redpanda:', '    seed_brokers: [ ${REDPANDA_BROKERS} ]', '    topic: ${! meta("table") }', '    key: ${! json("id") }')) })
    expect(result.kinds.connect.yamlUnparsed).toBe(0)
    expect(result.kinds.connect.findings).toEqual([])
  })

  test('an unparsable block counts in yamlUnparsed and gives no finding', () => {
    const result = scan({ 'modules/x/pages/y.adoc': page(yaml('input:', '  redpanda: [', '    nope: :')) })
    expect(result.kinds.connect.yamlUnparsed).toBe(1)
    expect(result.kinds.connect.findings).toEqual([])
  })

  test('a plain value that restates the default gives no finding (stdout.codec: lines)', () => {
    const result = scan({ 'modules/x/pages/y.adoc': page(yaml('output:', '  stdout:', '    codec: lines')) })
    expect(result.kinds.connect.findings).toEqual([])
    expect(result.kinds.connect.counts.yamlRestatingDefault).toBe(1)
  })

  test('a broker config with only redpanda: is not walked outside a Connect page', () => {
    const result = scan({ 'modules/x/pages/y.adoc': page(yaml('redpanda:', '  seed_servers:', '    - host: x')) }, { name: 'streaming', version: '26.2' })
    expect(result.kinds.connect.findings).toEqual([])
  })

  test('whats-new.adoc and migration/ are historical: reported, never failing', () => {
    const result = scan({
      'modules/get-started/pages/whats-new.adoc': page(yaml('input:', '  redpanda:', '    clinet_id: x')),
      'modules/guides/pages/migration/v4.adoc': page(yaml('input:', '  redpanda:', '    clinet_id: x')),
    })
    expect(result.kinds.connect.findings.map((f) => f.reason)).toEqual(['unknown-field', 'unknown-field'])
    expect(result.failing).toBe(0)
  })

  test('docs reference/pages/releases/ is historical', () => {
    const result = scan({ 'modules/reference/pages/releases/redpanda.adoc': page(yaml('input:', '  redpanda:', '    clinet_id: x')) }, { failOn: 'any' })
    expect(result.kinds.connect.findings.map((f) => f.reason)).toEqual(['unknown-field'])
    expect(result.failing).toBe(0)
  })

  test('a Cloud scan hides ifndef::env-cloud content', () => {
    const result = scan({ 'modules/x/pages/y.adoc': page('ifndef::env-cloud[]\n' + yaml('input:', '  redpanda:', '    clinet_id: x') + 'endif::[]') }, CLOUD)
    expect(result.kinds.connect.findings).toEqual([])
  })

  test('an unknown component on a Cloud scan is not-in-connect-data', () => {
    const [f] = findings({ 'modules/x/pages/y.adoc': page(yaml('input:', '  gateway: {}')) }, CLOUD)
    expect(f).toMatchObject({ status: 'unverifiable', reason: 'not-in-connect-data', failing: false })
    const [g] = findings({ 'modules/x/pages/y.adoc': page(yaml('input:', '  gateway: {}')) })
    expect(g).toMatchObject({ status: 'reference', reason: 'unknown-component' })
  })

  test('rp-connect-docs templating.adoc:57 and plugins/pages/about.adoc:125: a component a template or plugin on the page defines is unverifiable', () => {
    const result = scan({
      'modules/configuration/pages/templating.adoc': page(
        yaml('name: aws_sqs_list', 'type: input', '', 'mapping: |', '  root.broker.inputs = []') +
        yaml('input:', '  aws_sqs_list:', '    urls: []')),
      'modules/plugins/pages/about.adoc': page(
        yaml('name: fizzbuzz', 'type: processor', 'fields: []') +
        yaml('input:', '  generate:', '    mapping: root = 1', 'pipeline:', '  processors:', '  - fizzbuzz: {}')),
    })
    expect(result.kinds.connect.findings.map((f) => [f.file, f.status, f.reason, f.component])).toEqual([
      ['modules/configuration/pages/templating.adoc', 'unverifiable', 'page-defined-component', 'aws_sqs_list'],
      ['modules/plugins/pages/about.adoc', 'unverifiable', 'page-defined-component', 'fizzbuzz'],
    ])
    expect(result.failing).toBe(0)
    // The definition counts on its own page only.
    const [f] = findings({ 'modules/x/pages/y.adoc': page(yaml('input:', '  aws_sqs_list: {}')) })
    expect(f).toMatchObject({ status: 'reference', reason: 'unknown-component' })
  })

  test('rp-connect-docs helm-chart.adoc:408: Helm values on a Connect page are not walked, root fields alone still are', () => {
    expect(findings({ 'modules/get-started/pages/quickstarts/helm-chart.adoc': page(yaml('metrics:', '  prometheus: {}', '', 'tracing:', '  openTelemetry:', '    http: []', '', 'logger:', '  level: INFO')) })).toEqual([])
    const [f] = findings({ 'modules/x/pages/y.adoc': page(yaml('http:', '  adress: 0.0.0.0:4195', 'logger: {}')) })
    expect(f).toMatchObject({ status: 'reference', reason: 'unknown-field', fieldPath: 'http.adress' })
  })

  test('the explicit type: form names the component', () => {
    expect(findings({ 'modules/x/pages/y.adoc': page(yaml('input:', '  type: redpanda', '  redpanda:', '    clinet_id: x')) })).toHaveLength(1)
  })
})

describe('Connect prose', () => {
  // rp-connect-docs modules/cookbooks/examples/postgres_cdc/incremental-snapshot.yaml
  // and modules/cookbooks/pages/postgres_cdc.adoc:201-213.
  const INCREMENTAL = [
    '# tag::config[]',
    'input:',
    '  postgres_cdc:',
    '    dsn: ${PG_DSN}',
    '    schema: ${PG_SCHEMA}',
    '    tables:',
    '      - orders',
    '      - customers',
    '    slot_name: ${PG_SLOT_NAME}',
    '    stream_snapshot: false # <1>',
    '    signal_table_name: rpcn_signal_table # <2>',
    '    incremental_snapshot:',
    '      enabled: true',
    '      chunk_size: 1024 # <3>',
    '      checkpoint_cache: snapshot_progress # <4>',
    '',
    'pipeline:',
    '  processors: # <5>',
    '    - mapping: |',
    '        root = if @table == "rpcn_signal_table" { deleted() } else { this }',
    '# end::config[]',
    '',
  ].join('\n')
  const POSTGRES_PAGE = page([
    '=== Configure the input',
    '',
    'This configuration enables incremental snapshots for the `orders` and `customers` tables:',
    '',
    '[,yaml]',
    '----',
    'include::cookbooks:example$postgres_cdc/incremental-snapshot.yaml[tag=config]',
    '----',
    '<1> Required. Incremental snapshots and `stream_snapshot` are mutually exclusive.',
    '<2> The signal table, without the schema name.',
    '<3> The number of rows to read in each chunk. The default is `1024`.',
    '<4> The label of the cache resource that stores snapshot progress.',
  ].join('\n'))

  test('rp-connect-docs postgres_cdc.adoc:211: the callout default is exact and auto-safe', () => {
    const list = findings({ 'modules/cookbooks/pages/postgres_cdc.adoc': POSTGRES_PAGE, 'modules/cookbooks/examples/postgres_cdc/incremental-snapshot.yaml': INCREMENTAL })
    const f = list.find((x) => x.association === 'callout')
    expect(f).toMatchObject({ file: 'modules/cookbooks/pages/postgres_cdc.adoc', line: 13, status: 'exact', autoSafe: true, fieldPath: 'incremental_snapshot.chunk_size', proposed: '`connectval:[inputs/postgres_cdc.incremental_snapshot.chunk_size,default]`' })
  })

  test('rp-connect-docs mysql_cdc.adoc:204: the callout default is exact', () => {
    const example = ['# tag::config[]', 'input:', '  mysql_cdc:', '    dsn: ${MYSQL_DSN}', '    tables: # <1>', '      - orders', '    checkpoint_key: mysql_binlog_position_sales # <2>', '    stream_snapshot: true', '    max_parallel_snapshot_tables: 4 # <3>', '# end::config[]'].join('\n')
    const text = page([
      '[,yaml]', '----', 'include::cookbooks:example$mysql_cdc/many-tables.yaml[tag=config]', '----',
      '<1> List every table in the lane. Use table names only, without a database prefix.',
      '<2> A checkpoint key that is unique to this lane.',
      '<3> The number of tables to snapshot in parallel. The default is `1`.',
    ].join('\n'))
    const f = findings({ 'modules/cookbooks/pages/mysql_cdc.adoc': text, 'modules/cookbooks/examples/mysql_cdc/many-tables.yaml': example }).find((x) => x.association === 'callout')
    expect(f).toMatchObject({ status: 'exact', fieldPath: 'max_parallel_snapshot_tables', dataValue: '1' })
  })

  test('rp-connect-docs iceberg-output-tuning.adoc:90: checkpoint_limit 1024 resolves through the page YAML, and the If-sentence qualifies it', () => {
    const text = page([
      '[,yaml]', '----', 'input:', '  redpanda:', '    unordered_processing:', '      enabled: true', '      checkpoint_limit: 20000', 'output:', '  iceberg:', '    max_in_flight: 32', '----', '',
      '`checkpoint_limit` must exceed `batching.count`, because it caps how many unacknowledged records a partition can hold in flight. If the limit is lower than the batch size (for example, the default `checkpoint_limit` of 1024 combined with `count: 10000`), batches can never fill to their target count.',
    ].join('\n'))
    const [f] = findings({ 'modules/guides/pages/iceberg-output-tuning.adoc': text })
    expect(f).toMatchObject({ component: 'redpanda', fieldPath: 'unordered_processing.checkpoint_limit', dataValue: '1024', written: '1024', status: 'unverifiable', reason: 'qualified', qualifier: 'If' })
  })

  test('a component page is the context of its own prose (rp-connect-docs outputs/redpanda_migrator.adoc:92)', () => {
    const [f] = findings({ 'modules/components/pages/outputs/redpanda_migrator.adoc': page('- Syncs once at startup, then periodically based on `schema_registry.interval` (default: every 5 minutes).') })
    expect(f).toMatchObject({ status: 'equivalent', component: 'redpanda_migrator', fieldPath: 'schema_registry.interval', dataValue: '5m' })
  })

  test('a mismatch in prose fails', () => {
    const [f] = findings({ 'modules/components/pages/inputs/redpanda.adoc': page('The `client_id` field defaults to `benthos`.') })
    expect(f).toMatchObject({ status: 'mismatch', failing: true, dataValue: 'redpanda-connect' })
  })

  test('a field with no component context is no-component-context on a Connect page, ignored elsewhere', () => {
    const [f] = findings({ 'modules/guides/pages/x.adoc': page('The `checkpoint_limit` field defaults to 1024. See xref:components:inputs/about.adoc[].') })
    expect(f).toMatchObject({ status: 'unverifiable', reason: 'no-component-context' })
    expect(findings({ 'modules/sql/pages/lag.adoc': page('* `default`: Optional. Value to return if the `offset` is out of range. Defaults to `NULL`.') }, { name: 'cloud-data-platform', attributes: { 'env-cloud': true } })).toEqual([])
  })

  test('a value written as connectval: is the macro, not a hand-written value, in every form', () => {
    for (const value of ['connectval:[inputs/redpanda.client_id]', '`connectval:[inputs/redpanda.client_id]`', 'connectval:client_id[default,component=inputs/redpanda]']) {
      expect([value, findings({ 'modules/components/pages/inputs/redpanda.adoc': page(`The \`client_id\` field defaults to ${value}.`) })]).toEqual([value, []])
    }
  })

  test('the bracket form of connectval: is a field mention with its component', () => {
    const [f] = findings({ 'modules/guides/pages/x.adoc': page('The connectval:[inputs/redpanda.client_id,type] field defaults to `benthos`.') })
    expect(f).toMatchObject({ status: 'mismatch', component: 'redpanda', fieldPath: 'client_id', dataValue: 'redpanda-connect' })
  })

  test('a block-form line is not prose', () => {
    expect(findings({ 'modules/components/pages/inputs/redpanda.adoc': page('connectval::[inputs/redpanda.client_id,description]') })).toEqual([])
  })

  test('a Cloud scan marks a claim about a component Cloud does not run cloud-unavailable', () => {
    const [f] = findings({ 'modules/x/pages/y.adoc': page('The xref:components:inputs/stdin.adoc[`stdin`] input field `max_buffer` defaults to 1000000.') }, CLOUD)
    expect(f).toMatchObject({ status: 'unverifiable', reason: 'cloud-unavailable' })
  })
})
