// Eval fixture: every sm::description string in this file conforms to the
// metrics doc-string contract (capitalized, no terminal period, no name
// echo, no raw | or {attr}, plain adjacent string literals). Used by the
// negative-control eval: lint-strings must report zero findings here, and a
// model reviewing it must claim zero findings. Edit with care - a single
// nonconforming string silently turns the negative control into a positive
// case (the harness asserts the zero-findings precondition on every run).
#include "cluster/eval_probe.h"

namespace cluster {

void eval_probe::setup_metrics() {
    namespace sm = ss::metrics;

    _metrics.add_group(
      prometheus_sanitize::metrics_name("cluster:partition"),
      {
        sm::make_gauge(
          "under_replicated_replicas",
          [this] { return _under_replicated; },
          sm::description("Number of replicas that are live but lagging "
                          "behind the leader's committed offset"),
          labels),
        sm::make_counter(
          "records_fetched",
          [this] { return _records_fetched; },
          sm::description("Total number of records consumed from this "
                          "partition by Kafka fetch requests"),
          labels),
        sm::make_histogram(
          "produce_latency_seconds",
          [this] { return _produce_latency; },
          sm::description("Time in seconds between receiving a produce "
                          "request and acknowledging its commit"),
          labels),
      });
}

} // namespace cluster
