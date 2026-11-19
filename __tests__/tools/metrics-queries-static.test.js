'use strict'

/**
 * The static layer of `doc-tools check-queries`: a query checked against the
 * metrics dataset, with no cluster. The dataset fixture is a cut of the one a
 * real v26.2.7 cluster produced, with one family changed to source-only
 * (observed: false, no labels) to stand for a metric the cluster did not
 * export. Every rule has a query that passes and one that fails.
 */

const fs = require('fs')
const path = require('path')
const Ajv = require('ajv')

const { checkQuery, indexDataset, resolveSeries } = require('../../tools/metrics-queries/static-check')

const ROOT = path.join(__dirname, '..', '..')
const DATASET = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'metrics-queries', 'redpanda-metrics-v26.2.7.json'), 'utf8'))
const index = indexDataset(DATASET)

const check = (query, options) => checkQuery(query, index, options)
const rules = (query, options) => check(query, options).problems.map((problem) => problem.rule)
const messages = (query, options) => check(query, options).problems.map((problem) => problem.message)

describe('the dataset fixture', () => {
  it('matches the dataset schema', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs-data', 'redpanda-metrics.schema.json'), 'utf8'))
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema)
    validate(DATASET)
    expect(validate.errors).toBeNull()
  })

  it('refuses a file that is not a dataset', () => {
    expect(() => indexDataset({ public: {}, internal: {} })).toThrow(/no "metrics" object/)
    expect(() => indexDataset(null)).toThrow(/no "metrics" object/)
  })
})

describe('the wrong-label pair from the docs', () => {
  const ALERT = [
    'redpanda_cluster_health_unhealthy_reasons',
    '  and on(instance)',
    '    redpanda_raft_leader_for{namespace="redpanda",topic="controller",partition="0"} == 1'
  ].join('\n')
  const NO_LEADER = 'sum(redpanda_raft_leader_for{namespace="redpanda",topic="controller",partition="0"}) == 0'
  const fixed = (query) => query.replace('{namespace=', '{redpanda_namespace=').replace(',topic=', ',redpanda_topic=').replace(',partition=', ',redpanda_partition=')

  it.each([['the join', ALERT], ['the no-leader alert', NO_LEADER]])('fails %s on all three labels', (_, query) => {
    const result = check(query)
    expect(result.problems.map((problem) => [problem.rule, problem.metric, problem.label])).toEqual([
      ['unknown-label', 'redpanda_raft_leader_for', 'namespace'],
      ['unknown-label', 'redpanda_raft_leader_for', 'topic'],
      ['unknown-label', 'redpanda_raft_leader_for', 'partition']
    ])
    expect(result.problems[0].message).toBe('redpanda_raft_leader_for has no label "namespace". Its labels: redpanda_namespace, redpanda_partition, redpanda_topic')
    expect(result.problems[0].known_labels).toEqual(['__name__', 'instance', 'job', 'redpanda_namespace', 'redpanda_partition', 'redpanda_topic'])
  })

  it.each([['the join', ALERT], ['the no-leader alert', NO_LEADER]])('passes %s with the real label names', (_, query) => {
    expect(check(fixed(query)).problems).toEqual([])
  })
})

describe('unknown-metric', () => {
  it('passes a metric the dataset has', () => {
    expect(rules('redpanda_memory_allocated_memory')).toEqual([])
    expect(rules('vectorized_raft_group_count')).toEqual([])
  })

  it('fails a metric the dataset does not have, and names close ones', () => {
    expect(messages('rate(redpanda_uptime_seconds_total[5m])')).toEqual([
      'redpanda_uptime_seconds_total is not a metric in the dataset. Close names: redpanda_application_uptime_seconds_total'
    ])
    expect(messages('redpanda_memory_alocated_memory')[0]).toMatch(/Close names: redpanda_memory_allocated_memory/)
    expect(rules('kafka_connect_connector_failed_task_count > 0')).toEqual(['unknown-metric'])
  })

  it('reads a __name__ matcher as the metric name', () => {
    expect(rules('{__name__="redpanda_memory_allocated_memory"}')).toEqual([])
    expect(rules('{__name__="redpanda_memory_gone"}')).toEqual(['unknown-metric'])
    expect(rules('{__name__=~"redpanda_memory_.*"}')).toEqual([])
    expect(messages('count({__name__=~"operator_.*|workqueue_.*"})')).toEqual(['{__name__=~"operator_.*|workqueue_.*"} matches no metric in the dataset'])
  })

  it('knows the series Prometheus writes for every target', () => {
    expect(rules('up == 0')).toEqual([])
    expect(rules('count by (job, instance) (up)')).toEqual([])
    expect(rules('up{shard="0"}')).toEqual(['unknown-label'])
  })

  it('lists the selectors with what they resolved to', () => {
    expect(check('rate(redpanda_kafka_request_latency_seconds_count{redpanda_request="produce"}[5m])').selectors).toEqual([{
      selector: 'redpanda_kafka_request_latency_seconds_count{redpanda_request="produce"}',
      metrics: [{ name: 'redpanda_kafka_request_latency_seconds_count', family: 'redpanda_kafka_request_latency_seconds', type: 'histogram', observed: true }]
    }])
  })
})

