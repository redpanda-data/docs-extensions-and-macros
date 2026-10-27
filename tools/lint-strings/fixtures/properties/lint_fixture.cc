// Fixture source for lint-strings tests. Member-initializer entries mirror
// redpanda's src/v/config/configuration.cc, including clang-format-wrapped
// adjacent string literals. Tests assert both rule ids and line spans, so
// edit with care: spans are located by searching for the marker strings.
#include "lint_fixture.h"

namespace config {

lint_fixture_config::lint_fixture_config()
  : compaction_ctrl_update_interval_ms(
      *this,
      "compaction_ctrl_update_interval_ms",
      "",
      {.needs_restart = needs_restart::no, .visibility = visibility::tunable},
      30s)
  , cloud_storage_credentials_source(
      *this,
      "cloud_storage_credentials_source",
      "The source of credentials used to connect to cloud services. "
      "Accepted values: `config_file`, `aws_instance_metadata`, `sts, "
      "`gcp_instance_metadata`.",
      {.needs_restart = needs_restart::yes, .visibility = visibility::user},
      std::nullopt)
  , cloud_storage_upload_ctrl_p_coeff(
      *this,
      "cloud_storage_upload_ctrl_p_coeff",
      "proportional coefficient for upload PID controller",
      {.needs_restart = needs_restart::yes, .visibility = visibility::tunable},
      -2.0)
  , cluster_id(
      *this,
      "cluster_id",
      "Cluster identifier.",
      {.needs_restart = needs_restart::no, .visibility = visibility::user},
      std::nullopt)
  , write_caching_default_bytes(
      *this,
      "write_caching_default_bytes",
      "recomended default",
      {.needs_restart = needs_restart::no, .visibility = visibility::tunable},
      1024)
  , kafka_batch_max_bytes(
      *this,
      "kafka_batch_max_bytes",
      "Maximum size of a batch processed by the server. If the batch is "
      "compressed, the limit applies to the compressed batch size. Default "
      "is 1048576 bytes.",
      {.needs_restart = needs_restart::no, .visibility = visibility::user},
      1048576) {}

} // namespace config
