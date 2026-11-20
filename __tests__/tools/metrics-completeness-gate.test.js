'use strict'

/**
 * With --inventory, tools/metrics/metrics.py checks the scrape against the
 * source inventory. Redpanda exports a metric family only when the feature
 * behind it is on, so a short scrape looks fine on its own. The check is what
 * stops a new metric with a new prerequisite from going missing.
 *
 * By default a gap does not stop the run: the metric is documented from
 * source, marked observed: false, and listed in metrics-gaps.json. With
 * --strict the run exits 4 and writes nothing. Each strict case here is a
 * negative control: the run must name the family and say what to do.
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

const family = (name, type, help = 'Some help') => `# HELP ${name}${help === '' ? '' : ` ${help}`}\n# TYPE ${name} ${type}\n${name}{shard="0"} 1\n`

const PUBLIC = [['redpanda_cluster_brokers', 'gauge'], ['redpanda_kafka_records_produced_total', 'counter']]
const INTERNAL = [['vectorized_raft_leader_for', 'gauge']]

const INVENTORY = {
  ref: 'v0.0.1',
  public: {
    redpanda_cluster_brokers: { type: 'gauge', help: 'Brokers', defined_in: 'src/v/cluster/members_table.cc' },
    redpanda_kafka_records_produced_total: { type: 'counter', help: 'Records', defined_in: 'src/v/kafka/server/probe.cc' }
  },
  internal: {
    vectorized_raft_leader_for: { type: 'gauge', help: 'Leader', defined_in: 'src/v/raft/probe.cc' },
    vectorized_smp_send_queue_length: { type: 'gauge', help: null, defined_in: 'seastar:src/core/reactor.cc' },
    vectorized_execution_stages_tasks_scheduled: { type: 'counter', help: null, condition: 'never', defined_in: 'seastar:src/core/execution_stage.cc' }
  },
  unresolved: []
}

const EXPECTED_ABSENT = { 'vectorized_smp_*': 'Seastar registers these disabled, so they are never exported' }

describeIfPython('metrics completeness gate', () => {
  let workDir
  let counter = 0

  const run = ({ pub = PUBLIC, int = INTERNAL, inventory = INVENTORY, expectedAbsent = EXPECTED_ABSENT, strict = true } = {}) => {
    const extra = strict ? ['--strict'] : []
    counter += 1
    const dir = path.join(workDir, `run-${counter}`)
    fs.mkdirSync(dir)
    const write = (name, content) => {
      const file = path.join(dir, name)
      fs.writeFileSync(file, content)
      return file
    }
    const out = path.join(dir, 'out')
    const args = ['-I', SCRIPT, 'v0.0.1', '--output-dir', out, '--skip-pages',
      '--public-file', write('pub.txt', pub.map((f) => family(...f)).join('')),
      '--internal-file', write('int.txt', int.map((f) => family(...f)).join('')),
      '--inventory', write('inventory.json', JSON.stringify(inventory))]
    if (expectedAbsent) args.push('--expected-absent', write('expected-absent.json', JSON.stringify(expectedAbsent)))
    const result = spawnSync(PYTHON, [...args, ...extra], { cwd: dir, encoding: 'utf8' })
    const files = fs.existsSync(out) ? fs.readdirSync(out) : []
    const dataset = files.includes('redpanda-metrics-v0.0.1.json')
      ? JSON.parse(fs.readFileSync(path.join(out, 'redpanda-metrics-v0.0.1.json'), 'utf8'))
      : null
    const gaps = files.includes('metrics-gaps.json')
      ? JSON.parse(fs.readFileSync(path.join(out, 'metrics-gaps.json'), 'utf8'))
      : null
    return { status: result.status, log: `${result.stdout || ''}${result.stderr || ''}`, files, dataset, gaps }
  }

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-gate-'))
  })

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  describe('when every family is scraped or has a written reason', () => {
    let result

    beforeAll(() => {
      result = run()
    })

    it('passes and writes the output', () => {
      expect(result.status).toBe(0)
      expect(result.files.sort()).toEqual(['internal-metrics.adoc', 'metrics-gaps.json', 'metrics.adoc', 'metrics.json', 'redpanda-metrics-v0.0.1.json'])
    })

    it('writes a gaps file that says there are none', () => {
      // Every kind is present and empty, so a reader of the file never has to
      // guess whether a missing key means "none" or "not checked".
      expect(result.gaps.count).toBe(0)
      for (const [kind, value] of Object.entries(result.gaps)) {
        if (kind !== 'count') expect(value).toEqual([])
      }
      expect(Object.keys(result.gaps)).toEqual(expect.arrayContaining(['not_scraped', 'not_in_source', 'type_mismatch', 'empty_help', 'unresolved']))
    })

    it('lists a family no cluster exports under excluded, with its reason, and not as a metric', () => {
      expect(result.dataset.metrics.vectorized_smp_send_queue_length).toBeUndefined()
      expect(result.dataset.excluded).toEqual([
        { name: 'vectorized_execution_stages_tasks_scheduled', endpoint: 'internal', reason: 'never registered' },
        { name: 'vectorized_smp_send_queue_length', endpoint: 'internal', reason: EXPECTED_ABSENT['vectorized_smp_*'] }
      ])
    })

    it('counts only what it documents', () => {
      expect(result.dataset.counts).toEqual({ public: 2, internal: 1, observed: 3, source_only: 0, excluded: 2 })
    })

    it('writes a dataset that matches the schema', () => {
      const validate = new Ajv({ allErrors: true }).compile(SCHEMA)
      expect(validate(result.dataset)).toBe(true)
    })
  })

  describe('a metric in source that the scrape misses, with --strict', () => {
    let result

    beforeAll(() => {
      result = run({ pub: PUBLIC.slice(0, 1) })
    })

    it('fails with exit code 4 and writes nothing', () => {
      expect(result.status).toBe(4)
      expect(result.files).toEqual([])
      expect(result.log).toMatch(/Nothing was written/)
    })

    it('names the family and the file that registers it', () => {
      expect(result.log).toMatch(/redpanda_kafka_records_produced_total \(public\) is registered in src\/v\/kafka\/server\/probe\.cc and was not scraped/)
    })

    it('says where to turn the feature on or record a reason', () => {
      expect(result.log).toMatch(/bootstrap-extra\.yml/)
      expect(result.log).toMatch(/expected-absent\.json/)
    })
  })

  it('fails when a family has no written reason and there is no expected-absent file', () => {
    const result = run({ expectedAbsent: null })
    expect(result.status).toBe(4)
    expect(result.log).toMatch(/vectorized_smp_send_queue_length \(internal\)/)
  })

  it('fails when the scrape has a family the inventory does not know', () => {
    const result = run({ int: [...INTERNAL, ['vectorized_brand_new_family', 'gauge']] })
    expect(result.status).toBe(4)
    expect(result.log).toMatch(/vectorized_brand_new_family \(internal\) was scraped and is not in the source inventory/)
    expect(result.files).toEqual([])
  })

  it('fails when a type differs between source and scrape', () => {
    const result = run({ pub: [['redpanda_cluster_brokers', 'counter'], PUBLIC[1]] })
    expect(result.status).toBe(4)
    expect(result.log).toMatch(/redpanda_cluster_brokers \(public\) is a gauge in source and a counter in the scrape/)
  })

  it('fails when a scraped family has an empty HELP line', () => {
    const result = run({ pub: [['redpanda_cluster_brokers', 'gauge', ''], PUBLIC[1]] })
    expect(result.status).toBe(4)
    expect(result.log).toMatch(/redpanda_cluster_brokers \(public\) has an empty HELP line/)
  })

  it('fails when the inventory has a registration it could not resolve', () => {
    const inventory = { ...INVENTORY, unresolved: [{ file: 'src/v/x/probe.cc', line: 12, kind: 'gauge', reason: 'endpoint not resolvable' }] }
    const result = run({ inventory })
    expect(result.status).toBe(4)
    expect(result.log).toMatch(/src\/v\/x\/probe\.cc:12 could not be resolved \(endpoint not resolvable\)/)
  })

  describe('a metric in source that the scrape misses, by default', () => {
    let result

    beforeAll(() => {
      result = run({ pub: PUBLIC.slice(0, 1), strict: false })
    })

    it('still writes the output', () => {
      expect(result.status).toBe(0)
      expect(result.files).toContain('redpanda-metrics-v0.0.1.json')
      expect(result.files).toContain('metrics.json')
    })

    it('documents the metric from source and marks it as not observed', () => {
      expect(result.dataset.metrics.redpanda_kafka_records_produced_total).toMatchObject({
        endpoint: 'public',
        type: 'counter',
        description: 'Records',
        labels: [],
        observed: false,
        defined_in: 'src/v/kafka/server/probe.cc'
      })
      expect(result.dataset.counts).toMatchObject({ public: 2, source_only: 1 })
    })

    it('lists the gap in metrics-gaps.json', () => {
      expect(result.gaps.count).toBe(1)
      expect(result.gaps.not_scraped).toEqual([
        { name: 'redpanda_kafka_records_produced_total', endpoint: 'public', defined_in: 'src/v/kafka/server/probe.cc' }
      ])
    })

    it('names the family and what to do in the log', () => {
      expect(result.log).toMatch(/redpanda_kafka_records_produced_total \(public\) is registered in/)
      expect(result.log).toMatch(/1 gaps between the scrape and the source are listed in/)
    })
  })

  it('lists a scraped family the inventory does not know as a gap, by default', () => {
    const result = run({ int: [...INTERNAL, ['vectorized_brand_new_family', 'gauge']], strict: false })
    expect(result.status).toBe(0)
    expect(result.gaps.not_in_source).toEqual([{ name: 'vectorized_brand_new_family', endpoint: 'internal' }])
    expect(result.dataset.metrics.vectorized_brand_new_family.observed).toBe(true)
  })

  it('rejects an expected-absent file that is not a JSON object', () => {
    const result = run({ expectedAbsent: ['vectorized_smp_*'] })
    expect(result.status).toBe(1)
    expect(result.log).toMatch(/Cannot read the expected-absent file/)
  })
})
