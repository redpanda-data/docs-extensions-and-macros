'use strict'

/**
 * docs-data/metric-overrides.json is where writers add to the generated
 * metrics data. It has a second job: when the metrics cluster did not export a
 * metric, a writer can give the metric's labels there, so the reference is
 * complete while the cluster setup catches up.
 *
 * The rules these tests pin down:
 * - For a metric the cluster exported, the scrape decides which labels exist.
 *   An override describes them and never adds one.
 * - For a metric the cluster did not export, the override's labels are the
 *   labels, and that covers the gap.
 * - An override that names a missing metric or a label the cluster does not
 *   have is a gap a person has to deal with.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const Ajv = require('ajv')

const ROOT = path.join(__dirname, '..', '..')
const SCRIPT = path.join(ROOT, 'tools', 'metrics', 'metrics.py')
const REPORT = path.join(ROOT, 'tools', 'metrics', 'gaps_report.py')
const read = (file) => fs.readFileSync(file, 'utf8')
const DATASET_SCHEMA = JSON.parse(read(path.join(ROOT, 'tools', 'metrics', 'redpanda-metrics.schema.json')))
const OVERRIDES_SCHEMA = JSON.parse(read(path.join(ROOT, 'docs-data', 'metric-overrides.schema.json')))

function pythonBinary () {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return null
}

const PYTHON = pythonBinary()
const describeIfPython = PYTHON ? describe : describe.skip

const SCRAPED = `# HELP redpanda_cluster_brokers Number of configured brokers in the cluster
# TYPE redpanda_cluster_brokers gauge
redpanda_cluster_brokers{} 3
# HELP redpanda_kafka_request_bytes_total Total number of bytes produced per topic
# TYPE redpanda_kafka_request_bytes_total counter
redpanda_kafka_request_bytes_total{redpanda_topic="logins",redpanda_request="produce"} 1
`
const INTERNAL = '# HELP vectorized_raft_leader_for Leader\n# TYPE vectorized_raft_leader_for gauge\nvectorized_raft_leader_for{shard="0"} 1\n'
const source = (type, file) => ({ type, help: 'From source', defined_in: file })
const INVENTORY = {
  ref: 'v0.0.1',
  public: {
    redpanda_cluster_brokers: source('gauge', 'src/v/cluster/members.cc'),
    redpanda_kafka_request_bytes_total: source('counter', 'src/v/kafka/probe.cc'),
    redpanda_new_feature_lag: source('gauge', 'src/v/new/probe.cc'),
    redpanda_other_feature_total: source('counter', 'src/v/other/probe.cc')
  },
  internal: { vectorized_raft_leader_for: source('gauge', 'src/v/raft/probe.cc') },
  unresolved: []
}

describeIfPython('metric overrides', () => {
  let workDir
  let counter = 0

  const run = (overrides, extra = []) => {
    counter += 1
    const dir = path.join(workDir, `run-${counter}`)
    fs.mkdirSync(dir)
    const write = (name, content) => {
      const file = path.join(dir, name)
      fs.writeFileSync(file, content)
      return file
    }
    const out = path.join(dir, 'out')
    const result = spawnSync(PYTHON, ['-I', SCRIPT, 'v0.0.1', '--output-dir', out, '--skip-pages',
      '--public-file', write('pub.txt', SCRAPED), '--internal-file', write('int.txt', INTERNAL),
      '--inventory', write('inventory.json', JSON.stringify(INVENTORY)),
      '--overrides', write('overrides.json', typeof overrides === 'string' ? overrides : JSON.stringify({ metrics: overrides })),
      ...extra], { cwd: dir, encoding: 'utf8' })
    const load = (name) => (fs.existsSync(path.join(out, name)) ? JSON.parse(read(path.join(out, name))) : null)
    const gapsFile = path.join(out, 'metrics-gaps.json')
    const report = fs.existsSync(gapsFile) ? spawnSync(PYTHON, ['-I', REPORT, gapsFile], { encoding: 'utf8' }) : null
    return { status: result.status, log: `${result.stdout || ''}${result.stderr || ''}`, dataset: load('redpanda-metrics-v0.0.1.json'), gaps: load('metrics-gaps.json'), report }
  }

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-overrides-'))
  })

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('the schema accepts every field the generator applies, and rejects an unknown one', () => {
    const validate = new Ajv({ allErrors: true }).compile(OVERRIDES_SCHEMA)
    expect(validate({
      metrics: {
        redpanda_cluster_brokers: {
          _comment: 'note',
          description: 'Brokers.',
          unit: null,
          labels: [{ name: 'a', description: 'A.', values: ['x'] }],
          category: 'Cluster metrics',
          use_cases: ['cluster-health'],
          usage: 'Alert on it.',
          availability: { self_managed: true, dedicated: true, byoc: true, serverless: false },
          requires: [{ property: 'p', value: true }, { condition: 'A thing exists.' }],
          related_properties: ['p'],
          related_topics: ['xref:manage:monitoring.adoc[]']
        }
      }
    })).toBe(true)
    expect(validate({ metrics: { redpanda_cluster_brokers: { type: 'counter' } } })).toBe(false)
  })

  describe('a metric the cluster did not export', () => {
    let covered

    beforeAll(() => {
      covered = run({
        redpanda_new_feature_lag: {
          labels: [{ name: 'link', description: 'Name of the link.' }, { name: 'partition' }],
          category: 'New feature metrics'
        }
      })
    })

    it('takes its labels from the override and says so', () => {
      const entry = covered.dataset.metrics.redpanda_new_feature_lag
      expect(entry.observed).toBe(false)
      expect(entry.labels).toEqual([{ name: 'link', description: 'Name of the link.' }, { name: 'partition' }])
      expect(entry.provenance.labels).toBe('override')
      expect(entry.category).toBe('New feature metrics')
    })

    it('no longer counts as an open gap, and stays listed as covered', () => {
      expect(covered.gaps.not_scraped.map((gap) => gap.name)).toEqual(['redpanda_other_feature_total'])
      expect(covered.gaps.covered_by_override).toEqual([
        { name: 'redpanda_new_feature_lag', endpoint: 'public', defined_in: 'src/v/new/probe.cc' }
      ])
      expect(covered.gaps.count).toBe(1)
    })

    it('is covered by an empty labels list too, for a metric that has none', () => {
      const result = run({ redpanda_new_feature_lag: { labels: [] }, redpanda_other_feature_total: { labels: [] } })
      expect(result.gaps.count).toBe(0)
      expect(result.gaps.covered_by_override).toHaveLength(2)
      expect(result.report.status).toBe(0)
      expect(result.report.stdout).toMatch(/Nothing needs a person/)
      expect(result.report.stdout).toMatch(/Documented from an override, not confirmed by a cluster \(2\)/)
    })

    it('is not covered by an override that leaves out the labels', () => {
      const result = run({ redpanda_new_feature_lag: { description: 'Lag of the new feature.' } })
      expect(result.gaps.not_scraped.map((gap) => gap.name)).toContain('redpanda_new_feature_lag')
      expect(result.gaps.covered_by_override).toEqual([])
      expect(result.dataset.metrics.redpanda_new_feature_lag.description).toBe('Lag of the new feature.')
    })

    it('still fails a strict run unless every missed metric is covered', () => {
      expect(run({ redpanda_new_feature_lag: { labels: [] } }, ['--strict']).status).toBe(4)
      expect(run({ redpanda_new_feature_lag: { labels: [] }, redpanda_other_feature_total: { labels: [] } }, ['--strict']).status).toBe(0)
    })

    it('tells the reader of the report how to cover a gap', () => {
      expect(covered.report.status).toBe(1)
      expect(covered.report.stdout).toContain('docs-data/metric-overrides.json')
      expect(covered.report.stdout).toContain('- `redpanda_new_feature_lag` (public), registered in `src/v/new/probe.cc`')
    })
  })

  describe('a metric the cluster exported', () => {
    let result

    beforeAll(() => {
      result = run({
        redpanda_cluster_brokers: { description: 'Number of brokers in the cluster.', use_cases: ['cluster-health'] },
        redpanda_kafka_request_bytes_total: {
          labels: [{ name: 'redpanda_request', description: 'The kind of request.', values: ['produce', 'consume'] }]
        },
        redpanda_new_feature_lag: { labels: [] },
        redpanda_other_feature_total: { labels: [] }
      })
    })

    it('gets the reader text and keeps the text from Redpanda beside it', () => {
      const entry = result.dataset.metrics.redpanda_cluster_brokers
      expect(entry.description).toBe('Number of brokers in the cluster.')
      expect(entry.source_description).toBe('Number of configured brokers in the cluster')
      expect(entry.provenance.description).toBe('override')
      expect(entry.use_cases).toEqual(['cluster-health'])
    })

    it('gets a description and complete values on a label it has, and keeps the others', () => {
      expect(result.dataset.metrics.redpanda_kafka_request_bytes_total.labels).toEqual([
        { name: 'redpanda_request', observed_values: ['produce'], description: 'The kind of request.', values: ['produce', 'consume'] },
        { name: 'redpanda_topic', observed_values: ['logins'] }
      ])
      expect(result.dataset.metrics.redpanda_kafka_request_bytes_total.provenance.labels).toBe('scraped')
    })

    it('writes a dataset that matches the schema', () => {
      const validate = new Ajv({ allErrors: true }).compile(DATASET_SCHEMA)
      expect(validate(result.dataset)).toBe(true)
      expect(result.gaps.count).toBe(0)
    })
  })

  it('reports an override that names a label the cluster does not have, and does not add it', () => {
    const result = run({ redpanda_cluster_brokers: { labels: [{ name: 'made_up' }] } })
    expect(result.dataset.metrics.redpanda_cluster_brokers.labels).toEqual([])
    expect(result.gaps.override_disagrees).toEqual([{ name: 'redpanda_cluster_brokers', endpoint: 'public', labels_not_scraped: ['made_up'] }])
    expect(result.report.stdout).toContain('- `redpanda_cluster_brokers` (public): `made_up`')
    expect(result.report.status).toBe(1)
  })

  it('reports an override for a metric that is not in the release', () => {
    const result = run({ redpanda_gone_total: { description: 'Gone.' } })
    expect(result.status).toBe(0)
    expect(result.gaps.stale_overrides).toEqual(['redpanda_gone_total'])
    expect(result.log).toMatch(/The override for 'redpanda_gone_total' in .* matches no metric/)
    expect(result.report.stdout).toMatch(/Overrides that match no metric \(1\)/)
  })

  describe('retiring overrides that no longer change anything', () => {
    const OVERRIDES = {
      // The text now matches the help string in Redpanda, apart from spacing.
      redpanda_cluster_brokers: { description: 'Number of configured   brokers in the cluster', upstream_ref: 'redpanda-data/streaming-enterprise#1', labels: [] },
      redpanda_kafka_request_bytes_total: {
        unit: 'bytes',
        category: 'Topic metrics',
        labels: [
          { name: 'redpanda_topic' },
          { name: 'not_a_label' },
          { name: 'redpanda_request', description: 'The kind of request.' }
        ],
        description: ['Bytes produced and consumed.', 'cloud-only: In Serverless, this counts your traffic only.']
      },
      // Still a real stopgap: the cluster does not export this metric.
      redpanda_new_feature_lag: { labels: [{ name: 'link' }], description: 'Lag of the new feature.' },
      redpanda_other_feature_total: { labels: [] }
    }
    let result
    let after

    const runRetiring = (overrides, extra) => {
      const first = run(overrides, extra)
      // run() writes the overrides file into the run directory it just made.
      const file = path.join(workDir, `run-${counter}`, 'overrides.json')
      return { result: first, after: JSON.parse(read(file)).metrics }
    }

    beforeAll(() => {
      ({ result, after } = runRetiring(OVERRIDES, ['--retire-overrides']))
    })

    it('deletes text that now matches Redpanda, and its upstream reference', () => {
      expect(after.redpanda_cluster_brokers).toBeUndefined()
    })

    it('deletes a unit the tooling gives, a label that stood in for the scrape and a label the cluster does not have', () => {
      expect(after.redpanda_kafka_request_bytes_total.unit).toBeUndefined()
      expect(after.redpanda_kafka_request_bytes_total.labels).toEqual([{ name: 'redpanda_request', description: 'The kind of request.' }])
    })

    it('never deletes enrichment: a section, audience paragraphs or a label description', () => {
      expect(after.redpanda_kafka_request_bytes_total.category).toBe('Topic metrics')
      expect(after.redpanda_kafka_request_bytes_total.description).toEqual(OVERRIDES.redpanda_kafka_request_bytes_total.description)
    })

    it('keeps a stopgap that is still doing its job', () => {
      expect(after.redpanda_new_feature_lag).toEqual(OVERRIDES.redpanda_new_feature_lag)
      expect(after.redpanda_other_feature_total).toEqual({ labels: [] })
    })

    it('leaves a file that still matches the schema', () => {
      const validate = new Ajv({ allErrors: true }).compile(OVERRIDES_SCHEMA)
      expect(validate({ metrics: after })).toBe(true)
    })

    it('lists what it retired, and a wrongly named label is no longer an open gap', () => {
      expect(result.gaps.retired_overrides.map((item) => `${item.name}.${item.field}`).sort()).toEqual([
        'redpanda_cluster_brokers.description',
        'redpanda_cluster_brokers.labels',
        'redpanda_kafka_request_bytes_total.labels[not_a_label]',
        'redpanda_kafka_request_bytes_total.labels[redpanda_topic]',
        'redpanda_kafka_request_bytes_total.unit'
      ])
      expect(result.gaps.override_disagrees).toEqual([])
      expect(result.gaps.count).toBe(0)
      expect(result.report.stdout).toMatch(/Overrides retired by this run \(5\)/)
    })

    it('puts audience paragraphs in the data', () => {
      const entry = result.dataset.metrics.redpanda_kafka_request_bytes_total
      expect(entry.description).toBe('Bytes produced and consumed.')
      expect(entry.description_cloud_only).toEqual(['In Serverless, this counts your traffic only.'])
    })

    it('deletes an override whose metric is not in the release, and it is no longer a gap', () => {
      const gone = runRetiring({ redpanda_gone_total: { description: 'Gone.', category: 'Old metrics' }, redpanda_new_feature_lag: { labels: [] }, redpanda_other_feature_total: { labels: [] } }, ['--retire-overrides'])
      expect(gone.after.redpanda_gone_total).toBeUndefined()
      expect(gone.result.gaps.stale_overrides).toEqual([])
      expect(gone.result.gaps.retired_overrides).toEqual([
        { name: 'redpanda_gone_total', field: '', reason: 'no metric with this name is in this release' }
      ])
      expect(gone.result.gaps.count).toBe(0)
      expect(gone.result.report.stdout).toContain('- `redpanda_gone_total`: no metric with this name is in this release')
    })

    it('keeps the empty labels list that covers an unexported metric when another part of the override retires', () => {
      const overrides = { redpanda_new_feature_lag: { description: 'From source', labels: [] }, redpanda_other_feature_total: { labels: [] } }
      const first = runRetiring(overrides, ['--retire-overrides'])
      expect(first.after.redpanda_new_feature_lag).toEqual({ labels: [] })
      expect(first.result.gaps.count).toBe(0)
      // The next run reads the rewritten file, and the gap is still covered.
      const second = run(first.after)
      expect(second.gaps.not_scraped).toEqual([])
      expect(second.gaps.covered_by_override.map((gap) => gap.name)).toContain('redpanda_new_feature_lag')
    })

    it('only reports, and changes nothing, without --retire-overrides', () => {
      const dry = runRetiring(OVERRIDES, [])
      expect(dry.after).toEqual(OVERRIDES)
      expect(dry.result.gaps.redundant_overrides).toHaveLength(5)
      expect(dry.result.gaps.retired_overrides).toEqual([])
      expect(dry.result.log).toMatch(/5 parts of .* no longer change anything/)
      expect(dry.result.report.stdout).toMatch(/Overrides that can be retired \(5\)/)
    })
  })

  it('fails on an overrides file with the wrong shape', () => {
    expect(run('{"metrics": []}').status).toBe(1)
    expect(run({ redpanda_cluster_brokers: { labels: [{ description: 'no name' }] } }).status).toBe(1)
    expect(run('not json').log).toMatch(/Cannot read the overrides file/)
  })
})