describe('histogram series and names that end in _sum or _count', () => {
  it('resolves _bucket, _count and _sum through the family type', () => {
    for (const suffix of ['_bucket', '_count', '_sum']) {
      expect(resolveSeries(index, `redpanda_kafka_request_latency_seconds${suffix}`)).toMatchObject({ family: 'redpanda_kafka_request_latency_seconds', suffix })
    }
  })

  it('fails a histogram queried by its family name', () => {
    expect(messages('redpanda_kafka_request_latency_seconds')).toEqual([
      'redpanda_kafka_request_latency_seconds is a histogram. Query redpanda_kafka_request_latency_seconds_bucket, redpanda_kafka_request_latency_seconds_count or redpanda_kafka_request_latency_seconds_sum'
    ])
    expect(rules('redpanda_kafka_request_latency_seconds')).toEqual(['histogram-series'])
  })

  // redpanda_kafka_consumer_group_lag_sum and
  // redpanda_schema_registry_cache_schema_count are gauges. Stripping the
  // suffix would look for families that do not exist.
  it('reads a gauge that ends in _sum or _count as itself', () => {
    expect(resolveSeries(index, 'redpanda_kafka_consumer_group_lag_sum')).toMatchObject({ family: 'redpanda_kafka_consumer_group_lag_sum', suffix: null })
    expect(rules('redpanda_kafka_consumer_group_lag_sum{redpanda_group="g"}')).toEqual([])
    expect(rules('redpanda_schema_registry_cache_schema_count')).toEqual([])
    expect(index.families.has('redpanda_kafka_consumer_group_lag')).toBe(false)
  })

  // No release has this pair today. If one does, the gauge is a family of
  // its own and must win over the histogram's series of the same name.
  it('reads a gauge as itself when a histogram has a series of the same name', () => {
    const metric = (name, type) => ({ name, type, labels: [{ name: type === 'gauge' ? 'gauge_label' : 'histogram_label' }], observed: true })
    for (const order of [['a_sum', 'a'], ['a', 'a_sum']]) {
      const metrics = {}
      for (const name of order) metrics[name] = metric(name, name === 'a' ? 'histogram' : 'gauge')
      const collided = indexDataset({ metrics })
      expect(resolveSeries(collided, 'a_sum')).toMatchObject({ family: 'a_sum', suffix: null })
      expect(checkQuery('a_sum{gauge_label="x"}', collided).problems).toEqual([])
      expect(checkQuery('rate(a_sum[5m])', collided).problems.map((problem) => problem.rule)).toEqual(['rate-on-gauge'])
    }
  })

  it('fails a suffix on a family that is not a histogram', () => {
    expect(messages('redpanda_memory_allocated_memory_count')).toEqual([
      'redpanda_memory_allocated_memory_count is not a metric in the dataset. redpanda_memory_allocated_memory is a gauge, not a histogram, so it has no _count series'
    ])
    expect(rules('redpanda_kafka_consumer_group_lag_sum_bucket')).toEqual(['unknown-metric'])
  })

  it('gives le to _bucket only', () => {
    expect(rules('redpanda_kafka_request_latency_seconds_bucket{le="+Inf"}')).toEqual([])
    expect(rules('redpanda_kafka_request_latency_seconds_count{le="+Inf"}')).toEqual(['unknown-label'])
    expect(rules('redpanda_memory_allocated_memory{le="1"}')).toEqual(['unknown-label'])
  })
})

