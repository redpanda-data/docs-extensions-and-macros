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
 *   not see, and the exclusions.
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
})
