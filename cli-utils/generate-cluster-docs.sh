#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Usage: generate-cluster-docs.sh [MODE] [TAG] [DOCKER_REPO] [CONSOLE_TAG] [CONSOLE_REPO] [generator args...]
#
# Starts the Docker Compose cluster for TAG, waits for it to become healthy,
# lets the metrics settle, runs the generator, and tears the cluster down.
# Anything after the fifth positional argument is passed through to the
# generator (for metrics mode: tools/metrics/metrics.py, for example
# --output-dir and --skip-pages).
#
# Timing knobs, all in seconds and all overridable from the environment so a
# CI job can tune them without an interactive prompt:
#   CLUSTER_READY_TIMEOUT  how long to wait for every broker to report healthy (default 300)
#   METRICS_SETTLE_MIN     never stop settling before this (default 120: the consumer-group lag and
#                          Tiered Storage upload intervals in bootstrap.yml are 60 s, so each must fire once)
#   METRICS_SETTLE_MAX     stop settling at this point regardless (default 300, the old fixed sleep)
#   METRICS_SETTLE_STABLE  how long the metric-family count must stay unchanged to count as settled (default 60)
#   METRICS_POLL_INTERVAL  seconds between polls (default 15)
#   KEEP_CLUSTER=1         leave the cluster running after the generator finishes (or fails)
#
# In metrics mode the cluster also gets the properties in
# docker-compose/metrics/bootstrap-extra.yml and a few actions once it is
# healthy (see run_metrics_actions), because Redpanda exports a metric family
# only when the feature behind it is on. This applies to Redpanda 25.3 and
# later, and to dev, latest and branch runs. Earlier releases refuse to start
# on a property they do not know, so they get the quickstart unchanged.

###############################################################################
# Pre-flight: Ensure Docker is available and running
###############################################################################
if ! command -v docker &> /dev/null; then
  echo "❌ Docker is not installed or not in PATH. Please install Docker to continue."
  exit 1
fi

if ! docker info &> /dev/null; then
  echo "❌ Docker daemon is not running. Please start Docker to continue."
  exit 1
fi

###############################################################################
# Load overrides from an optional .env file in the current directory
###############################################################################
if [[ -f .env ]]; then
  # shellcheck disable=SC2046
  export $(grep -Ev '^#' .env | xargs)
fi

###############################################################################
# Environment setup
###############################################################################
ORIGINAL_PWD="$(pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="${PROJECT_NAME:-redpanda_quickstart}"

MODE="${1:-metrics}"
TAG="${2:-latest}"
DOCKER_REPO="${3:-redpanda}"
CONSOLE_TAG="${4:-latest}"
CONSOLE_REPO="${5:-console}"
# Everything after the five positionals goes to the generator untouched.
shift "$(( $# < 5 ? $# : 5 ))"
GENERATOR_ARGS=("$@")

ADMIN_URL="${ADMIN_URL:-http://localhost:19644}"
ADMIN_USER="${ADMIN_USER:-superuser}"
ADMIN_PASS="${ADMIN_PASS:-secretpassword}"
CLUSTER_READY_TIMEOUT="${CLUSTER_READY_TIMEOUT:-300}"
METRICS_SETTLE_MIN="${METRICS_SETTLE_MIN:-120}"
METRICS_SETTLE_MAX="${METRICS_SETTLE_MAX:-300}"
METRICS_SETTLE_STABLE="${METRICS_SETTLE_STABLE:-60}"
METRICS_POLL_INTERVAL="${METRICS_POLL_INTERVAL:-15}"
# A settle cap below the floor would always end with the "still changing" warning.
if (( METRICS_SETTLE_MIN > METRICS_SETTLE_MAX )); then
  METRICS_SETTLE_MIN="$METRICS_SETTLE_MAX"
fi

# Adjust Docker repo for release candidates
shopt -s nocasematch
if [[ "$TAG" =~ rc[0-9]+ ]]; then
  DOCKER_REPO="redpanda-unstable"
fi
shopt -u nocasematch

MAJOR_MINOR="latest"
if [[ "$TAG" != "latest" ]]; then
  MAJOR_MINOR="$(echo "$TAG" | sed -E 's/^v?([0-9]+\.[0-9]+).*$/\1/')"
fi

export REDPANDA_VERSION="$TAG"
export REDPANDA_DOCKER_REPO="$DOCKER_REPO"
export REDPANDA_CONSOLE_VERSION="$CONSOLE_TAG"
export REDPANDA_CONSOLE_DOCKER_REPO="$CONSOLE_REPO"
# The compose files read CONSOLE_DOCKER_REPO.
export CONSOLE_DOCKER_REPO="$CONSOLE_REPO"