describe('unknown-label, by clause', () => {
  it.each([
    ['a matcher', 'redpanda_kafka_max_offset{redpanda_topic="t"}', 'redpanda_kafka_max_offset{topic="t"}'],
    ['a regex matcher', 'redpanda_kafka_max_offset{redpanda_topic=~"t.*"}', 'redpanda_kafka_max_offset{topic=~"t.*"}'],
    ['by', 'sum by (redpanda_topic) (redpanda_kafka_max_offset)', 'sum by (topic) (redpanda_kafka_max_offset)'],
    ['by after the expression', 'sum(redpanda_kafka_max_offset) by (redpanda_topic)', 'sum(redpanda_kafka_max_offset) by (topic)'],
    ['without', 'sum without (redpanda_status) (rate(redpanda_schema_registry_request_errors_total[5m]))', 'sum without (status) (rate(redpanda_schema_registry_request_errors_total[5m]))'],
    ['ignoring', 'redpanda_kafka_max_offset - ignoring (redpanda_namespace, redpanda_group) redpanda_kafka_consumer_group_committed_offset', 'redpanda_kafka_max_offset - ignoring (namespace) redpanda_kafka_consumer_group_committed_offset'],
    ['group_left', 'redpanda_kafka_consumer_group_committed_offset * on (redpanda_topic) group_left (redpanda_namespace) redpanda_kafka_max_offset', 'redpanda_kafka_consumer_group_committed_offset * on (redpanda_topic) group_left (namespace) redpanda_kafka_max_offset'],
    ['group_right', 'redpanda_kafka_max_offset * on (redpanda_topic) group_right (redpanda_namespace) redpanda_kafka_consumer_group_committed_offset', 'redpanda_kafka_max_offset * on (redpanda_topic) group_right (redpanda_group) redpanda_kafka_consumer_group_committed_offset'],
    ['label_replace', 'label_replace(redpanda_kafka_max_offset, "topic", "$1", "redpanda_topic", "(.*)")', 'label_replace(redpanda_kafka_max_offset, "topic", "$1", "topic_name", "(.*)")']
  ])('%s: passes the real label and fails the wrong one', (_, good, bad) => {
    expect(rules(good)).toEqual([])
    expect(rules(bad)).toEqual(['unknown-label'])
  })

  it('checks on (...) against both sides', () => {
    expect(rules('redpanda_kafka_max_offset - on (redpanda_topic, redpanda_partition) redpanda_kafka_consumer_group_committed_offset')).toEqual([])
    // A label neither side has is reported for each side.
    expect(rules('redpanda_kafka_max_offset - on (redpanda_topic, partition) redpanda_kafka_consumer_group_committed_offset')).toEqual(['unknown-label', 'unknown-label'])
    // redpanda_group is only on the right side, redpanda_namespace only on the left.
    expect(messages('redpanda_kafka_max_offset - on (redpanda_group) redpanda_kafka_consumer_group_committed_offset')).toEqual([
      'on (...), left side of -, names the label "redpanda_group", which redpanda_kafka_max_offset does not have at that point. Labels there: redpanda_namespace, redpanda_partition, redpanda_topic, shard'
    ])
    expect(messages('redpanda_kafka_max_offset - on (redpanda_namespace) redpanda_kafka_consumer_group_committed_offset')[0]).toMatch(/^on \(\.\.\.\), right side of -,/)
  })

  it('accepts the labels Prometheus adds, on any metric', () => {
    expect(rules('sum by (instance, job) (redpanda_memory_allocated_memory{instance="redpanda-0:9644", job="redpanda"})')).toEqual([])
    expect(rules('redpanda_cluster_health_unhealthy_reasons and on (instance) redpanda_raft_leader_for')).toEqual([])
  })

  it('follows the labels an aggregation leaves', () => {
    // sum by (redpanda_topic) drops redpanda_partition, so the outer by cannot use it.
    expect(rules('max by (redpanda_topic) (sum by (redpanda_topic, redpanda_partition) (redpanda_kafka_max_offset))')).toEqual([])
    expect(messages('max by (redpanda_partition) (sum by (redpanda_topic) (redpanda_kafka_max_offset))')).toEqual([
      'max by (...) names the label "redpanda_partition", which redpanda_kafka_max_offset does not have at that point. Labels there: redpanda_topic'
    ])
    // sum with no grouping leaves no label, instance included.
    expect(rules('sum(redpanda_kafka_max_offset) and on (instance) redpanda_raft_leader_for')).toEqual(['unknown-label'])
    expect(rules('sum without (shard) (redpanda_kafka_max_offset) and on (redpanda_topic) redpanda_raft_leader_for')).toEqual([])
    expect(rules('sum without (shard) (redpanda_kafka_max_offset) and on (shard) redpanda_kafka_max_offset')).toEqual(['unknown-label'])
    // topk keeps every label of the series it picks.
    expect(rules('sum by (redpanda_topic) (topk(3, redpanda_kafka_max_offset))')).toEqual([])
    // count_values adds the label it is given.
    expect(rules('sum by (offset_value) (count_values("offset_value", redpanda_kafka_max_offset))')).toEqual([])
    // label_replace adds its destination label.
    expect(rules('sum by (topic) (label_replace(redpanda_kafka_max_offset, "topic", "$1", "redpanda_topic", "(.*)"))')).toEqual([])
  })

  it('passes the consumer lag query from the docs', () => {
    expect(rules('max by(redpanda_namespace, redpanda_topic, redpanda_partition)(redpanda_kafka_max_offset{redpanda_namespace="kafka"}) - on(redpanda_topic, redpanda_partition) group_right max by(redpanda_group, redpanda_topic, redpanda_partition)(redpanda_kafka_consumer_group_committed_offset)')).toEqual([])
  })
})

