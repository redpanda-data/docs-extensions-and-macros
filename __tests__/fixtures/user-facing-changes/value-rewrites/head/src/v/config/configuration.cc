#include "config/configuration.h"
namespace config {
configuration::configuration()
  : rpc_server_max_conns(
      *this,
      "rpc_server_max_conns",
      "The maximum number of connections.",
      {.needs_restart = needs_restart::yes, .visibility = visibility::user},
      default_rpc_conns,
      {.min = 8})
  , raft_heartbeat_interval_ms(
      *this,
      "raft_heartbeat_interval_ms",
      "Milliseconds between Raft heartbeats.",
      {.visibility = visibility::tunable},
      150ms)
  , log_segment_size(
      *this,
      "log_segment_size",
      "Default log segment size in bytes.",
      {.needs_restart = needs_restart::no, .visibility = visibility::tunable},
      134217728) {}
}