###############################################################################
# Python virtual environment (needed by the generator and by the health poll)
###############################################################################
"$SCRIPT_DIR/python-venv.sh" \
  "$SCRIPT_DIR/venv" \
  "$SCRIPT_DIR/../tools/metrics/requirements.txt"
PYTHON="$SCRIPT_DIR/venv/bin/python"

###############################################################################
# Always tear the cluster down, including on failure, so a broken run does
# not leave brokers holding the ports for the next one.
###############################################################################
# dev, latest and branch names are newer than any release, so they use the
# newest bundle. Only a release older than 25.1 uses the original one.
COMPOSE_DIR="$SCRIPT_DIR/../docker-compose/25.1"
if [[ "$MAJOR_MINOR" =~ ^([0-9]+)\.([0-9]+)$ ]]; then
  if (( BASH_REMATCH[1] < 25 )) || (( BASH_REMATCH[1] == 25 && BASH_REMATCH[2] < 1 )); then
    COMPOSE_DIR="$SCRIPT_DIR/../docker-compose"
  fi
fi

###############################################################################
# Metrics mode: turn on the features that register extra metric families.
# COMPOSE_FILE makes every docker compose call in this script and in
# start-cluster.sh see the same merged project, teardown included.
###############################################################################
METRICS_EXTRAS=0
METRICS_BOOTSTRAP_FILE=""
if [[ "$MODE" == "metrics" && "$COMPOSE_DIR" == */25.1 ]]; then
  METRICS_EXTRAS=1
  if [[ "$MAJOR_MINOR" =~ ^([0-9]+)\.([0-9]+)$ ]] && (( BASH_REMATCH[1] == 25 && BASH_REMATCH[2] < 3 )); then
    METRICS_EXTRAS=0
    echo "ℹ️  Redpanda $MAJOR_MINOR does not start with properties it does not know; scraping the quickstart as is."
  fi
fi

teardown() {
  local rc=$?
  if [[ "${KEEP_CLUSTER:-0}" == "1" ]]; then
    echo "ℹ️  KEEP_CLUSTER=1: leaving the cluster running (project $PROJECT_NAME)."
  elif [[ -d "$COMPOSE_DIR" ]]; then
    if (( rc != 0 )); then
      echo "---- docker compose ps (run failed with exit code $rc) ----"
      (cd "$COMPOSE_DIR" && docker compose -p "$PROJECT_NAME" ps -a) || true
      echo "---- last broker log lines ----"
      docker logs --tail 40 redpanda-0 2>&1 || true
    fi
    echo "🧹 Tearing down the cluster…"
    (cd "$COMPOSE_DIR" && docker compose -p "$PROJECT_NAME" down --volumes) || true
  fi
  # A cluster that is left running still mounts the file.
  if [[ -n "$METRICS_BOOTSTRAP_FILE" && "${KEEP_CLUSTER:-0}" != "1" ]]; then
    rm -f "$METRICS_BOOTSTRAP_FILE"
  fi
  cd "$ORIGINAL_PWD" || true
  exit "$rc"
}
trap teardown EXIT

if (( METRICS_EXTRAS )); then
  METRICS_DIR="$(cd "$SCRIPT_DIR/../docker-compose/metrics" && pwd)"
  METRICS_BOOTSTRAP_FILE="$(mktemp "${TMPDIR:-/tmp}/metrics-bootstrap.XXXXXX")"
  cat "$COMPOSE_DIR/bootstrap.yml" "$METRICS_DIR/bootstrap-extra.yml" > "$METRICS_BOOTSTRAP_FILE"
  # mktemp creates the file 0600; the broker runs as another user in the container.
  chmod 644 "$METRICS_BOOTSTRAP_FILE"
  export METRICS_BOOTSTRAP_FILE
  export COMPOSE_FILE="docker-compose.yml:$METRICS_DIR/metrics.overlay.yml"
fi

###############################################################################
# Start Redpanda cluster
###############################################################################
"$SCRIPT_DIR/start-cluster.sh" "$TAG"

###############################################################################
# Wait until every broker is in the cluster and the cluster reports healthy.
# A fixed sleep cannot tell "not up yet" from "never coming up": this fails
# with a visible error at CLUSTER_READY_TIMEOUT instead.
###############################################################################
BROKER_SERVICES="$(cd "$COMPOSE_DIR" && docker compose -p "$PROJECT_NAME" config --services | grep '^redpanda-' || true)"
EXPECTED_BROKERS="$(printf '%s\n' "$BROKER_SERVICES" | grep -c . || true)"
if (( EXPECTED_BROKERS == 0 )); then
  EXPECTED_BROKERS=1
fi

