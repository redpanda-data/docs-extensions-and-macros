#!/usr/bin/env python3
"""Static extractor for Redpanda Prometheus metric families.

Reads a Redpanda (streaming-enterprise) clone at a git ref without checking it
out (only `git grep` and `git show <ref>:<path>`), finds every Seastar
`make_*` metric registration under src/v, resolves the group name, metric name,
endpoint (/public_metrics -> redpanda_*, /metrics -> vectorized_*), type and
HELP text, and prints JSON on stdout:

  {"ref": ..., "public": {name: {...}}, "internal": {name: {...}},
   "unresolved": [...]}

Usage:
  extract_source.py --repo <clone> --ref <tag> [--seastar-json <file>]

Standard library only; Python 3.9+.
"""

import argparse
import json
import os
import re
import subprocess
import sys

# =============================================================================
# RULES  (manual knowledge the static pass cannot derive on its own)
# =============================================================================

# Group expressions whose value is decided at runtime. Each rule is
# (file, regex, groups). The regex is searched in the whitespace-normalised
# group argument of add_group, followed by " := " and the right-hand side of
# the nearest preceding assignment when the argument is a variable.
# Groups are final, already-sanitised names.
GROUP_RULES = [
    # default upstream uses "cloud_roles::auth_refresh"; named upstreams add the upstream key (credential_manager.cc)
    ("src/v/cloud_roles/probe.cc", r"auth_refresh",
     ["cloud_roles__auth_refresh", "cloud_roles__<upstream>_auth_refresh"]),
    # sformat("{}:sasl", name) where name is the Kafka server config name "kafka_rpc" (kafka/server/server.cc)
    ("src/v/kafka/server/sasl_probe.h", r"\{\}:sasl", ["kafka_rpc_sasl"]),
    # kafka::server's net::server_configuration is named "kafka_rpc" (application_services.cc)
    ("src/v/kafka/server/server.cc", r"cfg\.name", ["kafka_rpc"]),
    # net::server is instantiated for "kafka_rpc" and "internal_rpc" (application_services.cc, application_bootstrap.cc)
    ("src/v/net/server.cc", r"cfg\.name", ["kafka_rpc", "internal_rpc"]),
    # server_probe::setup_metrics(mgs, proto) with proto = server config name
    ("src/v/net/probes.cc", r"\bproto\b", ["kafka_rpc", "internal_rpc"]),
    # client_probe::setup_metrics(name, ...) is only called with "rpc_client" (rpc/transport.cc)
    ("src/v/net/probes.cc", r"sstring\(\s*name\s*\)", ["rpc_client"]),
    # "{}:backlog:controller" with labels from archival/upload_controller.cc and storage/compaction_controller.cc
    ("src/v/storage/backlog_controller.cc", r"backlog:controller",
     ["archival_upload_backlog_controller", "storage_compaction_backlog_controller"]),
    # probe config group_name is link_probe::shadow_link_group = "shadow_link" (cluster_link/link.cc)
    ("src/v/cluster_link/replication/replication_probe.cc", r"group_name", ["shadow_link"]),
    # probe config group_name is link_probe::shadow_link_group = "shadow_link" (cluster_link/service.cc)
    ("src/v/kafka/client/direct_consumer/direct_consumer_probe.cc", r"group_name", ["shadow_link"]),
    # link_probe::shadow_link_group is defined in cluster_link/link_probe.h as "shadow_link"
    ("src/v/cluster_link/schema_registry_sync/probe.cc", r"shadow_link_group", ["shadow_link"]),
    # pandaproxy server probes get the public group name "rest_proxy" (rest/proxy.cc) or "schema_registry" (schema_registry/service.cc)
    ("src/v/pandaproxy/probe.cc", r"^group_name$", ["rest_proxy", "schema_registry"]),
]

# Receivers typed metrics::metric_groups_base& that are called with both the
# internal and the public groups. (file, receiver variable) -> endpoints.
ENDPOINT_RULES = {
    # lambda add_group(metrics) is called with _metrics and _public_metrics (authorizer.cc setup_metrics)
    ("src/v/security/authorizer.cc", "metrics"): ["internal", "public"],
    # setup_metrics(metric_groups) is called with _public_metrics and _metrics
    ("src/v/cluster/node_status_backend.cc", "metric_groups"): ["internal", "public"],
    # probe::setup_metrics(metrics) is called with _metrics and _public_metrics
    ("src/v/cluster/partition_balancer_state.cc", "metrics"): ["internal", "public"],
    # setup_metrics_for(metrics) is called with _metrics and _public_metrics
    ("src/v/features/feature_table.cc", "metrics"): ["internal", "public"],
}

# Per-family endpoint pins: (file, group, metric name) -> endpoints.
FAMILY_ENDPOINT_RULES = {
    # buffer_usage_ratio is appended to the internal defs only; the public group gets setup_common only
    ("src/v/security/audit/probes.cc", "security_audit", "buffer_usage_ratio"): ["internal"],
}

