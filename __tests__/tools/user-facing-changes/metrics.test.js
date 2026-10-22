'use strict'

const { detect, kinds } = require('./helpers')
const { parseMetrics } = require('../../../tools/user-facing-changes/detectors/metrics')

const FILE = 'src/v/cluster/partition_probe.cc'

// Synthetic probe in the shapes redpanda uses: definitions inline in an
// add_group call, definitions built into a vector first and registered by a
// later add_group, and a public registry reached through a pointer.
const SOURCE = `#include "cluster/partition_probe.h"

namespace cluster {

void partition_probe::setup_metrics() {
    namespace sm = ss::metrics;
    if (config::shard_local_cfg().disable_metrics()) {
        return;
    }
    _metrics.add_group(
      prometheus_sanitize::metrics_name("cluster:partition"),
      {
        sm::make_gauge(
          "start_offset",
          [this] { return _start_offset; },
          sm::description("Partition start offset"),
          labels),
        sm::make_counter(
          "records_produced",
          [this] { return _records_produced; },
          sm::description("Total number of records produced"),
          labels),
      });

    std::vector<sm::impl::metric_definition_impl> defs;
    defs.emplace_back(
      sm::make_histogram(
        "write_latency_microseconds",
        [this] { return _write_latency.internal_histogram_logform(); },
        sm::description("Write latency")));
    _public_metrics->add_group(
      prometheus_sanitize::metrics_name("kafka"),
      std::move(defs),
      {},
      {sm::shard_label});
}

// A comment naming sm::make_gauge("not_a_metric", ...) must never count.

} // namespace cluster
`

const base = { [FILE]: SOURCE }
const edit = (from, to) => ({ [FILE]: SOURCE.replace(from, to) })

describe('parseMetrics', () => {
  test('names every metric with its group and registry', () => {
    const { metrics, unresolved } = parseMetrics([{ startLine: 1, text: SOURCE }])
    expect(unresolved).toEqual([])
    expect([...metrics.keys()]).toEqual([
      'vectorized_cluster_partition_start_offset',
      'vectorized_cluster_partition_records_produced',
      'redpanda_kafka_write_latency_microseconds'
    ])
    expect(metrics.get('vectorized_cluster_partition_start_offset')).toMatchObject({ kind: 'gauge', registry: 'internal', line: 13 })
    // Built into a vector, registered by the add_group that follows, through a pointer.
    expect(metrics.get('redpanda_kafka_write_latency_microseconds')).toMatchObject({ kind: 'histogram', registry: 'public', group: 'kafka' })
  })
})

describe('metrics detector', () => {
  test('a new metric is added (medium) on the right reference page (PR 740 shape)', () => {
    const r = detect(base, edit(
      '      });\n\n    std::vector',
      '        sm::make_gauge(\n          "committed_offset",\n          [this] { return _committed_offset; },\n          sm::description("Partition committed offset"),\n          labels),\n      });\n\n    std::vector'))
    expect(kinds(r)).toEqual([['added', 'vectorized_cluster_partition_committed_offset']])
    expect(r.findings[0]).toMatchObject({ surface: 'metrics', severity: 'medium', file: FILE, line: 23 })
    expect(r.findings[0].affected_pages).toEqual(['https://docs.redpanda.com/streaming/current/reference/internal-metrics-reference/'])
    expect(r.findings[0].evidence).toMatch(/^\+\s+"committed_offset",$/m)
  })

  test('a public metric routes to the public metrics reference', () => {
    const r = detect(base, edit('sm::description("Write latency")));', 'sm::description("Write latency")));\n    defs.emplace_back(\n      sm::make_counter(\n        "requests_total",\n        [this] { return _requests; },\n        sm::description("Total requests")));'))
    expect(kinds(r)).toEqual([['added', 'redpanda_kafka_requests_total']])
    expect(r.findings[0].affected_pages).toEqual(['https://docs.redpanda.com/streaming/current/reference/public-metrics-reference/'])
  })

  test('a removed metric is high', () => {
    const r = detect(base, edit('        sm::make_counter(\n          "records_produced",\n          [this] { return _records_produced; },\n          sm::description("Total number of records produced"),\n          labels),\n', ''))
    expect(kinds(r)).toEqual([['removed', 'vectorized_cluster_partition_records_produced']])
    expect(r.findings[0]).toMatchObject({ severity: 'high', line: 18 })
    expect(r.findings[0].evidence).toMatch(/^-\s+"records_produced",$/m)
  })

  test('one removed and one added in the same group is a rename', () => {
    const r = detect(base, edit('"records_produced"', '"produced_records"'))
    expect(kinds(r)).toEqual([['renamed', 'vectorized_cluster_partition_produced_records']])
    expect(r.findings[0].summary).toMatch(/`vectorized_cluster_partition_records_produced` was removed and `vectorized_cluster_partition_produced_records` was added/)
  })

  test('a metric moved to another group is a removal and an addition, not a rename', () => {
    const r = detect(base, edit('metrics_name("kafka")', 'metrics_name("kafka:rpc")'))
    expect(kinds(r)).toEqual([
      ['removed', 'redpanda_kafka_write_latency_microseconds'],
      ['added', 'redpanda_kafka_rpc_write_latency_microseconds']
    ])
  })
})

describe('metrics detector: negative controls', () => {
  test('a description change is the lint\'s and yields nothing', () => {
    const r = detect(base, edit('sm::description("Partition start offset")', 'sm::description("The partition start offset.")'))
    expect(r.findings).toEqual([])
  })

  test('a lambda body change (refactor), a label change and a comment change yield nothing', () => {
    expect(detect(base, edit('[this] { return _start_offset; }', '[this] { return _log->start_offset(); }')).findings).toEqual([])
    expect(detect(base, edit('{sm::shard_label});', '{sm::shard_label, partition_label});')).findings).toEqual([])
    expect(detect(base, edit('"not_a_metric"', '"still_not_a_metric"')).findings).toEqual([])
  })

  test('reordering definitions yields nothing', () => {
    const a = /        sm::make_gauge\(\n          "start_offset",[\s\S]*?labels\),\n/.exec(SOURCE)[0]
    const b = /        sm::make_counter\(\n          "records_produced",[\s\S]*?labels\),\n/.exec(SOURCE)[0]
    expect(detect(base, { [FILE]: SOURCE.replace(a + b, b + a) }).findings).toEqual([])
  })

  test('test sources and config sources are not routed here', () => {
    const T = 'src/v/cluster/tests/partition_probe_test.cc'
    expect(detect({ [T]: SOURCE }, { [T]: SOURCE.replace('"start_offset"', '"first_offset"') }).findings).toEqual([])
  })

  test('a C++ file with no metric factories yields nothing', () => {
    const F = 'src/v/cluster/controller.cc'
    expect(detect({ [F]: 'int make_decision(int x) { return x; }\n' }, { [F]: 'int make_decision(int x) { return x + 1; }\n' }).findings).toEqual([])
  })
})