# One Admin API URL per broker. Partition-, consumer-group- and
# transform-scoped metrics are exported only by the broker hosting them, and
# that placement changes from one start to the next, so the generator scrapes
# every broker and merges. ADMIN_URL (broker 0) is still what the health poll
# uses, since health_overview is cluster-wide.
ADMIN_URLS=()
for svc in $BROKER_SERVICES; do
  mapped="$(cd "$COMPOSE_DIR" && docker compose -p "$PROJECT_NAME" port "$svc" 9644 2>/dev/null || true)"
  if [[ "$mapped" =~ :([0-9]+)$ ]]; then
    ADMIN_URLS+=("http://localhost:${BASH_REMATCH[1]}")
  fi
done
# A missing broker would make the merged metric set depend on partition
# placement again, so fail instead of scraping a subset.
if [[ -z "$BROKER_SERVICES" ]]; then
  echo "⚠️  No redpanda-* services found in the compose project; scraping $ADMIN_URL only."
  ADMIN_URLS=("$ADMIN_URL")
elif (( ${#ADMIN_URLS[@]} < EXPECTED_BROKERS )); then
  echo "❌ Found the Admin API port for ${#ADMIN_URLS[@]} of $EXPECTED_BROKERS brokers. Refusing to scrape a subset."
  exit 1
fi
# Joined explicitly: IFS is newline-tab here, so "${ADMIN_URLS[*]}" would print one URL per line.
echo "Admin API endpoints to scrape:$(printf " %s" "${ADMIN_URLS[@]}")"

HEALTH_PARSER='
import json, sys
expected = int(sys.argv[1])
try:
    h = json.loads(sys.argv[2])
except Exception:
    print("unparseable health response"); sys.exit(0)
nodes = h.get("all_nodes") or []
down = h.get("nodes_down") or []
if len(nodes) < expected:
    print(f"{len(nodes)}/{expected} brokers joined")
elif down:
    print(f"brokers down: {down}")
elif not h.get("is_healthy"):
    print("cluster not healthy yet: " + ", ".join(str(r) for r in (h.get("unhealthy_reasons") or ["unknown"])))
else:
    print("ready")
'

health_status() {
  # Prints "ready" or a one-line reason. Never fails the script by itself.
  local body
  if ! body="$(curl -sS --max-time 10 -u "$ADMIN_USER:$ADMIN_PASS" "$ADMIN_URL/v1/cluster/health_overview" 2>/dev/null)"; then
    echo "admin API not answering"
    return 0
  fi
  "$PYTHON" -c "$HEALTH_PARSER" "$EXPECTED_BROKERS" "$body" 2>/dev/null || echo "unparseable health response"
}

# Elapsed time is wall clock (bash's SECONDS), not a count of sleeps: a
# scrape of /metrics on a busy broker takes seconds by itself, so counting
# sleeps would make every timeout quietly longer than configured.
echo "⏳ Waiting up to ${CLUSTER_READY_TIMEOUT}s for ${EXPECTED_BROKERS} broker(s) to report healthy…"
SECONDS=0
while true; do
  status="$(health_status)"
  if [[ "$status" == "ready" ]]; then
    echo "✅ Cluster healthy after ${SECONDS}s"
    break
  fi
  if (( SECONDS >= CLUSTER_READY_TIMEOUT )); then
    echo "❌ Cluster did not become healthy within ${CLUSTER_READY_TIMEOUT}s (last status: ${status})." >&2
    exit 1
  fi
  echo "   ${SECONDS}s: ${status}"
  sleep "$METRICS_POLL_INTERVAL"
done

###############################################################################
# Metrics mode: let the metric set settle. Feature metrics appear only once
# the feature has run (first Tiered Storage upload, first consumer-group lag
# collection, first transform invocation), so poll the number of metric
# families and stop once it has been stable for METRICS_SETTLE_STABLE seconds
# and at least METRICS_SETTLE_MIN seconds have passed.
###############################################################################
count_families() {
  # Distinct metric families across every broker and both endpoints.
  local url ep
  for url in "${ADMIN_URLS[@]}"; do
    for ep in public_metrics metrics; do
      curl -sS --max-time 30 "$url/$ep/" 2>/dev/null | awk "/^# HELP/ { print \"$ep \" \$3 }" || true
    done
  done | sort -u | grep -c . || true
}

###############################################################################
# Metrics that need an action, not only a property. Each step is best effort:
# a failure costs a few metric families and must not fail the run by itself.
###############################################################################
run_metrics_actions() {
  local rpk_auth=(-X "user=$ADMIN_USER" -X "pass=$ADMIN_PASS")
  local probe_client="metrics-quota-probe"
  local url moved=0
  echo "▶️  Turning on action-driven metrics…"

  # Cloud topics reconciler metrics are per partition of a cloud-mode topic.
  if docker exec redpanda-0 rpk topic create metrics-cloud-topic -c redpanda.storage.mode=cloud "${rpk_auth[@]}"; then
    echo "metrics" | docker exec -i redpanda-0 rpk topic produce metrics-cloud-topic "${rpk_auth[@]}" >/dev/null \
      || echo "⚠️  Could not produce to the cloud topic."
  else
    echo "⚠️  Could not create a cloud topic; its metrics will be missing."
  fi

  # Per-entity quota metrics exist only for a named client that has a quota
  # and has been throttled. A default quota does not create them. The topic is
  # created first: a produce that auto-creates its topic can fail before the
  # partition has a leader. A new quota takes a moment to reach every broker,
  # so produce until the metric shows up.
  if docker exec redpanda-0 rpk topic create metrics-quota-probe "${rpk_auth[@]}" \
     && docker exec redpanda-0 rpk cluster quotas alter --name "client-id=$probe_client" \
       --add producer_byte_rate=1024 "${rpk_auth[@]}"; then
    local attempt throttled=0
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
      # One record of random data is over the 1 KB/s quota; data that
      # compresses well is not.
      { head -c 3000 /dev/urandom | base64 | tr -d '\n'; echo; } \
        | docker exec -i redpanda-0 rpk topic produce metrics-quota-probe \
            -X "globals.kafka_protocol_request_client_id=$probe_client" "${rpk_auth[@]}" >/dev/null 2>&1 || true
      for url in "${ADMIN_URLS[@]}"; do
        # Not a pipe into grep -q: under pipefail, grep exiting early fails the pipeline.
        if [[ "$(curl -sS --max-time 30 "$url/public_metrics/" 2>/dev/null || true)" == *redpanda_kafka_quotas_client_quota_throughput_by_entity* ]]; then
          throttled=1
          break
        fi
      done
      (( throttled )) && break
      sleep 3
    done
    (( throttled )) || echo "⚠️  The quota probe client was never throttled; per-entity quota metrics will be missing."
  else
    echo "⚠️  Could not set a client quota; per-entity quota metrics will be missing."
  fi

  # Some controller metrics are registered only when a broker takes controller
  # leadership after startup. Only the current leader accepts the request, so
  # ask each broker until one does.
  for url in "${ADMIN_URLS[@]}"; do
    if curl -sSf --max-time 10 -u "$ADMIN_USER:$ADMIN_PASS" -X POST \
         "$url/v1/partitions/redpanda/controller/0/transfer_leadership" >/dev/null 2>&1; then
      moved=1
      break
    fi
  done
  (( moved )) || echo "⚠️  Could not transfer controller leadership."
}

if (( METRICS_EXTRAS )); then
  run_metrics_actions
fi

if [[ "$MODE" == "metrics" ]]; then
  echo "⏳ Settling metrics (min ${METRICS_SETTLE_MIN}s, max ${METRICS_SETTLE_MAX}s, stable for ${METRICS_SETTLE_STABLE}s)…"
  SECONDS=0
  last_count=-1
  stable_since=0
  while true; do
    count="$(count_families)"
    if (( count != last_count )); then
      stable_since=$SECONDS
    fi
    stable_for=$(( SECONDS - stable_since ))
    echo "   ${SECONDS}s: ${count} metric families (unchanged for ${stable_for}s)"
    last_count="$count"
    if (( SECONDS >= METRICS_SETTLE_MIN && stable_for >= METRICS_SETTLE_STABLE )); then
      echo "✅ Metric set settled at ${count} families after ${SECONDS}s"
      break
    fi
    if (( SECONDS >= METRICS_SETTLE_MAX )); then
      echo "⚠️  Metric set still changing after ${METRICS_SETTLE_MAX}s (${count} families); continuing with what is exposed now."
      break
    fi
    sleep "$METRICS_POLL_INTERVAL"
  done
fi

###############################################################################
# Run documentation generator
###############################################################################
# ${arr[@]+"${arr[@]}"} expands to nothing for an empty array; a bare
# "${arr[@]}" is an unbound-variable error under set -u on bash 3.2 (macOS).
if [[ "$MODE" == "metrics" ]]; then
  ADMIN_URL_ARGS=()
  for url in "${ADMIN_URLS[@]}"; do ADMIN_URL_ARGS+=(--admin-url "$url"); done
  "$PYTHON" "$SCRIPT_DIR/../tools/metrics/metrics.py" "$TAG" "${ADMIN_URL_ARGS[@]}" ${GENERATOR_ARGS[@]+"${GENERATOR_ARGS[@]}"}
else
  "$PYTHON" "$SCRIPT_DIR/../tools/gen-rpk-ascii.py" "$TAG" ${GENERATOR_ARGS[@]+"${GENERATOR_ARGS[@]}"}
fi

echo "✅ $MODE docs generated successfully!"
