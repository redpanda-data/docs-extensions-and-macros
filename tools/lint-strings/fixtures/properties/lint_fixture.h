// Fixture header for lint-strings tests. The declarations mirror the shapes
// in redpanda's src/v/config/configuration.h so the real property extractor
// can parse the matching .cc file.
#pragma once

#include "config/property.h"

namespace config {

struct lint_fixture_config {
    // Known-bad: empty description (mirrors configuration.cc
    // compaction_ctrl_update_interval_ms)
    property<std::chrono::milliseconds> compaction_ctrl_update_interval_ms;

    // Known-bad: unbalanced backticks (mirrors configuration.cc
    // cloud_storage_credentials_source)
    enum_property<ss::sstring> cloud_storage_credentials_source;

    // Known-bad: lowercase-start fragment, no terminal period
    property<double> cloud_storage_upload_ctrl_p_coeff;

    // Known-bad: tautology (description just restates the name)
    property<std::optional<ss::sstring>> cluster_id;

    // Known-bad: "recomended" typo string. Typo detection is NOT a lint rule;
    // this doubles as the lowercase-start + under-20-chars example.
    property<int32_t> write_caching_default_bytes;

    // Conforming counterpart: must produce zero findings.
    property<int32_t> kafka_batch_max_bytes;
};

} // namespace config