# Definitions built in one file and registered in another: file -> groups and endpoints.
MAKE_RULES = {
    # client_probe::defs() returns definitions that net/probes.cc client_probe::setup_metrics registers as "rpc_client"
    "src/v/rpc/transport.cc": {"groups": ["rpc_client"], "endpoints": ["internal"]},
}

_DISKSTATS_FIELDS = ["reads", "reads_merged", "sectors_read", "reads_ms", "writes",
                     "writes_merged", "sectors_written", "writes_ms", "io_in_progress",
                     "io_ms", "io_weighted_ms", "discards", "discards_merged",
                     "sectors_discarded", "discards_ms", "flushes", "flushes_ms"]
_DISKSTATS_BYTES = ["bytes_read", "bytes_written", "bytes_discarded"]

# Metric names built at runtime: (file, raw name expression) -> names and HELP template.
NAME_RULES = {
    # loop over diskstats_fields (host_metrics_watcher.cc), prefix "" or "underlying_"
    ("src/v/metrics/host_metrics_watcher.cc", "name"): {
        "names": [p + f for p in ("", "underlying_") for f in _DISKSTATS_FIELDS],
        "help_expr": 'fmt::format("Host diskstat {}", name)'},
    # bytes variants of the sectors_* fields, same prefixes
    ("src/v/metrics/host_metrics_watcher.cc", "bytes_name"): {
        "names": [p + f for p in ("", "underlying_") for f in _DISKSTATS_BYTES],
        "help_expr": 'fmt::format("Host diskstat {} (converted to bytes)", name)'},
}

# Seastar families copied to /public_metrics by application.cc
# (seastar::metrics::replicate_metric_families). The source is re-read and
# compared at run time; a warning goes to stderr if it differs.
SEASTAR_REPLICATED = [
    "io_queue_total_read_ops", "io_queue_total_write_ops", "memory_allocated_memory",
    "memory_free_memory", "io_queue_consumption", "io_queue_total_bytes",
    "io_queue_disk_queue_length", "network_bytes_received", "network_bytes_sent",
    "reactor_aio_reads", "reactor_aio_writes", "reactor_aio_bytes_read",
    "reactor_aio_bytes_write",
]

