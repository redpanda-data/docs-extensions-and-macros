'use strict'

/**
 * The metrics pipeline has a schema for each file that leaves a run. These
 * tests check that the schemas are sound, that the generator's own output
 * matches them, and that doc-tools refuses output that does not.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const Ajv = require('ajv')

const ROOT = path.join(__dirname, '..', '..')
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')
const { validateFile, validateMetricsOutput, SCHEMAS } = require('../../tools/metrics/validate-output')

const SCHEMA_FILES = [
  'docs-data/redpanda-metrics.schema.json',
  'docs-data/metrics-gaps.schema.json',
  'docs-data/metric-overrides.schema.json',
  'tools/metrics/metrics-requirements.schema.json'
]

function pythonBinary () {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return null
}

const PYTHON = pythonBinary()
const describeIfPython = PYTHON ? describe : describe.skip

describe('metrics schemas', () => {
  it.each(SCHEMA_FILES)('%s compiles and rejects unknown top-level fields', (file) => {
    const schema = JSON.parse(read(file))
    expect(() => new Ajv({ allErrors: true, strict: false }).compile(schema)).not.toThrow()
    expect(schema.additionalProperties).toBe(false)
    expect(schema.$id).toMatch(/^https:\/\/docs\.redpanda\.com\/schemas\//)
  })

  it('the schemas a docs repository needs ship in docs-data, where sync-schemas finds them', () => {
    const shipped = fs.readdirSync(path.join(ROOT, 'docs-data')).filter((name) => name.endsWith('.schema.json'))
    expect(shipped).toEqual(expect.arrayContaining(['redpanda-metrics.schema.json', 'metrics-gaps.schema.json', 'metric-overrides.schema.json']))
  })

  it('the generator and the dataset schema agree on the version and the name of the schema', () => {
    const dataset = read('tools/metrics/dataset.py')
    const schema = JSON.parse(read('docs-data/redpanda-metrics.schema.json'))
    expect(Number(dataset.match(/^SCHEMA_VERSION = (\d+)$/m)[1])).toBe(schema.properties.schema_version.const)
    expect(dataset.match(/^SCHEMA_ID = "([^"]+)"$/m)[1]).toBe(schema.$id)
    expect(schema.properties.$schema.const).toBe(schema.$id)
  })

  it('the README names every schema', () => {
    const readme = read('tools/metrics/README.adoc')
    for (const file of SCHEMA_FILES) expect(readme).toContain(file)
  })
})

describeIfPython('generator output and the schemas', () => {
  let workDir
  let out
  const family = (name, type) => `# HELP ${name} Some help\n# TYPE ${name} ${type}\n${name}{shard="0"} 1\n`

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-schemas-'))
    out = path.join(workDir, 'out')
    const write = (name, content) => {
      const file = path.join(workDir, name)
      fs.writeFileSync(file, content)
      return file
    }
    const inventory = {
      ref: 'v0.0.1',
      public: { redpanda_a_total: { type: 'counter', help: 'A', defined_in: 'src/v/a.cc' }, redpanda_missing: { type: 'gauge', help: 'M', defined_in: 'src/v/m.cc' } },
      internal: { vectorized_b: { type: 'gauge', help: 'B', defined_in: 'src/v/b.cc' } },
      unresolved: [{ file: 'src/v/x.cc', line: 3, kind: 'gauge', reason: 'endpoint not resolvable' }]
    }
    const result = spawnSync(PYTHON, ['-I', path.join(ROOT, 'tools', 'metrics', 'metrics.py'), 'v0.0.1', '--output-dir', out, '--skip-pages',
      '--public-file', write('pub.txt', family('redpanda_a_total', 'counter')),
      '--internal-file', write('int.txt', family('vectorized_b', 'gauge')),
      '--inventory', write('inventory.json', JSON.stringify(inventory)),
      '--overrides', write('overrides.json', JSON.stringify({ metrics: { redpanda_a_total: { labels: [{ name: 'nope' }], unit: null }, redpanda_gone: { description: 'x' } } })),
      '--requirements', path.join(ROOT, 'docker-compose', 'metrics', 'requirements.json')],
    { cwd: workDir, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
  })

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('a real run matches both schemas, with every kind of gap present', () => {
    const gaps = JSON.parse(fs.readFileSync(path.join(out, 'metrics-gaps.json'), 'utf8'))
    for (const kind of ['not_scraped', 'unresolved', 'stale_requirements', 'stale_overrides', 'override_disagrees', 'redundant_overrides']) {
      expect(gaps[kind].length).toBeGreaterThan(0)
    }
    expect(validateMetricsOutput({ tag: 'v0.0.1', outputDir: out })).toEqual({
      checked: [path.join(out, 'redpanda-metrics-v0.0.1.json'), path.join(out, 'metrics-gaps.json')],
      failures: []
    })
  })

  it('the dataset names its schema', () => {
    const dataset = JSON.parse(fs.readFileSync(path.join(out, 'redpanda-metrics-v0.0.1.json'), 'utf8'))
    expect(dataset.$schema).toBe('https://docs.redpanda.com/schemas/redpanda-metrics.schema.json')
  })

  describe('output that does not match', () => {
    const broken = (mutate) => {
      const dir = fs.mkdtempSync(path.join(workDir, 'broken-'))
      for (const name of ['redpanda-metrics-v0.0.1.json', 'metrics-gaps.json']) fs.copyFileSync(path.join(out, name), path.join(dir, name))
      mutate(dir)
      return dir
    }
    const edit = (file, change) => {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      change(data)
      fs.writeFileSync(file, JSON.stringify(data))
    }

    it('a dataset with a field the schema does not have is reported and deleted', () => {
      const dir = broken((d) => edit(path.join(d, 'redpanda-metrics-v0.0.1.json'), (data) => { data.metrics.redpanda_a_total.surprise = true }))
      const { failures } = validateMetricsOutput({ tag: 'v0.0.1', outputDir: dir })
      expect(failures).toHaveLength(1)
      expect(failures[0].problems.join(' ')).toMatch(/redpanda_a_total.*additional properties.*surprise/)
      expect(fs.existsSync(path.join(dir, 'redpanda-metrics-v0.0.1.json'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'metrics-gaps.json'))).toBe(true)
    })

    it('a dataset with another schema version is refused', () => {
      const dir = broken((d) => edit(path.join(d, 'redpanda-metrics-v0.0.1.json'), (data) => { data.schema_version = 2 }))
      expect(validateMetricsOutput({ tag: 'v0.0.1', outputDir: dir }).failures[0].problems.join(' ')).toMatch(/schema_version/)
    })

    it('a gaps file with a missing list is reported and deleted', () => {
      const dir = broken((d) => edit(path.join(d, 'metrics-gaps.json'), (data) => { delete data.not_scraped }))
      const { failures } = validateMetricsOutput({ tag: 'v0.0.1', outputDir: dir })
      expect(failures.map((failure) => path.basename(failure.file))).toEqual(['metrics-gaps.json'])
      expect(fs.existsSync(path.join(dir, 'metrics-gaps.json'))).toBe(false)
    })

    it('keeps the file when asked to', () => {
      const dir = broken((d) => edit(path.join(d, 'redpanda-metrics-v0.0.1.json'), (data) => { delete data.counts }))
      expect(validateMetricsOutput({ tag: 'v0.0.1', outputDir: dir, remove: false }).failures).toHaveLength(1)
      expect(fs.existsSync(path.join(dir, 'redpanda-metrics-v0.0.1.json'))).toBe(true)
    })

    it('reports a file that is not JSON', () => {
      const file = path.join(workDir, 'not.json')
      fs.writeFileSync(file, 'nope')
      expect(validateFile(file, SCHEMAS.gaps)[0]).toMatch(/cannot be read as JSON/)
    })
  })

  it('finds a release dataset in the dataset directory', () => {
    const datasetDir = path.join(workDir, 'attachments')
    fs.mkdirSync(datasetDir)
    fs.copyFileSync(path.join(out, 'redpanda-metrics-v0.0.1.json'), path.join(datasetDir, 'redpanda-metrics-v9.9.9.json'))
    const empty = path.join(workDir, 'empty-out')
    fs.mkdirSync(empty)
    expect(validateMetricsOutput({ tag: 'v9.9.9', outputDir: empty, datasetDir }).checked).toEqual([path.join(datasetDir, 'redpanda-metrics-v9.9.9.json')])
  })
})