describe('extra-labels: labels the reader\'s Prometheus adds', () => {
  const QUERY = 'histogram_quantile(0.99, sum(rate(redpanda_kafka_request_latency_seconds_bucket{redpanda_request="produce"}[5m])) by (le, provider, region, instance, namespace, pod))'

  it('fails them when the file does not declare them', () => {
    expect(check(QUERY).problems.map((problem) => problem.label)).toEqual(['provider', 'region', 'namespace', 'pod'])
  })

  it('passes them when the file declares them', () => {
    expect(rules(QUERY, { extraLabels: ['provider', 'region', 'namespace', 'pod'] })).toEqual([])
  })

  it('still fails a label that is not declared', () => {
    expect(check(QUERY, { extraLabels: ['provider', 'region', 'namespace'] }).problems.map((problem) => problem.label)).toEqual(['pod'])
  })
})

describe('rate-on-gauge', () => {
  it.each(['rate', 'irate', 'increase'])('%s passes on a counter and on histogram series', (fn) => {
    expect(rules(`${fn}(redpanda_kafka_records_produced_total[5m])`)).toEqual([])
    expect(rules(`${fn}(redpanda_kafka_request_latency_seconds_count[5m])`)).toEqual([])
    expect(rules(`${fn}(redpanda_kafka_request_latency_seconds_sum[5m])`)).toEqual([])
    expect(rules(`${fn}(redpanda_kafka_request_latency_seconds_bucket[5m])`)).toEqual([])
  })

  it.each(['rate', 'irate', 'increase'])('%s fails on a gauge', (fn) => {
    expect(rules(`${fn}(redpanda_memory_allocated_memory[5m])`)).toEqual(['rate-on-gauge'])
    expect(rules(`sum(${fn}((redpanda_kafka_consumer_group_lag_sum[5m])))`)).toEqual(['rate-on-gauge'])
  })

  // The broker exports this cumulative value with TYPE gauge, so the rule
  // fails it. The dataset says what the broker says.
  it('fails a cumulative value that the broker exports as a gauge', () => {
    expect(messages('rate(redpanda_cpu_busy_seconds_total[5m])')).toEqual([
      'rate() is applied to redpanda_cpu_busy_seconds_total, which is a gauge. rate() is for counters. For a gauge use delta(), deriv() or the value itself'
    ])
  })

  it('leaves other range functions alone', () => {
    expect(rules('avg_over_time(redpanda_memory_allocated_memory[5m])')).toEqual([])
    expect(rules('delta(redpanda_memory_allocated_memory[5m])')).toEqual([])
  })

  it('fails rate with no range', () => {
    expect(messages('rate(redpanda_kafka_records_produced_total)')).toEqual(['rate() needs a range, for example rate(metric[5m])'])
  })

  it('does not judge a subquery', () => {
    expect(rules('rate(sum(redpanda_memory_allocated_memory)[5m:1m])')).toEqual([])
  })
})