# Seastar built-in families on /metrics, from redpanda-data/seastar@852a933
# (pinned in bazel/repositories.bzl for v26.2.7). Format: (group, name, seastar
# make_ type, seastar file, condition). Condition notes: "smp>1" families exist
# only with more than one shard; "never" means Redpanda creates no Seastar
# execution stage, so they are not registered.
SEASTAR_BUILTINS = [
    ("scheduler", "runtime_ms", "counter", "src/core/reactor.cc", None),
    ("scheduler", "waittime_ms", "counter", "src/core/reactor.cc", None),
    ("scheduler", "starvetime_ms", "counter", "src/core/reactor.cc", None),
    ("scheduler", "tasks_processed", "counter", "src/core/reactor.cc", None),
    ("scheduler", "queue_length", "gauge", "src/core/reactor.cc", None),
    ("scheduler", "shares", "gauge", "src/core/reactor.cc", None),
    ("scheduler", "time_spent_on_task_quota_violations_ms", "counter", "src/core/reactor.cc", None),
    ("stall_detector", "reported", "counter", "src/core/reactor.cc", None),
    ("reactor", "io_threaded_fallbacks", "counter", "src/core/reactor.cc", None),
    ("reactor", "tasks_pending", "gauge", "src/core/reactor.cc", None),
    ("reactor", "tasks_processed", "counter", "src/core/reactor.cc", None),
    ("reactor", "polls", "counter", "src/core/reactor.cc", None),
    ("reactor", "timers_pending", "gauge", "src/core/reactor.cc", None),
    ("reactor", "utilization", "gauge", "src/core/reactor.cc", None),
    ("reactor", "cpu_busy_ms", "counter", "src/core/reactor.cc", None),
    ("reactor", "sleep_time_ms_total", "counter", "src/core/reactor.cc", None),
    ("reactor", "awake_time_ms_total", "counter", "src/core/reactor.cc", None),
    ("reactor", "cpu_used_time_ms", "counter", "src/core/reactor.cc", None),
    ("reactor", "cpu_steal_time_ms", "counter", "src/core/reactor.cc", None),
    ("reactor", "aio_reads", "counter", "src/core/reactor.cc", None),
    ("reactor", "aio_bytes_read", "total_bytes", "src/core/reactor.cc", None),
    ("reactor", "aio_writes", "counter", "src/core/reactor.cc", None),
    ("reactor", "aio_bytes_write", "total_bytes", "src/core/reactor.cc", None),
    ("reactor", "aio_outsizes", "counter", "src/core/reactor.cc", None),
    ("reactor", "aio_errors", "counter", "src/core/reactor.cc", None),
    ("reactor", "stalls", "histogram", "src/core/reactor.cc", None),
    ("reactor", "fsyncs", "counter", "src/core/reactor.cc", None),
    ("reactor", "aio_retries", "counter", "src/core/reactor.cc", None),
    ("reactor", "logging_failures", "counter", "src/core/reactor.cc", None),
    ("reactor", "cpp_exceptions", "counter", "src/core/reactor.cc", None),
    ("reactor", "internal_errors", "counter", "src/core/reactor.cc", None),
    ("reactor", "abandoned_failed_futures", "counter", "src/core/reactor.cc", None),
    ("reactor", "fstream_reads", "counter", "src/core/reactor.cc", None),
    ("reactor", "fstream_read_bytes", "counter", "src/core/reactor.cc", None),
    ("reactor", "fstream_reads_blocked", "counter", "src/core/reactor.cc", None),
    ("reactor", "fstream_read_bytes_blocked", "counter", "src/core/reactor.cc", None),
    ("reactor", "fstream_reads_aheads_discarded", "counter", "src/core/reactor.cc", None),
    ("reactor", "fstream_reads_ahead_bytes_discarded", "counter", "src/core/reactor.cc", None),
    ("memory", "malloc_operations", "counter", "src/core/reactor.cc", None),
    ("memory", "free_operations", "counter", "src/core/reactor.cc", None),
    ("memory", "cross_cpu_free_operations", "counter", "src/core/reactor.cc", None),
    ("memory", "malloc_live_objects", "gauge", "src/core/reactor.cc", None),
    ("memory", "free_memory", "current_bytes", "src/core/reactor.cc", None),
    ("memory", "total_memory", "current_bytes", "src/core/reactor.cc", None),
    ("memory", "allocated_memory", "current_bytes", "src/core/reactor.cc", None),
    ("memory", "reclaims_operations", "counter", "src/core/reactor.cc", None),
    ("memory", "malloc_failed", "counter", "src/core/reactor.cc", None),
    ("memory", "oversized_allocs", "counter", "src/core/reactor.cc", None),
    ("smp", "send_batch_queue_length", "queue_length", "src/core/reactor.cc", "smp>1"),
    ("smp", "receive_batch_queue_length", "queue_length", "src/core/reactor.cc", "smp>1"),
    ("smp", "complete_batch_queue_length", "queue_length", "src/core/reactor.cc", "smp>1"),
    ("smp", "send_queue_length", "queue_length", "src/core/reactor.cc", "smp>1"),
    ("smp", "total_received_messages", "counter", "src/core/reactor.cc", "smp>1"),
    ("smp", "total_sent_messages", "counter", "src/core/reactor.cc", "smp>1"),
    ("smp", "total_completed_messages", "counter", "src/core/reactor.cc", "smp>1"),
    ("io_queue", "flow_ratio", "gauge", "src/core/io_queue.cc", None),
    ("io_queue", "total_bytes", "counter", "src/core/io_queue.cc", None),
    ("io_queue", "total_operations", "counter", "src/core/io_queue.cc", None),
    ("io_queue", "total_read_bytes", "counter", "src/core/io_queue.cc", None),
    ("io_queue", "total_read_ops", "counter", "src/core/io_queue.cc", None),
    ("io_queue", "total_write_bytes", "counter", "src/core/io_queue.cc", None),
    ("io_queue", "total_write_ops", "counter", "src/core/io_queue.cc", None),
    ("io_queue", "total_split_ops", "counter", "src/core/io_queue.cc", None),
    ("io_queue", "total_split_bytes", "counter", "src/core/io_queue.cc", None),
    ("io_queue", "total_delay_sec", "counter", "src/core/io_queue.cc", None),
    ("io_queue", "total_exec_sec", "counter", "src/core/io_queue.cc", None),
    ("io_queue", "starvation_time_sec", "counter", "src/core/io_queue.cc", None),
    ("io_queue", "queue_length", "queue_length", "src/core/io_queue.cc", None),
    ("io_queue", "disk_queue_length", "queue_length", "src/core/io_queue.cc", None),
    ("io_queue", "delay", "gauge", "src/core/io_queue.cc", None),
    ("io_queue", "shares", "gauge", "src/core/io_queue.cc", None),
    ("io_queue", "integrated_queue_length", "counter", "src/core/io_queue.cc", None),
    ("io_queue", "integrated_disk_queue_length", "counter", "src/core/io_queue.cc", None),
    ("io_queue", "consumption", "counter", "src/core/io_queue.cc", None),
    ("io_queue", "adjusted_consumption", "counter", "src/core/io_queue.cc", None),
    ("io_queue", "activations", "counter", "src/core/io_queue.cc", None),
    ("alien", "receive_batch_queue_length", "queue_length", "src/core/alien.cc", None),
    ("alien", "total_received_messages", "counter", "src/core/alien.cc", None),
    ("alien", "total_sent_messages", "counter", "src/core/alien.cc", None),
    ("execution_stages", "tasks_scheduled", "counter", "src/core/execution_stage.cc", "never"),
    ("execution_stages", "tasks_preempted", "counter", "src/core/execution_stage.cc", "never"),
    ("execution_stages", "function_calls_enqueued", "counter", "src/core/execution_stage.cc", "never"),
    ("execution_stages", "function_calls_executed", "counter", "src/core/execution_stage.cc", "never"),
    ("httpd", "connections_total", "counter", "src/http/httpd.cc", None),
    ("httpd", "connections_current", "gauge", "src/http/httpd.cc", None),
    ("httpd", "read_errors", "counter", "src/http/httpd.cc", None),
    ("httpd", "reply_errors", "counter", "src/http/httpd.cc", None),
    ("httpd", "requests_served", "counter", "src/http/httpd.cc", None),
    ("network", "bytes_sent", "counter", "src/net/stack.cc", None),
    ("network", "bytes_received", "counter", "src/net/stack.cc", None),
]

