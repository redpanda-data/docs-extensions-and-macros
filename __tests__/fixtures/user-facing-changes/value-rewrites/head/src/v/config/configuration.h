#pragma once
namespace config {
inline constexpr int default_rpc_conns = 256;
struct configuration final : public config_store {
    property<int> rpc_server_max_conns;
    property<std::chrono::milliseconds> raft_heartbeat_interval_ms;
    property<size_t> log_segment_size;
};
}
