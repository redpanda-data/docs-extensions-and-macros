// Fixture source for lint-strings metrics-scanner tests. Mirrors the shapes
// in redpanda's src/v/cluster/partition_probe.cc: single-literal and
// clang-format-wrapped adjacent-literal sm::description() arguments, plus a
// non-literal argument that must stay unverifiable (info-level, never error).
// Tests assert both rule ids and line spans, located by marker strings.
#include "cluster/lint_probe.h"

namespace cluster {

void lint_probe::setup_metrics() {
    namespace sm = ss::metrics;

    _metrics.add_group(
      prometheus_sanitize::metrics_name("cluster:partition"),
      {
        sm::make_gauge(
          "start_offset",
          [this] { return _start_offset; },
          sm::description("start offset"),
          labels),
        sm::make_gauge(
          "committed_offset",
          [this] { return _committed_offset; },
          sm::description(
            "Partition commited offset. i.e. safely persisted on "
            "majority of replicas."),
          labels),
        sm::make_counter(
          "records_produced",
          [this] { return _records_produced; },
          sm::description("Total number of records produced"),
          labels),
        sm::make_gauge(
          "buffer_size",
          [this] { return _buffer_size; },
          sm::description(fmt::format("Size of {} buffer", _name)),
          labels),
      });
}

} // namespace cluster