# make_* helper -> Prometheus TYPE as exposed by Seastar
TYPE_MAP = {"counter": "counter", "gauge": "gauge", "histogram": "histogram",
            "total_bytes": "counter", "total_operations": "counter",
            "current_bytes": "gauge", "queue_length": "gauge", "derive": "counter",
            "absolute": "counter", "summary": "summary"}

PREFIX = {"internal": "vectorized", "public": "redpanda"}

# =============================================================================
# git access
# =============================================================================


class Repo:
    def __init__(self, path, ref):
        self.path = path
        self.ref = ref
        self._cache = {}

    def _git(self, *args):
        r = subprocess.run(["git", "-C", self.path] + list(args),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True)
        return r.returncode, r.stdout

    def show(self, path):
        if path not in self._cache:
            rc, out = self._git("show", "%s:%s" % (self.ref, path))
            self._cache[path] = out if rc == 0 else None
        return self._cache[path]

    def grep_files(self, pattern, pathspec="src/v"):
        rc, out = self._git("grep", "-l", "-E", pattern, self.ref, "--", pathspec)
        files = []
        for line in out.splitlines():
            if line.startswith(self.ref + ":"):
                line = line[len(self.ref) + 1:]
            files.append(line)
        return files


# =============================================================================
# lexical helpers
# =============================================================================


def strip_comments(src):
    """Blank out C++ comments, keeping offsets and string literals intact."""
    out = list(src)
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if src.startswith("//", i):
            j = src.find("\n", i)
            j = n if j < 0 else j
            for k in range(i, j):
                out[k] = " "
            i = j
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            for k in range(i, j):
                if out[k] != "\n":
                    out[k] = " "
            i = j
        elif c == '"':
            if i > 0 and src[i - 1] == "R":
                j = src.find(')"', i)
                i = n if j < 0 else j + 2
                continue
            j = i + 1
            while j < n and src[j] != '"':
                if src[j] == "\\":
                    j += 1
                j += 1
            i = j + 1
        elif c == "'" and i > 0 and not src[i - 1].isalnum():
            j = i + 1
            while j < n and src[j] != "'":
                if src[j] == "\\":
                    j += 1
                j += 1
            i = j + 1
        else:
            i += 1
    return "".join(out)


def match_bracket(s, i):
    """s[i] is an opening bracket; return index of its matching close."""
    d, n, j = 0, len(s), i
    while j < n:
        c = s[j]
        if c == '"':
            j += 1
            while j < n and s[j] != '"':
                if s[j] == "\\":
                    j += 1
                j += 1
        elif c in "([{":
            d += 1
        elif c in ")]}":
            d -= 1
            if d == 0:
                return j
        j += 1
    return n


def split_args(s):
    args, d, cur, j, n = [], 0, [], 0, len(s)
    while j < n:
        c = s[j]
        if c == '"':
            k = j + 1
            while k < n and s[k] != '"':
                if s[k] == "\\":
                    k += 1
                k += 1
            cur.append(s[j:k + 1])
            j = k + 1
            continue
        if c in "([{":
            d += 1
        elif c in ")]}":
            d -= 1
        if c == "," and d == 0:
            args.append("".join(cur).strip())
            cur = []
        else:
            cur.append(c)
        j += 1
    if "".join(cur).strip():
        args.append("".join(cur).strip())
    return args


def norm(s):
    return " ".join(s.split())


def sanitize(name):
    return re.sub(r"[^A-Za-z0-9]", "_", name)


_LIT = re.compile(r'^(?:(?:ss|seastar)::sstring|std::string|std::string_view)?\s*[({]?\s*'
                  r'((?:"(?:[^"\\]|\\.)*"\s*)+)[)}]?$', re.S)


def literal(expr):
    m = _LIT.match(expr.strip())
    if not m:
        return None
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1))
    return "".join(p.encode().decode("unicode_escape") if "\\" in p else p for p in parts)


