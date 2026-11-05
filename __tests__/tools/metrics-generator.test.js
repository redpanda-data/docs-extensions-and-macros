'use strict'

/**
 * tools/metrics/metrics.py is what CI runs to regenerate the metrics reference
 * from a live cluster. These tests drive it through its file inputs
 * (--public-file / --internal-file) so no cluster is needed, and cover:
 *
 * - parsing of a sample Prometheus exposition payload (HELP/TYPE in either
 *   order, UNIT, stray `{}` on unlabelled samples, histogram suffix
 *   propagation, samples with no HELP line, label key collection), and
 * - the zero-metrics failure path: an empty scrape must exit non-zero, say so,
 *   and write nothing, so an empty page can never ship behind a green run.
 *
 * The output format itself (metrics.json keys, the AsciiDoc shape) is asserted
 * here too, because the docs workflow commits those files verbatim.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const REPO_ROOT = path.join(__dirname, '..', '..')
const SCRIPT = path.join(REPO_ROOT, 'tools', 'metrics', 'metrics.py')
const FIXTURES = path.join(__dirname, 'fixtures', 'metrics')

function pythonBinary () {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return null
}

const PYTHON = pythonBinary()
const describeIfPython = PYTHON ? describe : describe.skip

function runGenerator (args, cwd) {
  // -I: isolated mode, so nothing in the fixture directory can shadow stdlib imports.
  const result = spawnSync(PYTHON, ['-I', SCRIPT, ...args], { cwd, encoding: 'utf8' })
  return { ...result, combined: `${result.stdout || ''}${result.stderr || ''}` }
}

describeIfPython('tools/metrics/metrics.py', () => {
  let workDir

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-generator-'))
  })

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  describe('parsing a sample /metrics payload', () => {
    let out
    let json
    let result

    beforeEach(() => {
      out = path.join(workDir, 'out')
      result = runGenerator([
        'v26.2.5',
        '--public-file', path.join(FIXTURES, 'public_metrics.txt'),
        '--internal-file', path.join(FIXTURES, 'internal_metrics.txt'),
        '--output-dir', out,
        '--skip-pages'
      ], workDir)
      expect(result.status).toBe(0)
      json = JSON.parse(fs.readFileSync(path.join(out, 'metrics.json'), 'utf8'))
    })

    test('splits the payloads into public and internal sets', () => {
      expect(Object.keys(json)).toEqual(['public', 'internal'])
      expect(Object.keys(json.internal)).toEqual([
        'vectorized_alien_receive_batch_queue_length',
        'vectorized_cluster_partition_records_produced'
      ])
    })

    test('reads HELP, TYPE and UNIT regardless of order and strips stray {}', () => {
      expect(json.public.redpanda_cluster_brokers).toEqual({
        description: 'Number of configured, fully commissioned brokers in the cluster',
        type: 'gauge',
        unit: null,
        labels: []
      })
      expect(json.public.redpanda_storage_disk_free_bytes.unit).toBe('bytes')
      // TYPE came before HELP for this family in the fixture.
      expect(json.public.redpanda_kafka_request_latency_seconds.type).toBe('histogram')
    })

    test('collects label keys from every sample, sorted and de-duplicated', () => {
      expect(json.public.redpanda_application_uptime_seconds_total.labels)
        .toEqual(['redpanda_revision', 'redpanda_version'])
      expect(json.internal.vectorized_cluster_partition_records_produced.labels)
        .toEqual(['namespace', 'partition', 'shard', 'topic'])
      expect(json.internal.vectorized_alien_receive_batch_queue_length.labels).toEqual(['shard'])
    })

    test('propagates HELP and TYPE from a histogram onto its _bucket, _count and _sum series', () => {
      for (const suffix of ['_bucket', '_count', '_sum']) {
        const series = json.public[`redpanda_kafka_request_latency_seconds${suffix}`]
        expect(series).toBeDefined()
        expect(series.description).toBe('Internal latency of kafka produce requests')
        expect(series.type).toBe('histogram')
      }
      expect(json.public.redpanda_kafka_request_latency_seconds_bucket.labels).toEqual(['le', 'redpanda_request'])
    })

    test('keeps a sample with no HELP line, with an empty description and a warning', () => {
      expect(json.public.redpanda_undocumented_metric).toEqual({
        description: '',
        type: null,
        unit: null,
        labels: ['shard']
      })
      expect(result.combined).toMatch(/redpanda_undocumented_metric' has samples but no # HELP/)
    })

    test('writes the AsciiDoc in the committed shape', () => {
      const adoc = fs.readFileSync(path.join(out, 'metrics.adoc'), 'utf8')
      expect(adoc).toContain([
        '=== redpanda_storage_disk_free_bytes',
        '',
        'Disk storage bytes free',
        '',
        '*Type*: gauge',
        '',
        '*Unit*: bytes',
        '',
        '---',
        ''
      ].join('\n'))
      expect(adoc).toContain([
        '=== redpanda_application_uptime_seconds_total',
        '',
        'Redpanda uptime in seconds',
        '',
        '*Type*: gauge',
        '',
        '*Labels*:',
        '',
        '- `redpanda_revision`',
        '- `redpanda_version`',
        '',
        '---'
      ].join('\n'))
      expect(fs.existsSync(path.join(out, 'internal-metrics.adoc'))).toBe(true)
    })

    test('--skip-pages leaves modules/reference/pages untouched', () => {
      expect(fs.existsSync(path.join(workDir, 'modules'))).toBe(false)
      expect(result.combined).toMatch(/Generated 8 public metrics and 2 internal metrics/)
    })
  })

  test('without --skip-pages the reference pages are written under the working directory', () => {
    const result = runGenerator([
      'v26.2.5',
      '--public-file', path.join(FIXTURES, 'public_metrics.txt'),
      '--internal-file', path.join(FIXTURES, 'internal_metrics.txt')
    ], workDir)
    expect(result.status).toBe(0)
    const pages = path.join(workDir, 'modules', 'reference', 'pages')
    expect(fs.existsSync(path.join(pages, 'public-metrics-reference.adoc'))).toBe(true)
    expect(fs.existsSync(path.join(pages, 'internal-metrics-reference.adoc'))).toBe(true)
    expect(fs.existsSync(path.join(workDir, 'autogenerated', 'v26.2.5', 'metrics', 'metrics.json'))).toBe(true)
  })

  describe('merging several brokers', () => {
    // Partition-, group- and transform-scoped metrics live on whichever broker
    // hosts them, so the generator scrapes every broker and merges. Two
    // --public-file arguments stand in for two brokers here.
    let json
    let result

    beforeEach(() => {
      const out = path.join(workDir, 'out')
      result = runGenerator([
        'v26.2.5',
        '--public-file', path.join(FIXTURES, 'public_metrics.txt'),
        '--public-file', path.join(FIXTURES, 'public_metrics_broker2.txt'),
        '--internal-file', path.join(FIXTURES, 'internal_metrics.txt'),
        '--output-dir', out,
        '--skip-pages'
      ], workDir)
      expect(result.status).toBe(0)
      json = JSON.parse(fs.readFileSync(path.join(out, 'metrics.json'), 'utf8'))
    })

    test('the merged set is the union of metric names', () => {
      // 8 from broker 1 plus the consumer-group metric only broker 2 exports.
      expect(Object.keys(json.public)).toHaveLength(9)
      expect(json.public.redpanda_kafka_consumer_group_lag_max).toEqual({
        description: 'Maximum lag of a consumer group',
        type: 'gauge',
        unit: null,
        labels: ['redpanda_group', 'redpanda_topic']
      })
      expect(result.combined).toMatch(/Generated 9 public metrics and 2 internal metrics from 2 source\(s\)/)
    })

    test('label keys are the union across brokers; description, type and unit come through once', () => {
      expect(json.public.redpanda_storage_disk_free_bytes).toEqual({
        description: 'Disk storage bytes free',
        type: 'gauge',
        unit: 'bytes',
        labels: ['redpanda_disk']
      })
      expect(json.public.redpanda_cluster_brokers.labels).toEqual([])
    })

    test('a broker that returns nothing fails the run rather than shrinking the set', () => {
      const out = path.join(workDir, 'out2')
      const r = runGenerator([
        'v26.2.5',
        '--public-file', path.join(FIXTURES, 'public_metrics.txt'),
        '--public-file', path.join(FIXTURES, 'missing-broker.txt'),
        '--internal-file', path.join(FIXTURES, 'internal_metrics.txt'),
        '--output-dir', out
      ], workDir)
      expect(r.status).toBe(1)
      expect(r.combined).toMatch(/No public metrics retrieved from: .*missing-broker\.txt/)
      expect(fs.existsSync(out)).toBe(false)
    })
  })

  describe('zero-metrics failure path', () => {
    test('an empty public scrape exits 2, says so, and writes nothing', () => {
      const out = path.join(workDir, 'out')
      const result = runGenerator([
        'v26.2.5',
        '--public-file', path.join(FIXTURES, 'empty_metrics.txt'),
        '--internal-file', path.join(FIXTURES, 'internal_metrics.txt'),
        '--output-dir', out
      ], workDir)
      expect(result.status).toBe(2)
      expect(result.combined).toMatch(/Scrape returned 0 public and 2 internal metrics \(minimum 1\)/)
      expect(result.combined).toMatch(/Nothing was written/)
      expect(fs.existsSync(out)).toBe(false)
      expect(fs.existsSync(path.join(workDir, 'modules'))).toBe(false)
    })

    test('an empty internal scrape fails the same way', () => {
      const out = path.join(workDir, 'out')
      const result = runGenerator([
        'v26.2.5',
        '--public-file', path.join(FIXTURES, 'public_metrics.txt'),
        '--internal-file', path.join(FIXTURES, 'empty_metrics.txt'),
        '--output-dir', out
      ], workDir)
      expect(result.status).toBe(2)
      expect(result.combined).toMatch(/Scrape returned 8 public and 0 internal metrics/)
      expect(fs.existsSync(out)).toBe(false)
    })

    test('--min-metrics raises the bar', () => {
      const out = path.join(workDir, 'out')
      const result = runGenerator([
        'v26.2.5',
        '--public-file', path.join(FIXTURES, 'public_metrics.txt'),
        '--internal-file', path.join(FIXTURES, 'internal_metrics.txt'),
        '--output-dir', out,
        '--min-metrics', '50'
      ], workDir)
      expect(result.status).toBe(2)
      expect(result.combined).toMatch(/minimum 50/)
      expect(fs.existsSync(out)).toBe(false)
    })

    test('an unreadable payload file exits 1 and writes nothing', () => {
      const out = path.join(workDir, 'out')
      const result = runGenerator([
        'v26.2.5',
        '--public-file', path.join(FIXTURES, 'does-not-exist.txt'),
        '--internal-file', path.join(FIXTURES, 'internal_metrics.txt'),
        '--output-dir', out
      ], workDir)
      expect(result.status).toBe(1)
      expect(result.combined).toMatch(/No public metrics retrieved/)
      expect(fs.existsSync(out)).toBe(false)
    })
  })
})
