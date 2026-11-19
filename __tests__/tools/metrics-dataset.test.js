'use strict'

/**
 * tools/metrics/metrics.py also writes redpanda-metrics-<version>.json, the
 * family-level dataset built by tools/metrics/dataset.py. These tests drive
 * the generator through its file inputs and check the dataset:
 *
 * - it validates against tools/metrics/redpanda-metrics.schema.json,
 * - a histogram is one family with buckets and series, not four entries,
 * - a gauge whose name ends in _sum or _count stays its own family,
 * - label values with commas and escaped quotes parse correctly,
 * - label values are kept only when there are few of them,
 * - the unit is read from the name,
 * - several brokers merge into one set, and
 * - a source inventory adds the defining file, the families the scrape did
 *   not see, and the exclusions,
 * - a family on both endpoints, or a malformed inventory, fails the run,
 * - --dataset-dir writes a release's dataset where the macros read it, and
 * - the schema accepts the curated fields the macros read.
 *
 * metrics.json must keep its shape, so that is asserted too.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const Ajv = require('ajv')

const REPO_ROOT = path.join(__dirname, '..', '..')
const SCRIPT = path.join(REPO_ROOT, 'tools', 'metrics', 'metrics.py')
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tools', 'metrics', 'redpanda-metrics.schema.json'), 'utf8'))

function pythonBinary () {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return null
}

const PYTHON = pythonBinary()
const describeIfPython = PYTHON ? describe : describe.skip

const PUBLIC_BROKER_0 = `# HELP redpanda_cluster_brokers Number of configured brokers in the cluster
# TYPE redpanda_cluster_brokers gauge
redpanda_cluster_brokers{} 3.000000
# HELP redpanda_kafka_request_latency_seconds Internal latency of kafka produce requests
# TYPE redpanda_kafka_request_latency_seconds histogram
redpanda_kafka_request_latency_seconds_bucket{le="0.000255",redpanda_request="produce"} 1
redpanda_kafka_request_latency_seconds_bucket{le="0.001023",redpanda_request="produce"} 4
redpanda_kafka_request_latency_seconds_bucket{le="+Inf",redpanda_request="produce"} 9
redpanda_kafka_request_latency_seconds_sum{redpanda_request="produce"} 0.5
redpanda_kafka_request_latency_seconds_count{redpanda_request="produce"} 9
# HELP redpanda_kafka_consumer_group_lag_sum Sum of consumer group lag for all topic-partitions
# TYPE redpanda_kafka_consumer_group_lag_sum gauge
redpanda_kafka_consumer_group_lag_sum{redpanda_group="a,b=\\"c\\"",shard=""} 4
# HELP redpanda_kafka_request_bytes_total Total number of bytes produced per topic
# TYPE redpanda_kafka_request_bytes_total counter
${Array.from({ length: 13 }, (_, i) => `redpanda_kafka_request_bytes_total{redpanda_topic="topic-${i}",redpanda_request="produce"} 1`).join('\n')}
`

const PUBLIC_BROKER_1 = `# HELP redpanda_kafka_request_latency_seconds Internal latency of kafka produce requests
# TYPE redpanda_kafka_request_latency_seconds histogram
redpanda_kafka_request_latency_seconds_bucket{le="0.000511",redpanda_request="consume"} 1
redpanda_kafka_request_latency_seconds_bucket{le="+Inf",redpanda_request="consume"} 2
redpanda_kafka_request_latency_seconds_sum{redpanda_request="consume"} 0.1
redpanda_kafka_request_latency_seconds_count{redpanda_request="consume"} 2
# HELP redpanda_transform_state The number of transforms in a specific state
# TYPE redpanda_transform_state gauge
redpanda_transform_state{function_name="regex",state="running"} 1
`

const INTERNAL = `# HELP vectorized_raft_leader_for Number of groups for which node is a leader
# TYPE vectorized_raft_leader_for gauge
vectorized_raft_leader_for{shard="0"} 5
# HELP vectorized_kafka_latency_fetch_latency_us Fetch Latency
# TYPE vectorized_kafka_latency_fetch_latency_us histogram
vectorized_kafka_latency_fetch_latency_us_bucket{le="255.000000",shard="0"} 1
vectorized_kafka_latency_fetch_latency_us_bucket{le="+Inf",shard="0"} 1
vectorized_kafka_latency_fetch_latency_us_sum{shard="0"} 200
vectorized_kafka_latency_fetch_latency_us_count{shard="0"} 1
`

const INVENTORY = {
  ref: 'v0.0.1',
  public: {
    redpanda_cluster_brokers: { type: 'gauge', help: 'Number of configured brokers in the cluster', defined_in: 'src/v/cluster/members_table.cc' },
    redpanda_cluster_health_refreshes_total: { type: 'counter', help: 'Total refreshes', defined_in: 'src/v/cluster/health_monitor_backend.cc' },
    redpanda_tls_handshake_seconds: { type: 'histogram', help: null, help_runtime: true, defined_in: 'src/v/net/probes.cc' }
  },
  internal: {
    vectorized_raft_leader_for: { type: 'gauge', help: 'Number of groups for which node is a leader', defined_in: 'src/v/raft/probe.cc' },
    vectorized_execution_stages_tasks_scheduled: { type: 'counter', help: null, condition: 'never', defined_in: 'seastar:src/core/execution_stage.cc' }
  },
  unresolved: []
}

describeIfPython('redpanda-metrics-<version>.json', () => {
  let workDir
  const file = (name, content) => {
    const target = path.join(workDir, name)
    fs.writeFileSync(target, content)
    return target
  }

  const generate = (extra = []) => {
    const out = path.join(workDir, `out-${extra.length}`)
    const result = spawnSync(PYTHON, ['-I', SCRIPT, 'v0.0.1', '--output-dir', out, '--skip-pages',
      '--public-file', file('pub0.txt', PUBLIC_BROKER_0), '--public-file', file('pub1.txt', PUBLIC_BROKER_1),
      '--internal-file', file('int0.txt', INTERNAL), ...extra], { cwd: workDir, encoding: 'utf8' })
    return { result, out, combined: `${result.stdout || ''}${result.stderr || ''}` }
  }

  const read = (out) => JSON.parse(fs.readFileSync(path.join(out, 'redpanda-metrics-v0.0.1.json'), 'utf8'))

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-dataset-'))
  })

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  describe('from a scrape alone', () => {
    let dataset
    let out

    beforeEach(() => {
      const run = generate()
      if (run.result.status !== 0) throw new Error(run.combined)
      out = run.out
      dataset = read(out)
    })

    it('validates against the schema', () => {
      const validate = new Ajv({ allErrors: true }).compile(SCHEMA)
      expect(validate(dataset)).toBe(true)
      expect(validate.errors).toBeNull()
    })

    it('records the version, the number of sources and the counts', () => {
      expect(dataset.schema_version).toBe(1)
      expect(dataset.redpanda_version).toBe('v0.0.1')
      expect(dataset.generated_from).toEqual({ sources: 2 })
      expect(dataset.counts).toEqual({ public: 5, internal: 2, observed: 7, source_only: 0, excluded: 0 })
    })

    it('keeps a histogram as one family with its buckets and series', () => {
      const names = Object.keys(dataset.metrics)
      expect(names).toContain('redpanda_kafka_request_latency_seconds')
      expect(names.filter((name) => /_(bucket|count|sum)$/.test(name) && name.includes('latency'))).toEqual([])
      const entry = dataset.metrics.redpanda_kafka_request_latency_seconds
      expect(entry.type).toBe('histogram')
      expect(entry.endpoint).toBe('public')
      expect(entry.histogram).toEqual({
        buckets: ['0.000255', '0.000511', '0.001023', '+Inf'],
        series: ['_bucket', '_count', '_sum']
      })
    })

    it('leaves le out of the labels and merges label values across brokers', () => {
      expect(dataset.metrics.redpanda_kafka_request_latency_seconds.labels).toEqual([
        { name: 'redpanda_request', observed_values: ['consume', 'produce'] }
      ])
    })

    it('keeps a gauge that ends in _sum as its own family', () => {
      const entry = dataset.metrics.redpanda_kafka_consumer_group_lag_sum
      expect(entry.type).toBe('gauge')
      expect(entry.histogram).toBeNull()
    })

    it('parses label values that hold commas and escaped quotes, and drops empty values', () => {
      expect(dataset.metrics.redpanda_kafka_consumer_group_lag_sum.labels).toEqual([
        { name: 'redpanda_group', observed_values: ['a,b="c"'] },
        { name: 'shard' }
      ])
    })

    it('omits the values of a label that has many', () => {
      expect(dataset.metrics.redpanda_kafka_request_bytes_total.labels).toEqual([
        { name: 'redpanda_request', observed_values: ['produce'] },
        { name: 'redpanda_topic' }
      ])
    })

    it('reads the unit from the name and says it was derived', () => {
      expect(dataset.metrics.redpanda_kafka_request_latency_seconds.unit).toBe('seconds')
      expect(dataset.metrics.redpanda_kafka_request_latency_seconds.provenance.unit).toBe('derived')
      expect(dataset.metrics.redpanda_kafka_request_bytes_total.unit).toBe('bytes')
      expect(dataset.metrics.vectorized_kafka_latency_fetch_latency_us.unit).toBe('microseconds')
      expect(dataset.metrics.redpanda_cluster_brokers.unit).toBeNull()
      expect(dataset.metrics.redpanda_cluster_brokers.provenance.unit).toBeUndefined()
    })

    it('includes a family only one broker reports', () => {
      expect(dataset.metrics.redpanda_transform_state.observed).toBe(true)
    })

    it('puts /metrics families on the internal endpoint', () => {
      expect(dataset.metrics.vectorized_raft_leader_for.endpoint).toBe('internal')
    })

    it('keeps the source text beside the description', () => {
      const entry = dataset.metrics.redpanda_cluster_brokers
      expect(entry.description).toBe('Number of configured brokers in the cluster')
      expect(entry.source_description).toBe(entry.description)
      expect(entry.provenance.description).toBe('scraped')
    })

    it('leaves metrics.json in its existing shape', () => {
      const legacy = JSON.parse(fs.readFileSync(path.join(out, 'metrics.json'), 'utf8'))
      expect(Object.keys(legacy)).toEqual(['public', 'internal'])
      expect(legacy.public.redpanda_cluster_brokers).toEqual({
        description: 'Number of configured brokers in the cluster',
        type: 'gauge',
        unit: null,
        labels: []
      })
    })
  })

  describe('with a source inventory', () => {
    let dataset

    beforeEach(() => {
      const run = generate(['--inventory', file('inventory.json', JSON.stringify(INVENTORY))])
      if (run.result.status !== 0) throw new Error(run.combined)
      dataset = read(run.out)
    })

    it('still validates against the schema', () => {
      const validate = new Ajv({ allErrors: true }).compile(SCHEMA)
      expect(validate(dataset)).toBe(true)
    })

    it('records the source ref', () => {
      expect(dataset.generated_from).toEqual({ sources: 2, source_ref: 'v0.0.1' })
    })

    it('adds the defining file to a scraped family', () => {
      expect(dataset.metrics.redpanda_cluster_brokers.defined_in).toBe('src/v/cluster/members_table.cc')
      expect(dataset.metrics.redpanda_cluster_brokers.provenance.defined_in).toBe('source')
    })

    it('adds a family the scrape did not see as observed: false', () => {
      expect(dataset.metrics.redpanda_cluster_health_refreshes_total).toMatchObject({
        endpoint: 'public',
        type: 'counter',
        description: 'Total refreshes',
        labels: [],
        observed: false
      })
      expect(dataset.metrics.redpanda_cluster_health_refreshes_total.provenance).toEqual({
        type: 'source', source_description: 'source', description: 'source', defined_in: 'source'
      })
    })

    it('gives a source-only family with a runtime description no text', () => {
      const entry = dataset.metrics.redpanda_tls_handshake_seconds
      expect(entry.description).toBe('')
      expect(entry.unit).toBe('seconds')
      expect(entry.histogram).toEqual({ buckets: [], series: ['_bucket', '_count', '_sum'] })
    })

    it('lists a family that is never registered under excluded', () => {
      expect(dataset.metrics.vectorized_execution_stages_tasks_scheduled).toBeUndefined()
      expect(dataset.excluded).toEqual([
        { name: 'vectorized_execution_stages_tasks_scheduled', endpoint: 'internal', reason: 'never registered' }
      ])
      expect(dataset.counts).toEqual({ public: 7, internal: 2, observed: 7, source_only: 2, excluded: 1 })
    })
  })

  it('fails when the inventory cannot be read', () => {
    const run = generate(['--inventory', path.join(workDir, 'missing.json')])
    expect(run.result.status).toBe(1)
    expect(run.combined).toMatch(/Cannot read the source inventory/)
  })

  const validates = (dataset) => {
    const validate = new Ajv({ allErrors: true }).compile(SCHEMA)
    const ok = validate(dataset)
    return ok || validate.errors
  }

  describe('a family on both endpoints', () => {
    it('fails when the inventory puts a scraped family on the other endpoint', () => {
      const inventory = { public: {}, internal: { redpanda_cluster_brokers: { type: 'gauge', help: null } } }
      const run = generate(['--inventory', file('inventory.json', JSON.stringify(inventory))])
      expect(run.result.status).toBe(1)
      expect(run.combined).toMatch(/redpanda_cluster_brokers \(scraped on public, in the inventory under internal\)/)
      expect(run.combined).not.toMatch(/Traceback/)
      expect(fs.existsSync(path.join(run.out, 'redpanda-metrics-v0.0.1.json'))).toBe(false)
    })

    it('fails when a family is scraped on both endpoints', () => {
      const both = '# HELP redpanda_cluster_brokers Number of configured brokers in the cluster\n# TYPE redpanda_cluster_brokers gauge\nredpanda_cluster_brokers{} 3\n'
      const run = generate(['--internal-file', file('int1.txt', both)])
      expect(run.result.status).toBe(1)
      expect(run.combined).toMatch(/redpanda_cluster_brokers \(scraped on public, scraped on internal\)/)
      expect(fs.existsSync(path.join(run.out, 'redpanda-metrics-v0.0.1.json'))).toBe(false)
    })
  })

  it('gives a per-second rate no time unit', () => {
    const rates = `# HELP redpanda_instance_network_bytes_per_sec Host network bandwidth in bytes/sec
# TYPE redpanda_instance_network_bytes_per_sec gauge
redpanda_instance_network_bytes_per_sec{} 1
# TYPE redpanda_example_ops_per_second_total counter
redpanda_example_ops_per_second_total{} 1
`
    const run = generate(['--public-file', file('pub2.txt', rates)])
    if (run.result.status !== 0) throw new Error(run.combined)
    const dataset = read(run.out)
    expect(dataset.metrics.redpanda_instance_network_bytes_per_sec.unit).toBeNull()
    expect(dataset.metrics.redpanda_instance_network_bytes_per_sec.provenance.unit).toBeUndefined()
    expect(dataset.metrics.redpanda_example_ops_per_second_total.unit).toBeNull()
  })

  describe('an inventory name with a placeholder', () => {
    const placeholder = 'vectorized_cloud_roles__<upstream>_auth_refresh_fetch_errors'

    it('is listed under excluded, not under metrics', () => {
      const inventory = { public: {}, internal: { [placeholder]: { type: 'counter', help: null, defined_in: 'src/v/cloud_roles/probe.cc' } } }
      const run = generate(['--inventory', file('inventory.json', JSON.stringify(inventory))])
      if (run.result.status !== 0) throw new Error(run.combined)
      const dataset = read(run.out)
      expect(dataset.metrics[placeholder]).toBeUndefined()
      expect(dataset.excluded).toEqual([{ name: placeholder, endpoint: 'internal', reason: 'name depends on configuration' }])
      expect(dataset.counts).toMatchObject({ source_only: 0, excluded: 1 })
      expect(validates(dataset)).toBe(true)
    })

    it('is not a metric name the schema accepts', () => {
      const run = generate()
      if (run.result.status !== 0) throw new Error(run.combined)
      const dataset = read(run.out)
      dataset.metrics[placeholder] = { ...dataset.metrics.vectorized_raft_leader_for, name: placeholder }
      expect(validates(dataset)).not.toBe(true)
    })
  })

  describe('a malformed inventory', () => {
    it.each([
      ['a list', [], /must be an object with "public" and "internal" objects/],
      ['a list for an endpoint', { public: [], internal: {} }, /"public" must be an object/],
      ['no internal object', { public: {} }, /"internal" must be an object/],
      ['an entry that is not an object', { public: { redpanda_x_total: 'x' }, internal: {} }, /redpanda_x_total must be an object/],
      ['a type the schema does not have', { public: { redpanda_x_total: { type: 'info' } }, internal: {} }, /redpanda_x_total has the type 'info'/],
      ['a description that is not text', { public: { redpanda_x_total: { type: 'counter', help: 5 } }, internal: {} }, /must have a string "help"/],
      ['a ref that is not text', { ref: 7, public: {}, internal: {} }, /"ref" must be a string/]
    ])('fails with a message for %s', (_, inventory, message) => {
      const run = generate(['--inventory', file('inventory.json', JSON.stringify(inventory))])
      expect(run.result.status).toBe(1)
      expect(run.combined).toMatch(/is not valid/)
      expect(run.combined).toMatch(message)
      expect(run.combined).not.toMatch(/Traceback/)
      expect(fs.existsSync(path.join(run.out, 'redpanda-metrics-v0.0.1.json'))).toBe(false)
    })
  })

  it('writes a valid dataset for a TYPE the schema does not have and a name that is not a metric name', () => {
    const odd = `# TYPE redpanda_example_info unknown
redpanda_example_info{} 1
# HELP foo.bar dotted
# TYPE foo.bar gauge
`
    const run = generate(['--public-file', file('pub2.txt', odd)])
    if (run.result.status !== 0) throw new Error(run.combined)
    const dataset = read(run.out)
    expect(dataset.metrics.redpanda_example_info.type).toBeNull()
    expect(dataset.metrics['foo.bar']).toBeUndefined()
    expect(validates(dataset)).toBe(true)
  })

  describe('--dataset-dir', () => {
    // The pattern the metric macros load attachments with.
    const MACRO_FILE_RX = /^redpanda-metrics-(v\d+\.\d+\.\d+(?:-[\w.]+)?)\.json$/

    const run = (version, extra = []) => {
      const out = path.join(workDir, 'out')
      const result = spawnSync(PYTHON, ['-I', SCRIPT, version, '--output-dir', out, '--skip-pages',
        '--public-file', file('pub0.txt', PUBLIC_BROKER_0), '--internal-file', file('int0.txt', INTERNAL), ...extra],
      { cwd: workDir, encoding: 'utf8' })
      return { result, out, combined: `${result.stdout || ''}${result.stderr || ''}` }
    }

    it('writes the dataset to the output directory by default', () => {
      const { result, out } = run('v26.2.7')
      expect(result.status).toBe(0)
      expect(fs.readdirSync(out).sort()).toEqual(['internal-metrics.adoc', 'metrics.adoc', 'metrics.json', 'redpanda-metrics-v26.2.7.json'])
    })

    it.each(['v26.2.7', 'v26.3.1-rc2'])('writes the dataset for %s there, under a name the macros load', (version) => {
      const attachments = path.join(workDir, 'modules', 'reference', 'attachments')
      const { result, out, combined } = run(version, ['--dataset-dir', attachments])
      if (result.status !== 0) throw new Error(combined)
      const written = fs.readdirSync(attachments)
      expect(written).toEqual([`redpanda-metrics-${version}.json`])
      expect(written[0]).toMatch(MACRO_FILE_RX)
      expect(fs.readdirSync(out).sort()).toEqual(['internal-metrics.adoc', 'metrics.adoc', 'metrics.json'])
      expect(validates(JSON.parse(fs.readFileSync(path.join(attachments, written[0]), 'utf8')))).toBe(true)
    })

    it.each(['dev', 'v26.2'])('does not write there for %s, which is not a release tag', (version) => {
      const attachments = path.join(workDir, 'modules', 'reference', 'attachments')
      const { result, out, combined } = run(version, ['--dataset-dir', attachments])
      expect(result.status).toBe(0)
      expect(combined).toMatch(new RegExp(`${version.replace('.', '\\.')} is not a release tag, so the dataset is not written to`))
      expect(fs.existsSync(attachments)).toBe(false)
      expect(fs.existsSync(path.join(out, `redpanda-metrics-${version}.json`))).toBe(true)
    })
  })
})

describe('the curated fields the metric macros read', () => {
  // A subset of the fixture the metric: and metricval: macro tests use. The
  // overrides merge supplies these fields, so the schema must accept them.
  const base = { type: 'counter', unit: null, labels: [], histogram: null, observed: true }
  const curated = () => ({
    schema_version: 1,
    redpanda_version: 'v26.2.7',
    generated_from: { sources: 3, source_ref: 'v26.2.7' },
    counts: { public: 4, internal: 0, observed: 3, source_only: 1, excluded: 0 },
    metrics: {
      redpanda_cluster_brokers: {
        ...base,
        name: 'redpanda_cluster_brokers',
        endpoint: 'public',
        type: 'gauge',
        description: 'Number of configured brokers in the cluster',
        source_description: 'Number of configured brokers in the cluster',
        provenance: { type: 'scraped', source_description: 'scraped', description: 'scraped', labels: 'scraped', defined_in: 'source' },
        defined_in: 'src/v/cluster/controller_probe.cc',
        category: 'Cluster metrics',
        use_cases: ['cluster-health', 'alerting'],
        usage: 'Create an alert if this gauge falls below a steady-state threshold.',
        availability: { self_managed: true, dedicated: true, byoc: true, serverless: false },
        introduced: 'v22.1',
        deprecated: null,
        related_properties: ['health_monitor_metrics_enabled'],
        related_topics: [
          'xref:manage:monitoring.adoc[Monitor Redpanda]',
          'self-managed-only: xref:manage:cluster-maintenance/cluster-diagnostics.adoc[Cluster diagnostics]'
        ]
      },
      redpanda_kafka_request_latency_seconds: {
        ...base,
        name: 'redpanda_kafka_request_latency_seconds',
        endpoint: 'public',
        type: 'histogram',
        unit: 'seconds',
        description: 'Internal latency of kafka produce requests',
        source_description: 'Internal latency of kafka produce requests',
        labels: [{ name: 'redpanda_request', observed_values: ['consume', 'produce'], description: 'The kind of request.', values: ['consume', 'produce'] }],
        histogram: { buckets: ['0.000255', '+Inf'], series: ['_bucket', '_count', '_sum'] },
        provenance: { type: 'scraped', source_description: 'scraped', description: 'scraped', labels: 'scraped', unit: 'derived', histogram: 'scraped' },
        usage: 'Watch the 99th percentile.\n\nA rising value means clients wait longer for produce and fetch requests.',
        availability: { self_managed: true, dedicated: true, byoc: true, serverless: true }
      },
      redpanda_cluster_health_refreshes_total: {
        ...base,
        name: 'redpanda_cluster_health_refreshes_total',
        endpoint: 'public',
        description: 'Total successful health-report refreshes performed by this node since startup.',
        source_description: 'Total successful health-report refreshes performed by this node since startup.',
        observed: false,
        provenance: { type: 'source', source_description: 'source', description: 'source' },
        requires: [{ property: 'health_monitor_metrics_enabled', value: true }],
        availability: { self_managed: true, dedicated: false, byoc: false, serverless: false }
      },
      redpanda_example_deprecated_total: {
        ...base,
        name: 'redpanda_example_deprecated_total',
        endpoint: 'public',
        description: 'A metric made up for the tests, marked deprecated.',
        source_description: 'A metric made up for the tests, marked deprecated.',
        deprecated: 'v26.1',
        provenance: { type: 'scraped', description: 'scraped' }
      }
    },
    removed: { redpanda_example_removed_total: { endpoint: 'public', introduced: 'v24.1', removed: 'v26.2' } },
    excluded: []
  })

  const errors = (dataset) => {
    const validate = new Ajv({ allErrors: true }).compile(SCHEMA)
    return validate(dataset) ? [] : validate.errors.map((error) => `${error.instancePath} ${error.message}`)
  }

  it('validate against the schema', () => {
    expect(errors(curated())).toEqual([])
  })

  it('validate with requires as text and a status', () => {
    const dataset = curated()
    dataset.metrics.redpanda_cluster_health_refreshes_total.requires = 'Exported when health metrics are on.'
    dataset.metrics.redpanda_cluster_brokers.status = 'stable'
    expect(errors(dataset)).toEqual([])
  })

  it.each([
    ['an availability with an unknown deployment', (d) => { d.metrics.redpanda_cluster_brokers.availability.cloud = true }],
    ['an availability that is not a boolean', (d) => { d.metrics.redpanda_cluster_brokers.availability.serverless = 'no' }],
    ['a requirement with no property', (d) => { d.metrics.redpanda_cluster_health_refreshes_total.requires = [{ value: true }] }],
    ['use cases that are not a list', (d) => { d.metrics.redpanda_cluster_brokers.use_cases = 'alerting' }],
    ['a field the schema does not define', (d) => { d.metrics.redpanda_cluster_brokers.notes = 'x' }]
  ])('still reject %s', (_, change) => {
    const dataset = curated()
    change(dataset)
    expect(errors(dataset)).not.toEqual([])
  })
})

describe('doc-tools generate metrics-docs', () => {
  // Stand-ins for docker, bash and python3 on PATH, so the command runs
  // without a cluster and records what it would pass to the generator.
  const itOnPosix = process.platform === 'win32' ? it.skip : it

  itOnPosix('passes --inventory to the cluster script and --dataset-dir to the generator', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-cli-'))
    try {
      const bin = path.join(workDir, 'bin')
      const argsFile = path.join(workDir, 'args.txt')
      fs.mkdirSync(bin)
      const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
      stub('docker', 'exit 0')
      stub('python3', 'echo "Python 3.12.0"')
      const envFile = path.join(workDir, 'env.txt')
      stub('bash', `printf '%s\\n' "$@" > "${argsFile}"; printf '%s' "$METRICS_INVENTORY" > "${envFile}"`)

      const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'doc-tools.js'), 'generate', 'metrics-docs',
        '--tag', 'v26.2.7', '--skip-pages', '--inventory', 'inv.json', '--dataset-dir', 'modules/reference/attachments'],
      { cwd: workDir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } })
      if (result.status !== 0) throw new Error(`${result.stdout}${result.stderr}`)

      const real = fs.realpathSync(workDir)
      const args = fs.readFileSync(argsFile, 'utf8').trim().split('\n')
      expect(args.slice(1, 3)).toEqual(['metrics', 'v26.2.7'])
      expect(args.slice(-3)).toEqual([
        '--skip-pages',
        '--dataset-dir', path.join(real, 'modules', 'reference', 'attachments')
      ])
      // The inventory goes to the cluster script, which also gives the
      // generator the written reasons that belong with it.
      expect(fs.readFileSync(envFile, 'utf8')).toBe(path.join(real, 'inv.json'))
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })
})