_SAN = re.compile(r"^prometheus_sanitize::metrics_name\(\s*(.*)\s*\)$", re.S)
_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$")


def rhs_at(s, m):
    """Given a match ending at '=', '{' or '(', return the right-hand side text."""
    op = s[m.end() - 1]
    if op == "=":
        j, d = m.end(), 0
        while j < len(s):
            c = s[j]
            if c == '"':
                j += 1
                while j < len(s) and s[j] != '"':
                    if s[j] == "\\":
                        j += 1
                    j += 1
            elif c in "([{":
                d += 1
            elif c in ")]}":
                if d == 0:
                    break
                d -= 1
            elif c in ";," and d == 0:
                break
            j += 1
        return s[m.end():j].strip()
    close = match_bracket(s, m.end() - 1)
    return s[m.end():close].strip()


def find_assignments(text, name):
    return list(re.finditer(r"(?<![\w.>])" + re.escape(name) + r"\s*(=(?!=)|\{|\()", text))


class Resolver:
    """Resolves string-valued expressions in one translation unit."""

    def __init__(self, s, ctx):
        self.s = s          # comment-stripped file text
        self.ctx = ctx      # comment-stripped sibling/included files

    def values(self, expr, pos, depth=0):
        """Return (list_of_values or None, heuristic_flag, rhs_text)."""
        expr = expr.strip()
        if depth > 6:
            return None, False, ""
        m = _SAN.match(expr)
        if m:
            vals, h, rhs = self.values(m.group(1), pos, depth + 1)
            return ([sanitize(v) for v in vals] if vals else None), h, rhs
        v = literal(expr)
        if v is not None:
            return [v], False, ""
        if not _IDENT.match(expr):
            return None, False, ""
        name = expr.split("::")[-1]
        qualified = "::" in expr
        # template traits: a qualified name with several literal definitions -> expand all
        if qualified:
            defs = []
            for text in [self.s] + self.ctx:
                for am in find_assignments(text, name):
                    r = rhs_at(text, am)
                    lv = literal(r)
                    if lv is not None and lv not in defs:
                        defs.append(lv)
            if len(defs) > 1:
                return defs, True, ""
            if len(defs) == 1:
                return defs, False, ""
        # nearest preceding assignment in this file, then anywhere in this file, then context files
        cands = [am for am in find_assignments(self.s, name) if am.start() < pos]
        text = self.s
        heuristic = False
        if not cands:
            cands = find_assignments(self.s, name)
            heuristic = bool(cands)
        if not cands:
            for t in self.ctx:
                cands = find_assignments(t, name)
                if cands:
                    text = t
                    heuristic = True
                    break
        for am in reversed(cands if text is self.s else cands[:1]):
            rhs = rhs_at(text, am)
            vals, h, _ = self.values(rhs, am.start(), depth + 1)
            if vals:
                return vals, heuristic or h, rhs
            return None, False, rhs
        return None, False, ""


# =============================================================================
# extraction
# =============================================================================

MAKE_RE = re.compile(
    r"(?<![A-Za-z0-9_])((?:(?:sm|ss::metrics|seastar::metrics)::)?)"
    r"make_(gauge|counter|histogram|total_bytes|current_bytes|total_operations|"
    r"queue_length|derive|absolute|summary)\s*(?:<[^>(]*>)?\s*\(")
ADD_GROUP_RE = re.compile(r"([A-Za-z0-9_.\->\[\]()]*?)\s*(?:\.|->)\s*add_group\s*\(")
LAMBDA_RE = re.compile(r"(?:\bauto\b\s*&{0,2}|\bconst\s+auto\b\s*&{0,2})\s*([A-Za-z_]\w*)\s*=\s*\[")
DESC_RE = re.compile(r"^(?:(?:sm|ss::metrics|seastar::metrics)::)?description\s*\((.*)\)$", re.S)
GROUP_TYPES = {"public_metric_groups": "public", "public_metrics_group_service": "public",
               "internal_metric_groups": "internal", "metric_groups": "internal",
               "all_metrics_groups": "both", "metric_groups_base": "base"}
DECL_RE = (r"(public_metric_groups|internal_metric_groups|all_metrics_groups|metric_groups_base|"
           r"public_metrics_group_service|(?<![\w_])metric_groups)\s*>?\s*[&*]?\s*")
INCLUDE_RE = re.compile(r'^\s*#\s*include\s+"([^"]+\.h)"', re.M)


def lambda_spans(s):
    spans = []
    for m in LAMBDA_RE.finditer(s):
        j = m.end() - 1
        j = match_bracket(s, j) + 1
        while j < len(s) and s[j].isspace():
            j += 1
        if j < len(s) and s[j] == "<":
            j = s.find(">", j) + 1
            while j < len(s) and s[j].isspace():
                j += 1
        if j < len(s) and s[j] == "(":
            j = match_bracket(s, j) + 1
        k = s.find("{", j)
        if k < 0:
            continue
        between = s[j:k]
        if ";" in between:
            continue
        spans.append((m.group(1), k, match_bracket(s, k)))
    return spans


