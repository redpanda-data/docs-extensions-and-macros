'use strict'

/**
 * docker-compose/metrics/requirements.json says what a cluster needs before
 * it exports each group of metrics. The generator copies it into the dataset
 * as each metric's requires list, and the docs print it, so it has to stay in
 * step with what the metrics cluster really turns on.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const Ajv = require('ajv')
const yaml = require('js-yaml')

const ROOT = path.join(__dirname, '..', '..')
const METRICS = path.join(ROOT, 'docker-compose', 'metrics')
const SCRIPT = path.join(ROOT, 'tools', 'metrics', 'metrics.py')
const read = (file) => fs.readFileSync(file, 'utf8')
const requirementsFile = path.join(METRICS, 'requirements.json')
const { requirements } = JSON.parse(read(requirementsFile))
const DATASET_SCHEMA = JSON.parse(read(path.join(ROOT, 'tools', 'metrics', 'redpanda-metrics.schema.json')))

function pythonBinary () {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return null
}

const PYTHON = pythonBinary()
const describeIfPython = PYTHON ? describe : describe.skip

describe('metric requirements file', () => {
  it('matches its schema', () => {
    const validate = new Ajv({ allErrors: true }).compile(JSON.parse(read(path.join(ROOT, 'tools', 'metrics', 'metrics-requirements.schema.json'))))
    expect(validate(JSON.parse(read(requirementsFile)))).toBe(true)
    expect(validate.errors).toBeNull()
  })

  it('gives every requirement its own id', () => {
    const ids = requirements.map((requirement) => requirement.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // A property the metrics cluster turns on exists to make some metric
  // appear. If no requirement names it, the docs cannot say what that metric
  // needs.
  it('names every property the metrics cluster adds to the quickstart', () => {
    const text = JSON.stringify(requirements)
    const added = Object.keys(yaml.load(read(path.join(METRICS, 'bootstrap-extra.yml'))))
    expect(added.filter((property) => !text.includes(property))).toEqual([])
  })

  it('writes each condition as a sentence', () => {
    for (const requirement of requirements) {
      for (const item of requirement.requires) {
        if (item.condition) expect(item.condition).toMatch(/^([A-Z]|prop:).*\.$/)
      }
    }
  })

  // The docs link a property through prop:. A property in backticks is only
  // text: the reader gets no link, and the build cannot check the name.
  it('names a property in a condition with prop:, never in backticks', () => {
    const known = new Set([
      ...Object.keys(yaml.load(read(path.join(ROOT, 'docker-compose', '25.1', 'bootstrap.yml')))),
      ...Object.keys(yaml.load(read(path.join(METRICS, 'bootstrap-extra.yml')))),
      ...requirements.flatMap((requirement) => requirement.requires.map((item) => item.property).filter(Boolean))
    ])
    const inBackticks = []
    for (const requirement of requirements) {
      for (const item of requirement.requires) {
        for (const [, word] of (item.condition || '').matchAll(/`([^`]+)`/g)) {
          if (known.has(word)) inBackticks.push(`${requirement.id}: ${word}`)
        }
      }
    }
    expect(inBackticks).toEqual([])
  })

  it('links every property it names in a condition', () => {
    const macros = requirements.flatMap((requirement) => requirement.requires.map((item) => item.condition || '')).join(' ').match(/prop:[^\s\[]+\[[^\]]*\]/g) || []
    expect(macros.length).toBeGreaterThan(0)
    for (const macro of macros) expect(macro).toMatch(/\[link=true\]$/)
  })
})

describeIfPython('requirements in the dataset', () => {
  let workDir
  let counter = 0
  const family = (name, type) => `# HELP ${name} Some help\n# TYPE ${name} ${type}\n${name}{shard="0"} 1\n`

  const run = (requirementsDoc) => {
    counter += 1
    const dir = path.join(workDir, `run-${counter}`)
    fs.mkdirSync(dir)
    const write = (name, content) => {
      const file = path.join(dir, name)
      fs.writeFileSync(file, content)
      return file
    }
    const out = path.join(dir, 'out')
    const pub = [['redpanda_cluster_brokers', 'gauge'], ['redpanda_cluster_health_nodes_down', 'gauge'], ['redpanda_shadow_link_shadow_lag', 'gauge']]
    const inventory = { ref: 'v0.0.1', public: Object.fromEntries(pub.map(([name, type]) => [name, { type, help: 'x', defined_in: 'src/v/x.cc' }])), internal: { vectorized_raft_leader_for: { type: 'gauge', help: 'x', defined_in: 'src/v/y.cc' } }, unresolved: [] }
    const result = spawnSync(PYTHON, ['-I', SCRIPT, 'v0.0.1', '--output-dir', out, '--skip-pages',
      '--public-file', write('pub.txt', pub.map((f) => family(...f)).join('')),
      '--internal-file', write('int.txt', family('vectorized_raft_leader_for', 'gauge')),
      '--inventory', write('inventory.json', JSON.stringify(inventory)),
      '--requirements', write('requirements.json', typeof requirementsDoc === 'string' ? requirementsDoc : JSON.stringify(requirementsDoc))],
    { cwd: dir, encoding: 'utf8' })
    const load = (name) => (fs.existsSync(path.join(out, name)) ? JSON.parse(read(path.join(out, name))) : null)
    return { status: result.status, log: `${result.stdout || ''}${result.stderr || ''}`, dataset: load('redpanda-metrics-v0.0.1.json'), gaps: load('metrics-gaps.json') }
  }

  const DOC = {
    requirements: [
      { id: 'health', metrics: ['redpanda_cluster_health_*'], requires: [{ property: 'health_monitor_metrics_enabled', value: true }], evidence: 'measured' },
      { id: 'link', metrics: ['redpanda_shadow_link_*'], requires: [{ property: 'enable_shadow_linking', value: true }, { condition: 'The cluster has a shadow link.' }], evidence: 'measured' },
      { id: 'link-topic', metrics: ['redpanda_shadow_link_shadow_lag'], requires: [{ condition: 'The shadow link has at least one shadow topic.' }], evidence: 'source' }
    ]
  }

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-requirements-'))
  })

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  describe('with matching requirements', () => {
    let result

    beforeAll(() => {
      result = run(DOC)
    })

    it('gives a metric the property it needs, with the evidence', () => {
      expect(result.status).toBe(0)
      expect(result.dataset.metrics.redpanda_cluster_health_nodes_down.requires).toEqual([
        { property: 'health_monitor_metrics_enabled', value: true, evidence: 'measured' }
      ])
      expect(result.dataset.metrics.redpanda_cluster_health_nodes_down.provenance.requires).toBe('requirements')
    })

    it('adds up every requirement that matches a metric, in order', () => {
      expect(result.dataset.metrics.redpanda_shadow_link_shadow_lag.requires).toEqual([
        { property: 'enable_shadow_linking', value: true, evidence: 'measured' },
        { condition: 'The cluster has a shadow link.', evidence: 'measured' },
        { condition: 'The shadow link has at least one shadow topic.', evidence: 'source' }
      ])
    })

    it('leaves a metric that needs nothing without a requires list', () => {
      expect(result.dataset.metrics.redpanda_cluster_brokers.requires).toBeUndefined()
      expect(result.dataset.metrics.redpanda_cluster_brokers.provenance.requires).toBeUndefined()
    })

    it('writes a dataset that matches the schema', () => {
      const validate = new Ajv({ allErrors: true }).compile(DATASET_SCHEMA)
      expect(validate(result.dataset)).toBe(true)
    })

    it('reports no gap', () => {
      expect(result.gaps.count).toBe(0)
      expect(result.gaps.stale_requirements).toEqual([])
    })
  })

  it('reports a requirement that matches no metric as a gap', () => {
    const stale = { id: 'gone', metrics: ['redpanda_removed_metric_*'], requires: [{ condition: 'Something is on.' }], evidence: 'source' }
    const result = run({ requirements: [...DOC.requirements, stale] })
    expect(result.status).toBe(0)
    expect(result.log).toMatch(/The requirement 'gone' in .* matches no metric/)
    expect(result.gaps.stale_requirements).toEqual(['gone'])
    expect(result.gaps.count).toBe(1)
  })

  describe('a requirement limited to some releases', () => {
    const scoped = (releases) => ({ requirements: [{ ...DOC.requirements[0], releases }] })
    const requiresOf = (result) => Object.values(result.dataset.metrics).filter((entry) => entry.requires).length

    it('is applied inside its range and left out outside it', () => {
      // run() generates for v0.0.1.
      expect(requiresOf(run(scoped({ before: '0.1' })))).toBeGreaterThan(0)
      expect(requiresOf(run(scoped({ from: '0.0' })))).toBeGreaterThan(0)
      expect(requiresOf(run(scoped({ before: '0.0' })))).toBe(0)
      expect(requiresOf(run(scoped({ from: '0.1' })))).toBe(0)
      expect(requiresOf(run(scoped({ from: '0.0', before: '0.1' })))).toBeGreaterThan(0)
    })

    it('is not reported as out of date in a release outside its range', () => {
      const gone = { id: 'gone', metrics: ['redpanda_removed_metric_*'], requires: [{ condition: 'Something is on.' }], evidence: 'source' }
      const outside = run({ requirements: [...DOC.requirements, { ...gone, releases: { from: '0.1' } }] })
      expect(outside.gaps.stale_requirements).toEqual([])
      expect(outside.gaps.count).toBe(0)
      const inside = run({ requirements: [...DOC.requirements, { ...gone, releases: { before: '0.1' } }] })
      expect(inside.gaps.stale_requirements).toEqual(['gone'])
    })

    it('fails on a range that is not major.minor', () => {
      for (const releases of [{ from: 'v26.2' }, { before: '26.2.1' }, { since: '26.2' }, '26.2']) {
        const result = run(scoped(releases))
        expect(result.status).toBe(1)
        expect(result.log).toMatch(/has releases that are not/)
      }
    })
  })

  it('fails on a requirements file with the wrong shape', () => {
    const result = run({ requirements: [{ id: 'bad', metrics: ['x'], requires: [{}], evidence: 'measured' }] })
    expect(result.status).toBe(1)
    expect(result.log).toMatch(/Cannot read the requirements file/)
    expect(run('not json').status).toBe(1)
  })
})
