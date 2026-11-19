'use strict'

/**
 * The live layer of `doc-tools check-queries`, without a cluster. The
 * Prometheus answers come from fixtures/metrics-queries/prometheus-recorded.json:
 * real responses of Prometheus v3.2.1 scraping a three-broker Redpanda
 * v26.2.7 cluster that generate-cluster-docs.sh started in queries mode. A
 * request that was not recorded fails the test.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const { judge, prometheusClient, runQuery, samplesNeeded, waitForSamples } = require('../../tools/metrics-queries/live-check')
const { parse } = require('../../tools/metrics-queries/promql')
const { runCli } = require('../../tools/metrics-queries')

const FIXTURES = path.join(__dirname, 'fixtures', 'metrics-queries')
const RECORDED = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'prometheus-recorded.json'), 'utf8'))
const DATASET = path.join(FIXTURES, 'redpanda-metrics-v26.2.7.json')
const URL_BASE = 'http://prometheus.test:9090'

function recordedFetch (overrides = {}) {
  const calls = []
  const fetch = async (url, init) => {
    const parsed = new URL(url)
    const key = `${init.method} ${parsed.pathname}${parsed.search}${init.body ? ` ${init.body}` : ''}`
    calls.push(key)
    const body = key in overrides ? overrides[key] : RECORDED.responses[key]
    if (body === undefined) throw new Error(`not recorded: ${key}`)
    return { status: 200, json: async () => body }
  }
  fetch.calls = calls
  return fetch
}

const client = (overrides) => prometheusClient(URL_BASE, { fetch: recordedFetch(overrides) })
const run = (expect, query, options = { scrapeInterval: 5 }) => runQuery(client(), { expect, resolved: query, ast: parse(query) }, options)

const LEADER = '{redpanda_namespace="redpanda",redpanda_topic="controller",redpanda_partition="0"}'
const WRONG = '{namespace="redpanda",topic="controller",partition="0"}'
const JOIN = (labels) => `redpanda_cluster_health_unhealthy_reasons\n  and on(instance)\n    redpanda_raft_leader_for${labels} == 1`
const NO_LEADER = (labels) => `sum(redpanda_raft_leader_for${labels}) == 0`
const WRONG_SELECTOR = 'the selector redpanda_raft_leader_for{namespace="redpanda",topic="controller",partition="0"} matches no series: ' +
  'namespace="redpanda" and topic="controller" and partition="0" each match nothing. ' +
  'redpanda_raft_leader_for has the labels instance, job, redpanda_namespace, redpanda_partition, redpanda_topic'

describe('the recording', () => {
  it('has six targets: two endpoints for each of three brokers, one instance value for each broker', () => {
    const targets = RECORDED.responses['GET /api/v1/targets?state=active'].data.activeTargets
    expect(targets.map((target) => target.scrapeUrl).sort()).toEqual([
      'http://redpanda-0:9644/metrics', 'http://redpanda-0:9644/public_metrics',
      'http://redpanda-1:9644/metrics', 'http://redpanda-1:9644/public_metrics',
      'http://redpanda-2:9644/metrics', 'http://redpanda-2:9644/public_metrics'
    ])
    for (const target of targets) expect(target.labels.instance).toBe(new URL(target.scrapeUrl).host)
  })
})

describe('the controller-leader queries from the docs', () => {
  it('passes the join with the real labels: on(instance) matches one broker', async () => {
    const result = await run('series', JOIN(LEADER))
    expect(result).toMatchObject({ ok: true, got: '1 series', series: 1, problems: [], selectors: [] })
  })

  it('fails the join with the wrong labels and says which labels the metric has', async () => {
    const result = await run('series', JOIN(WRONG))
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual(['expected at least one series, got no series', WRONG_SELECTOR])
    expect(result.selectors).toEqual([
      { selector: 'redpanda_cluster_health_unhealthy_reasons', series: 3 },
      {
        selector: 'redpanda_raft_leader_for{namespace="redpanda",topic="controller",partition="0"}',
        series: 0,
        metric_series: 3,
        actual_labels: ['instance', 'job', 'redpanda_namespace', 'redpanda_partition', 'redpanda_topic'],
        dead_matchers: ['namespace="redpanda"', 'topic="controller"', 'partition="0"'],
        reason: expect.stringContaining('each match nothing')
      }
    ])
  })

  // The alert is empty on a healthy cluster with the right labels and with
  // the wrong ones. Only the selector run tells them apart.
  it('passes the no-leader alert with the real labels: empty, and its selector matches', async () => {
    const result = await run('empty', NO_LEADER(LEADER))
    expect(result).toMatchObject({ ok: true, got: 'no series', problems: [] })
    expect(result.selectors).toEqual([{ selector: `redpanda_raft_leader_for${LEADER}`, series: 3 }])
  })

  it('fails the no-leader alert with the wrong labels, although it is empty as expected', async () => {
    const result = await run('empty', NO_LEADER(WRONG))
    expect(result.got).toBe('no series')
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([WRONG_SELECTOR])
  })

  it('joins a broker\'s public and internal series on instance', async () => {
    const result = await run('series', 'count by (instance) (redpanda_application_uptime_seconds_total) and on(instance) count by (instance) (vectorized_application_uptime)')
    expect(result).toMatchObject({ ok: true, series: 3 })
  })
})

describe('expect', () => {
  it.each([
    ['series', 'count by (job, instance) (up)', true, '6 series'],
    ['series', 'redpanda_kafka_under_replicated_replicas > 0', false, 'no series'],
    ['empty', 'redpanda_kafka_under_replicated_replicas > 0', true, 'no series'],
    ['empty', 'max(redpanda_cluster_health_nodes_down)', false, '1 series'],
    ['scalar', 'scalar(max(redpanda_cluster_health_nodes_down))', true, 'a scalar (0)'],
    ['series', 'scalar(max(redpanda_cluster_health_nodes_down))', false, 'a scalar (0)'],
    ['scalar', 'max(redpanda_cluster_health_nodes_down)', false, '1 series (an instant vector, not a scalar)']
  ])('expect %s on %s: ok %s, got %s', async (expect_, query, ok, got) => {
    const result = await run(expect_, query)
    expect(result.ok).toBe(ok)
    expect(result.got).toBe(got)
    if (!ok) expect(result.problems[0]).toBe(`expected ${result.expected}, got ${got}`)
  })

  it('does not run the selectors of a passing series query', async () => {
    const fetch = recordedFetch()
    await runQuery(prometheusClient(URL_BASE, { fetch }), { expect: 'series', resolved: 'count by (job, instance) (up)', ast: parse('count by (job, instance) (up)') })
    expect(fetch.calls).toHaveLength(1)
  })

  it('judges a response by itself', () => {
    const vector = (n) => ({ status: 'success', data: { resultType: 'vector', result: Array.from({ length: n }, () => ({ metric: {}, value: [0, '1'] })) } })
    expect(judge('series', vector(2))).toMatchObject({ ok: true, series: 2 })
    expect(judge('series', vector(0))).toMatchObject({ ok: false, series: 0 })
    expect(judge('empty', vector(0)).ok).toBe(true)
    expect(judge('empty', vector(1)).ok).toBe(false)
    expect(judge('scalar', { status: 'success', data: { resultType: 'scalar', result: [0, '3'] } })).toMatchObject({ ok: true, got: 'a scalar (3)' })
    expect(judge('scalar', { status: 'success', data: { resultType: 'string', result: [0, 'x'] } }).ok).toBe(false)
    expect(judge('series', undefined)).toMatchObject({ ok: false, error: 'no usable response' })
  })
})

describe('diagnosis of a failure', () => {
  it('names the one matcher that matches nothing', async () => {
    const result = await run('series', 'redpanda_raft_leader_for{redpanda_namespace="redpanda",redpanda_topic="controller",redpanda_partition="7"}')
    expect(result.problems[1]).toMatch(/: redpanda_partition="7" matches nothing\. redpanda_raft_leader_for has the labels instance, job, redpanda_namespace, redpanda_partition, redpanda_topic$/)
  })

  it('says when the metric has no series at all', async () => {
    const result = await run('series', 'rate(redpanda_uptime_seconds_total[5m])')
    expect(result.problems).toEqual([
      'expected at least one series, got no series',
      'the selector redpanda_uptime_seconds_total matches no series: redpanda_uptime_seconds_total has no series on this cluster'
    ])
  })

  it('reports a query Prometheus rejects, with its message', async () => {
    const result = await run('series', 'no_such_function(redpanda_memory_allocated_memory)')
    expect(result.ok).toBe(false)
    expect(result.got).toBe('Prometheus rejected the query (bad_data: invalid parameter "query": 1:1: parse error: unknown function with name "no_such_function")')
    expect(result.selectors).toEqual([])
  })

  it('fails a range that cannot hold two samples at the scrape interval', async () => {
    const result = await run('series', 'sum(rate(redpanda_raft_leadership_changes[5s]))')
    expect(result.problems).toEqual([
      "a range of 5s holds fewer than two samples at this Prometheus's scrape interval of 5s, so the query cannot return a rate here",
      'expected at least one series, got no series'
    ])
  })
})

describe('waiting for samples', () => {
  const targets = (health = 'up', count = 6) => ({
    status: 'success',
    data: { activeTargets: Array.from({ length: count }, (_, i) => ({ scrapeUrl: `http://redpanda-${i}:9644/metrics`, health, lastError: health === 'up' ? '' : 'connection refused', scrapeInterval: '5s' })) }
  })
  const samples = (n) => ({ status: 'success', data: { resultType: 'vector', result: n === null ? [] : [{ metric: {}, value: [0, String(n)] }] } })

  // A stand-in Prometheus that answers from a list, one entry per poll.
  function scripted (polls) {
    let poll = 0
    const queries = []
    let clock = 0
    return {
      queries,
      client: {
        targets: async () => polls[Math.min(poll, polls.length - 1)].targets,
        query: async (query) => { queries.push(query); return samples(polls[Math.min(poll, polls.length - 1)].samples) }
      },
      sleep: async (ms) => { clock += ms; poll += 1 },
      now: () => clock
    }
  }

  it('derives the samples it needs from the range and the interval', () => {
    expect(samplesNeeded(300, 5)).toBe(4)
    expect(samplesNeeded(15, 5)).toBe(3)
    expect(samplesNeeded(10, 5)).toBe(2)
    expect(samplesNeeded(5, 5)).toBe(2)
    expect(samplesNeeded(Infinity, 5)).toBe(1)
  })

  it('is ready at once on the recorded Prometheus', async () => {
    const ready = await waitForSamples(client(), { ranges: [300, 5], minTargets: 6 })
    expect(ready).toMatchObject({ scrapeInterval: 5, targets: 6, waited: 0 })
  })

  it('waits until every target is up and the shortest range holds enough samples', async () => {
    const stub = scripted([
      { targets: targets('up', 3), samples: 0 },
      { targets: targets('down'), samples: 0 },
      { targets: targets(), samples: 1 },
      { targets: targets(), samples: 4 }
    ])
    const log = []
    const ready = await waitForSamples(stub.client, { ranges: [300, 60], minTargets: 6, sleep: stub.sleep, now: stub.now, log: (line) => log.push(line) })
    expect(ready).toEqual({ scrapeInterval: 5, targets: 6, waited: 15, samples: 4 })
    expect(stub.queries).toEqual(['min(count_over_time(up[60s]))', 'min(count_over_time(up[60s]))'])
    expect(log.join('\n')).toMatch(/3 of 6 scrape targets found[\s\S]*targets not up: .*connection refused[\s\S]*1 of 4 samples per target/)
  })

  it('gives up at the cap and says what was missing', async () => {
    const stub = scripted([{ targets: targets(), samples: 1 }])
    await expect(waitForSamples(stub.client, { ranges: [300], capSeconds: 20, sleep: stub.sleep, now: stub.now }))
      .rejects.toThrow('Prometheus was not ready after 20s: 1 of 4 samples per target')
  })

  it('needs one scrape when no query has a range', async () => {
    const stub = scripted([{ targets: targets(), samples: 2 }])
    const ready = await waitForSamples(stub.client, { ranges: [], sleep: stub.sleep, now: stub.now })
    expect(ready.waited).toBe(0)
  })
})

describe('doc-tools check-queries --prometheus-url', () => {
  let workDir
  const write = (name, ...lines) => fs.writeFileSync(path.join(workDir, name), `${lines.join('\n')}\n`)
  const cli = async (options) => {
    const out = []
    const err = []
    const code = await runCli(['.'], {
      cwd: workDir, dataset: DATASET, prometheusUrl: URL_BASE, fetch: recordedFetch(), minTargets: 6,
      stdout: (text) => out.push(text), stderr: (text) => err.push(text), ...options
    })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }

  beforeEach(() => { workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-queries-live-')) })
  afterEach(() => { fs.rmSync(workDir, { recursive: true, force: true }) })

  it('exits 0 when every query passes, and reports per file', async () => {
    write('join.promql', '# tag::query[]', JOIN(LEADER), '# end::query[]')
    write('no-leader.promql', '# expect: empty', '# tag::query[]', NO_LEADER(LEADER), '# end::query[]')
    const { code, out } = await cli({ json: true })
    expect(code).toBe(0)
    const report = JSON.parse(out)
    expect(report.live).toEqual({ prometheus_url: URL_BASE, targets: 6, scrape_interval_seconds: 5, waited_seconds: 0 })
    expect(report.summary).toEqual({ files: 2, passed: 2, failed: 0, run: 2, static_only: 0, syntax_only: 0 })
    expect(report.results.map((entry) => [entry.file, entry.status, entry.expect, entry.live.got])).toEqual([
      ['join.promql', 'pass', 'series', '1 series'],
      ['no-leader.promql', 'pass', 'empty', 'no series']
    ])
  })

  it('exits 1 on the wrong-label alert, in both layers, and prints why', async () => {
    write('no-leader.promql', '# expect: empty', '# tag::query[]', NO_LEADER(WRONG), '# end::query[]')
    const { code, out } = await cli()
    expect(code).toBe(1)
    expect(out).toContain('FAIL no-leader.promql (expect empty; live: no series)')
    expect(out).toContain('  static, unknown-label: redpanda_raft_leader_for has no label "namespace". Its labels: redpanda_namespace, redpanda_partition, redpanda_topic')
    expect(out).toContain(`  live: ${WRONG_SELECTOR}`)
    expect(out).toContain('1 query file: 0 passed, 1 failed. 1 run on a cluster, 0 checked against the dataset only.')
  })

  it('does not run a skip-run file, and still checks it statically', async () => {
    write('skipped.promql', '# skip-run: the test cluster has no operator', '# tag::query[]', 'rate(redpanda_uptime_seconds_total[5m])', '# end::query[]')
    write('ok.promql', '# tag::query[]', 'count by (job, instance) (up)', '# end::query[]')
    const { code, out } = await cli()
    expect(code).toBe(1)
    expect(out).toContain('PASS ok.promql (expect series; live: 6 series)')
    expect(out).toContain('FAIL skipped.promql (expect series; not run: the test cluster has no operator)')
    expect(out).toContain('static, unknown-metric: redpanda_uptime_seconds_total is not a metric in the dataset')
  })

  describe('a file with exporter', () => {
    const OPERATOR = ['# exporter: redpanda-operator', '# tag::query[]', 'sum by (redpanda_k8s_cluster) (rate(controller_runtime_reconcile_total[5m]))', '# end::query[]']
    // Every query sent to Prometheus, so a test can show a file was not run.
    // The recorded cluster has no operator, so a query on its metrics returns nothing.
    const recording = () => {
      const sent = []
      const inner = recordedFetch()
      const fetch = async (url, request) => {
        const query = request.body ? new URLSearchParams(request.body).get('query') : null
        if (query) sent.push(query)
        if (query && query.includes('controller_runtime')) {
          return { status: 200, json: async () => ({ status: 'success', data: { resultType: 'vector', result: [] } }) }
        }
        return inner(url, request)
      }
      return { fetch, sent }
    }

    it('is not run, passes, and is counted apart from the files that ran', async () => {
      write('ok.promql', '# tag::query[]', 'count by (job, instance) (up)', '# end::query[]')
      write('operator.promql', ...OPERATOR)
      const { fetch, sent } = recording()
      const { code, out } = await cli({ fetch })
      expect(code).toBe(0)
      expect(out).toContain('PASS ok.promql (expect series; live: 6 series)')
      expect(out).toContain('PASS operator.promql (expect series; syntax only; needs the redpanda-operator exporter)')
      expect(out).toContain('2 query files: 2 passed, 0 failed. 1 run on a cluster, 0 checked against the dataset only. 1 checked for syntax only (metrics from another exporter).')
      expect(sent).toContain('count by (job, instance) (up)')
      expect(sent.filter((query) => query.includes('controller_runtime'))).toEqual([])
    })

    it('is run and fails without the setting: the cluster has no such metric', async () => {
      // No range here: the recording has no sample count for a five minute window.
      const query = 'sum by (redpanda_k8s_cluster) (controller_runtime_reconcile_total)'
      write('operator.promql', '# tag::query[]', query, '# end::query[]')
      const { fetch, sent } = recording()
      const { code, out } = await cli({ fetch })
      expect(code).toBe(1)
      expect(out).toContain('FAIL operator.promql (expect series; live: no series)')
      expect(out).toContain('static, unknown-metric: controller_runtime_reconcile_total is not a metric in the dataset')
      expect(out).not.toContain('syntax only')
      expect(sent).toContain(query)

      // The same query with the setting is not sent.
      write('operator.promql', '# exporter: redpanda-operator', '# tag::query[]', query, '# end::query[]')
      const again = recording()
      expect((await cli({ fetch: again.fetch })).code).toBe(0)
      expect(again.sent).toEqual([])
    })

    it('carries the exporter in --json, and that it was not run', async () => {
      write('ok.promql', '# tag::query[]', 'count by (job, instance) (up)', '# end::query[]')
      write('operator.promql', ...OPERATOR)
      const { code, out } = await cli({ json: true })
      expect(code).toBe(0)
      const report = JSON.parse(out)
      expect(report.summary).toEqual({ files: 2, passed: 2, failed: 0, run: 1, static_only: 0, syntax_only: 1 })
      expect(report.results.map((entry) => [entry.file, entry.status, entry.exporter, entry.syntax_only, entry.live === null])).toEqual([
        ['ok.promql', 'pass', null, false, false],
        ['operator.promql', 'pass', 'redpanda-operator', true, true]
      ])
      expect(report.results[1].static).toEqual({ problems: [], notes: [], selectors: [{ selector: 'controller_runtime_reconcile_total', metrics: [] }] })
    })

    it('does not ask Prometheus for anything when no other file can run', async () => {
      write('operator.promql', ...OPERATOR)
      const { fetch, sent } = recording()
      let calls = 0
      const { code, out } = await cli({ fetch: (url, request) => { calls += 1; return fetch(url, request) }, json: true })
      expect(code).toBe(0)
      expect(calls).toBe(0)
      expect(sent).toEqual([])
      expect(JSON.parse(out)).toMatchObject({ live: null, summary: { run: 0, static_only: 0, syntax_only: 1 } })
    })

    it('fails on a syntax error and on a Redpanda metric, and neither is run', async () => {
      write('mixed.promql', '# exporter: kafka-connect', '# tag::query[]', 'kafka_consumer_lag_max and on() redpanda_memory_allocated_memory', '# end::query[]')
      write('syntax.promql', '# exporter: kafka-connect', '# tag::query[]', 'rate(kafka_producer_record_send_total[5m]) < ', '# end::query[]')
      write('ok.promql', '# tag::query[]', 'count by (job, instance) (up)', '# end::query[]')
      const { fetch, sent } = recording()
      const { code, out } = await cli({ fetch })
      expect(code).toBe(1)
      expect(out).toContain('FAIL mixed.promql (expect series; syntax only; needs the kafka-connect exporter)')
      expect(out).toContain('  static, exporter-mixed: redpanda_memory_allocated_memory is a Redpanda metric in the dataset, and the file is marked exporter: kafka-connect')
      expect(out).toContain('FAIL syntax.promql (expect series; syntax only; needs the kafka-connect exporter)')
      expect(out).toContain('  static, syntax: not a PromQL expression')
      expect(out).toContain('3 query files: 1 passed, 2 failed. 1 run on a cluster, 0 checked against the dataset only. 2 checked for syntax only (metrics from another exporter).')
      expect(sent.filter((query) => query.includes('kafka_'))).toEqual([])
    })
  })

  it('exits 2 when Prometheus does not answer', async () => {
    write('ok.promql', '# tag::query[]', 'count by (job, instance) (up)', '# end::query[]')
    const refused = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:9090' } }) }
    const { code, err, out } = await cli({ fetch: refused })
    expect(code).toBe(2)
    expect(err).toContain(`Error: Prometheus at ${URL_BASE} did not answer: connect ECONNREFUSED 127.0.0.1:9090`)
    expect(out).toBe('')
  })

  it('exits 2 when too few targets are up at the cap', async () => {
    write('ok.promql', '# tag::query[]', 'count by (job, instance) (up)', '# end::query[]')
    const { code, err } = await cli({ minTargets: 8, waitCap: 0 })
    expect(code).toBe(2)
    expect(err).toContain('Error: Prometheus was not ready after 0s: 6 of 8 scrape targets found')
  })
})