def function_end(s, pos):
    e = s.find("\n}", pos)
    return len(s) if e < 0 else e


def container_of(s, start):
    """Name of the vector a make_* call is appended to or initialises, if any."""
    back = s[max(0, start - 300):start]
    m = re.search(r"([A-Za-z_]\w*)\s*(?:\.|->)\s*(?:emplace_back|push_back)\s*\(\s*$", back)
    if m:
        return m.group(1)
    d, j = 0, start - 1
    while j >= 0:
        c = s[j]
        if c in ")]}":
            d += 1
        elif c in "([{":
            if d == 0:
                if c == "{":
                    m = re.search(r"([A-Za-z_]\w*)\s*(?:=\s*)?$", s[max(0, j - 200):j])
                    if m and m.group(1) not in ("return", "else", "do"):
                        return m.group(1)
                return None
            d -= 1
        j -= 1
    return None


def propagate(text, names):
    names = set(names)
    for stmt in text.split(";"):
        if not any(re.search(r"\b" + re.escape(n) + r"\b", stmt) for n in names):
            continue
        for pat in (r"\bauto\s*&{0,2}\s*([A-Za-z_]\w*)\s*=",
                    r"^\s*([A-Za-z_]\w*)\s*=(?!=)",
                    r"back_inserter\(\s*([A-Za-z_]\w*)\s*\)",
                    r"([A-Za-z_]\w*)\s*(?:\.|->)\s*(?:emplace_back|push_back|insert)\s*\("):
            for m in re.finditer(pat, stmt, re.M):
                names.add(m.group(1))
    return names


class FileScan:
    def __init__(self, repo, path):
        self.path = path
        raw = repo.show(path) or ""
        self.raw = raw
        self.s = raw if path.endswith(".py") else strip_comments(raw)
        base = os.path.splitext(path)[0]
        ctx_paths = [base + ext for ext in (".h", ".cc") if base + ext != path]
        for inc in INCLUDE_RE.findall(raw):
            p = "src/v/" + inc
            if p not in ctx_paths and p != path:
                ctx_paths.append(p)
        self.ctx = []
        for p in ctx_paths:
            t = repo.show(p)
            if t:
                self.ctx.append(strip_comments(t))
        self.res = Resolver(self.s, self.ctx)
        self.groups = []
        for m in ADD_GROUP_RE.finditer(self.s):
            op = self.s.index("(", m.end() - 1)
            cl = match_bracket(self.s, op)
            self.groups.append({"start": m.start(), "op": op, "cl": cl, "recv": m.group(1),
                                "args": split_args(self.s[op + 1:cl])})
        self.lambdas = lambda_spans(self.s)
        self.local_makers = set(n for n, _, _ in self.lambdas if n.startswith("make_"))

    def line(self, pos):
        return self.raw.count("\n", 0, pos) + 1

    def endpoint(self, g):
        recv = g["recv"] or ""
        rn = re.split(r"\.|->", recv.replace(".emplace()", "").replace("->emplace()", ""))[-1] or recv
        key = (self.path, rn)
        if key in ENDPOINT_RULES:
            return ENDPOINT_RULES[key], "rule"
        low = recv.lower()
        if rn == "groups" and "public" in low:
            return ["public"], "clean"
        if "public" in low:
            return ["public"], "clean"
        if "internal" in low:
            return ["internal"], "clean"
        alias = [m for m in re.finditer(r"\bauto\s*&\s*" + re.escape(rn) + r"\s*=\s*([\w.>\-]+?)\s*(?:\.|->)\s*emplace\(\)",
                                         self.s) if m.start() < g["start"]]
        if alias:
            rn = re.split(r"\.|->", alias[-1].group(1))[-1]
        decl = [m for m in re.finditer(DECL_RE + re.escape(rn) + r"\b", self.s) if m.start() < g["start"]]
        kind = None
        if decl:
            kind = GROUP_TYPES[decl[-1].group(1)]
        else:
            for t in [self.s] + self.ctx:
                m = re.search(DECL_RE + re.escape(rn) + r"\b", t)
                if m:
                    kind = GROUP_TYPES[m.group(1)]
                    break
        if kind == "both":
            return ["internal", "public"], "clean"
        if kind in ("internal", "public"):
            return [kind], "clean"
        if kind == "base":
            return ["internal", "public"], "heuristic"
        return ["internal"], "heuristic"

    def group_names(self, g):
        if not g["args"]:
            return None, "unresolved"
        arg = g["args"][0]
        vals, heur, rhs = self.res.values(arg, g["op"])
        probe = norm(arg)
        inner = _SAN.match(arg.strip())
        if not rhs and inner and _IDENT.match(inner.group(1).strip()):
            _, _, rhs = self.res.values(inner.group(1).strip(), g["op"])
        probe_full = probe + " := " + norm(rhs)
        for f, rx, groups in GROUP_RULES:
            if f == self.path and (re.search(rx, probe) or re.search(rx, probe_full)):
                return list(groups), "rule"
        if vals:
            return [sanitize(v) for v in vals], ("heuristic" if heur else "clean")
        return None, "unresolved"