describe('quantile-needs-bucket', () => {
  it('passes _bucket series that keep le', () => {
    expect(rules('histogram_quantile(0.99, sum(rate(redpanda_kafka_request_latency_seconds_bucket[5m])) by (le))')).toEqual([])
    expect(rules('histogram_quantile(0.99, (sum(rate(redpanda_kafka_request_latency_seconds_bucket[5m])) by (le, instance)))')).toEqual([])
    expect(rules('histogram_quantile(0.5, rate(redpanda_kafka_request_latency_seconds_bucket[5m]))')).toEqual([])
    expect(rules('histogram_quantile(0.99, sum without (redpanda_request) (rate(redpanda_kafka_request_latency_seconds_bucket[5m])))')).toEqual([])
  })

  it.each([
    ['the _count series', 'histogram_quantile(0.99, sum(rate(redpanda_kafka_request_latency_seconds_count[5m])) by (instance))'],
    ['the _sum series', 'histogram_quantile(0.99, rate(redpanda_kafka_request_latency_seconds_sum[5m]))'],
    ['a counter', 'histogram_quantile(0.99, rate(redpanda_kafka_records_produced_total[5m]))'],
    ['a gauge', 'histogram_quantile(0.99, redpanda_memory_allocated_memory)']
  ])('fails %s', (_, query) => {
    expect(rules(query)).toEqual(['quantile-needs-bucket'])
  })

  it('fails _bucket series whose le was aggregated away', () => {
    expect(messages('histogram_quantile(0.99, sum(rate(redpanda_kafka_request_latency_seconds_bucket[5m])) by (instance))')).toEqual([
      'histogram_quantile() needs the le label, and the expression inside it aggregates le away. Add le to by (...)'
    ])
    expect(rules('histogram_quantile(0.99, sum(rate(redpanda_kafka_request_latency_seconds_bucket[5m])))')).toEqual(['quantile-needs-bucket'])
  })

  it('drops le from the result', () => {
    expect(rules('max by (le) (histogram_quantile(0.99, sum(rate(redpanda_kafka_request_latency_seconds_bucket[5m])) by (le, instance)))')).toEqual(['unknown-label'])
  })
})

describe('a metric the cluster did not export (observed: false)', () => {
  const NAME = 'redpanda_cloud_storage_cache_op_hit'

  it('is in the fixture with no labels', () => {
    expect(DATASET.metrics[NAME]).toMatchObject({ observed: false, labels: [] })
  })

  it('passes on the name, and says its labels were not checked', () => {
    const result = check(`sum by (anything) (rate(${NAME}{whatever="x"}[5m]))`)
    expect(result.problems).toEqual([])
    expect(result.notes).toEqual([`${NAME}: the dataset has no labels for this metric (it was not exported by the cluster the dataset came from), so its labels were not checked`])
    expect(result.selectors[0].metrics[0]).toMatchObject({ name: NAME, observed: false })
  })

  it('still checks its type', () => {
    expect(rules(`histogram_quantile(0.9, rate(${NAME}[5m]))`)).toEqual(['quantile-needs-bucket'])
  })

  it('still fails a name that is close to it and wrong', () => {
    expect(rules(`${NAME}s`)).toEqual(['unknown-metric'])
  })

  it('the same query on an observed metric fails', () => {
    expect(rules('sum by (anything) (rate(redpanda_kafka_records_produced_total{whatever="x"}[5m]))')).toEqual(['unknown-label', 'unknown-label'])
  })
})

describe('what the static layer cannot check', () => {
  it('says so for a selector with no metric name', () => {
    const result = check('sum by (anything) ({job="redpanda"})')
    expect(result.problems).toEqual([])
    expect(result.notes).toEqual(['{job="redpanda"}: no metric name, so its labels were not checked'])
  })

  it('reports text that is not PromQL as a syntax problem', () => {
    const result = check('rate(a[5m]),\nrate(b[5m])')
    expect(result.problems.map((problem) => problem.rule)).toEqual(['syntax'])
    expect(result.ast).toBeNull()
  })

  it('does not check function names: Prometheus does, in the live layer', () => {
    expect(rules('no_such_function(redpanda_memory_allocated_memory)')).toEqual([])
  })

  it('tells a scalar from a vector', () => {
    expect(check('scalar(sum(redpanda_memory_allocated_memory))').kind).toBe('scalar')
    expect(check('1 + 1').kind).toBe('scalar')
    expect(check('1 - sum(redpanda_memory_allocated_memory)').kind).toBe('vector')
  })
})
