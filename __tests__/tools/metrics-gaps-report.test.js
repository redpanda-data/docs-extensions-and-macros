'use strict'

/**
 * tools/metrics/gaps_report.py turns metrics-gaps.json into the section an
 * automated pull request shows, and into a check result. A gap does not stop
 * the metrics run, so this is where it has to become visible and wait for a
 * person: the report must list every gap and exit 1 while any is open.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const SCRIPT = path.join(__dirname, '..', '..', 'tools', 'metrics', 'gaps_report.py')

function pythonBinary () {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return null
}

const PYTHON = pythonBinary()
const describeIfPython = PYTHON ? describe : describe.skip

const NONE = { count: 0, not_scraped: [], not_in_source: [], type_mismatch: [], empty_help: [], unresolved: [] }

describeIfPython('metrics gaps report', () => {
  let workDir
  const report = (gaps, extra = []) => {
    const file = path.join(workDir, 'metrics-gaps.json')
    fs.writeFileSync(file, typeof gaps === 'string' ? gaps : JSON.stringify(gaps))
    return spawnSync(PYTHON, ['-I', SCRIPT, file, ...extra], { encoding: 'utf8' })
  }

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-gaps-'))
  })

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('passes and says nothing needs a person when there are no gaps', () => {
    const result = report(NONE)
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^## Metrics check against source/)
    expect(result.stdout).toMatch(/Nothing needs a person/)
  })

  describe('a metric the cluster did not export', () => {
    let result

    beforeAll(() => {
      result = report({
        ...NONE,
        count: 1,
        not_scraped: [{ name: 'redpanda_new_feature_total', endpoint: 'public', defined_in: 'src/v/new/probe.cc' }]
      })
    })

    it('fails the check', () => {
      expect(result.status).toBe(1)
    })

    it('says a person is needed and names the metric and its source file', () => {
      expect(result.stdout).toMatch(/\*\*1 gap needs a person before this merges\.\*\*/)
      expect(result.stdout).toContain('| `redpanda_new_feature_total` | public | `src/v/new/probe.cc` |')
    })

    it('says the metric is still documented and how to close the gap', () => {
      expect(result.stdout).toMatch(/documented from source, without labels/)
      expect(result.stdout).toContain('bootstrap-extra.yml')
      expect(result.stdout).toContain('docker-compose/metrics/requirements.json')
      expect(result.stdout).toContain('expected-absent.json')
    })
  })

  it('lists every kind of gap and counts them all', () => {
    const result = report({
      count: 5,
      not_scraped: [{ name: 'redpanda_a', endpoint: 'public', defined_in: 'src/v/a.cc' }],
      not_in_source: [{ name: 'vectorized_b', endpoint: 'internal' }],
      type_mismatch: [{ name: 'redpanda_c', endpoint: 'public', source: 'gauge', scrape: 'counter' }],
      empty_help: [{ name: 'redpanda_d', endpoint: 'public' }],
      unresolved: [{ file: 'src/v/e.cc', line: 7, reason: 'endpoint not resolvable' }]
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toMatch(/\*\*5 gaps need a person before this merges\.\*\*/)
    expect(result.stdout).toContain('- `vectorized_b` (internal)')
    expect(result.stdout).toContain('- `redpanda_c` (public): gauge in source, counter in the scrape')
    expect(result.stdout).toContain('- `redpanda_d` (public)')
    expect(result.stdout).toContain('- `src/v/e.cc:7`: endpoint not resolvable')
  })

  it('counts the gaps itself and does not trust the count field', () => {
    const result = report({ ...NONE, count: 0, empty_help: [{ name: 'redpanda_d', endpoint: 'public' }] })
    expect(result.status).toBe(1)
  })

  it('prints the report and exits 0 with --no-fail', () => {
    const result = report({ ...NONE, count: 1, empty_help: [{ name: 'redpanda_d', endpoint: 'public' }] }, ['--no-fail'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('redpanda_d')
  })

  it('exits 2 on a file that is not a gaps file', () => {
    expect(report('{"count": 0}').status).toBe(2)
    expect(report('not json').status).toBe(2)
  })
})