def describe(scan, args, pos):
    """Return (help, help_runtime, help_expr)."""
    for a in args[1:]:
        m = DESC_RE.match(a.strip())
        if m:
            lit = literal(m.group(1))
            if lit is not None:
                return lit, False, None
            return None, True, norm(m.group(1))
    for a in args[1:]:
        a = a.strip()
        if re.match(r"^[A-Za-z_]\w*$", a):
            for t in [scan.s] + scan.ctx:
                dm = [x for x in re.finditer(
                    r"(?:(?:sm|ss::metrics|seastar::metrics)::)?description\s+" + re.escape(a) + r"\s*[({]", t)]
                if dm:
                    body = t[dm[-1].end() - 1:match_bracket(t, dm[-1].end() - 1) + 1]
                    lit = literal(body[1:-1])
                    if lit is not None:
                        return lit, False, None
                    return None, True, norm(body[1:-1])
                am = re.search(r"\bauto\s+" + re.escape(a) + r"\s*=\s*(?:(?:sm|ss::metrics|seastar::metrics)::)?description\s*\(", t)
                if am:
                    op = am.end() - 1
                    lit = literal(t[op + 1:match_bracket(t, op)])
                    if lit is not None:
                        return lit, False, None
                    return None, True, norm(t[op + 1:match_bracket(t, op)])
    return None, False, None


def extract(repo):
    files = repo.grep_files(r"make_(gauge|counter|histogram|total_bytes|current_bytes|total_operations)[ (<]")
    files = [f for f in files if not re.search(r"(/tests?/|_test\.cc$|/bench)", f)]
    sites, unresolved = [], []
    for path in files:
        scan = FileScan(repo, path)
        s = scan.s
        for m in MAKE_RE.finditer(s):
            qual, kind = m.group(1), m.group(2)
            fn = "make_" + kind
            if not qual and fn in scan.local_makers:
                continue  # call of a local lambda named make_*, not a registration
            op = m.end() - 1
            cl = match_bracket(s, op)
            args = split_args(s[op + 1:cl])
            line = scan.line(m.start())
            site = {"file": path, "line": line, "kind": kind}
            levels = set()
            # ---- metric name(s)
            raw_name = norm(args[0]) if args else ""
            help_text, help_rt, help_expr = describe(scan, args, m.start())
            nrule = NAME_RULES.get((path, raw_name))
            if nrule:
                names = list(nrule["names"])
                help_rt, help_text, help_expr = True, None, nrule["help_expr"]
                levels.add("rule")
            else:
                vals, heur, _ = scan.res.values(args[0], m.start()) if args else (None, False, "")
                names = vals
                if heur:
                    levels.add("heuristic")
            if not names:
                unresolved.append(dict(site, reason="metric name not resolvable", expr=raw_name))
                continue
            # ---- groups and endpoints
            targets = []  # (group, endpoints)
            enclosing = [g for g in scan.groups if g["op"] < m.start() < g["cl"]]
            if path in MAKE_RULES:
                r = MAKE_RULES[path]
                targets = [(gname, list(r["endpoints"])) for gname in r["groups"]]
                levels.add("rule")
            else:
                if enclosing:
                    chosen = [enclosing[-1]]
                else:
                    lam = [sp for sp in scan.lambdas if sp[1] < m.start() < sp[2]]
                    if lam:
                        inner = min(lam, key=lambda sp: sp[2] - sp[1])
                        seeds, start = {inner[0]}, inner[2]
                    else:
                        c = container_of(s, m.start())
                        seeds, start = ({c} if c else set()), cl
                    end = function_end(s, start)
                    chosen = []
                    if seeds:
                        names_set = propagate(s[start:end], seeds)
                        chosen = [g for g in scan.groups if start < g["op"] < end and any(
                            re.search(r"\b" + re.escape(n) + r"\b", s[g["op"]:g["cl"]]) for n in names_set)]
                    if not chosen:
                        chosen = [g for g in scan.groups if cl < g["op"] < end and not MAKE_RE.search(s[g["op"]:g["cl"]])]
                    levels.add("heuristic")
                for g in chosen:
                    gnames, glevel = scan.group_names(g)
                    if not gnames:
                        unresolved.append(dict(site, reason="group not resolvable",
                                               expr=norm(g["args"][0]) if g["args"] else ""))
                        continue
                    eps, elevel = scan.endpoint(g)
                    levels.add(glevel)
                    levels.add(elevel)
                    for gn in gnames:
                        targets.append((gn, eps))
            if not targets:
                unresolved.append(dict(site, reason="no add_group found for this definition", expr=raw_name))
                continue
            for gn, eps in targets:
                for nm in names:
                    pin = FAMILY_ENDPOINT_RULES.get((path, gn, nm))
                    lv = set(levels)
                    use = eps
                    if pin:
                        use = pin
                        lv.add("rule")
                    for ep in use:
                        sites.append({"endpoint": ep, "group": gn, "name": nm, "kind": kind,
                                      "file": path, "line": line, "help": help_text,
                                      "help_runtime": help_rt, "help_expr": help_expr, "levels": lv})
    return sites, unresolved


def check_replicated(repo):
    src = repo.show("src/v/redpanda/application.cc") or ""
    m = re.search(r"replicate_metric_families\s*\(", src)
    if not m:
        return
    block = src[m.end():match_bracket(src, m.end() - 1)]
    found = re.findall(r'\{\s*"([a-z0-9_]+)"\s*,\s*metrics::public_metrics_handle\s*\}', block)
    if sorted(found) != sorted(SEASTAR_REPLICATED):
        sys.stderr.write("warning: application.cc replicate_metric_families list differs from "
                         "SEASTAR_REPLICATED: %s\n" % sorted(set(found) ^ set(SEASTAR_REPLICATED)))


def load_seastar(path):
    if not path:
        return [dict(group=g, name=n, type=t, file=f, condition=c) for g, n, t, f, c in SEASTAR_BUILTINS]
    with open(path) as fh:
        data = json.load(fh)
    out = []
    if isinstance(data, dict) and "families" in data:
        data = data["families"]
    if isinstance(data, dict):
        for full, t in data.items():
            out.append(dict(group=None, name=full, type=t, file=None, condition=None))
    else:
        for e in data:
            out.append(dict(group=e.get("group"), name=e["name"], type=e.get("type", "gauge"),
                            file=e.get("file"), condition=e.get("condition")))
    return out


def build(sites, seastar):
    out = {"public": {}, "internal": {}}
    for st in sites:
        full = "%s_%s_%s" % (PREFIX[st["endpoint"]], st["group"], st["name"])
        e = out[st["endpoint"]].get(full)
        if e is None:
            e = {"type": TYPE_MAP[st["kind"]], "help": st["help"], "help_runtime": st["help_runtime"],
                 "defined_in": st["file"], "line": st["line"], "group": st["group"],
                 "resolution": "clean", "call_sites": 0, "origin": "src/v", "_levels": set()}
            if st["help_expr"]:
                e["help_expr"] = st["help_expr"]
            out[st["endpoint"]][full] = e
        e["call_sites"] += 1
        e["_levels"] |= st["levels"]
        if TYPE_MAP[st["kind"]] != e["type"]:
            e["type_conflict"] = sorted(set([e["type"], TYPE_MAP[st["kind"]]]))
    for ep in out.values():
        for e in ep.values():
            lv = e.pop("_levels")
            e["resolution"] = "rule" if "rule" in lv else ("heuristic" if lv & {"heuristic", "unresolved"} else "clean")
    by_short = {}
    for f in seastar:
        name = f["name"]
        full = name if name.startswith("vectorized_") else "vectorized_%s_%s" % (f["group"], name) if f["group"] else "vectorized_" + name
        entry = {"type": TYPE_MAP.get(f["type"], f["type"]), "help": None, "help_runtime": False,
                 "defined_in": "seastar:%s" % f["file"] if f["file"] else "seastar",
                 "group": f["group"], "resolution": "rule", "call_sites": 1, "origin": "seastar"}
        if f.get("condition"):
            entry["condition"] = f["condition"]
        out["internal"].setdefault(full, entry)
        by_short[full[len("vectorized_"):]] = entry
    for short in SEASTAR_REPLICATED:
        base = by_short.get(short)
        entry = {"type": base["type"] if base else "gauge", "help": None, "help_runtime": False,
                 "defined_in": "src/v/redpanda/application.cc", "group": base["group"] if base else None,
                 "resolution": "rule", "call_sites": 1, "origin": "seastar-replicated"}
        out["public"].setdefault("redpanda_" + short, entry)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", required=True, help="path to a streaming-enterprise clone")
    ap.add_argument("--ref", required=True, help="git ref (tag) to read")
    ap.add_argument("--seastar-json", help="optional JSON list/dict of Seastar built-in families")
    a = ap.parse_args(argv)
    repo = Repo(a.repo, a.ref)
    if repo.show("src/v/metrics/metrics.h") is None:
        sys.exit("error: %s:src/v/metrics/metrics.h not found in %s" % (a.ref, a.repo))
    check_replicated(repo)
    sites, unresolved = extract(repo)
    out = build(sites, load_seastar(a.seastar_json))
    doc = {"ref": a.ref,
           "public": dict(sorted(out["public"].items())),
           "internal": dict(sorted(out["internal"].items())),
           "unresolved": unresolved}
    json.dump(doc, sys.stdout, indent=1, sort_keys=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
