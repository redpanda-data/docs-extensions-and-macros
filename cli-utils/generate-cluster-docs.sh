#!/usr/bin/env bash
set -euo pipefail

# Check if Docker is installed and running
if ! command -v docker &> /dev/null; then
  echo "❌ Docker is not installed or not in PATH. Please install Docker to continue."
  exit 1
fi

# Check if Docker daemon is running
if ! docker info &> /dev/null; then
  echo "❌ Docker daemon is not running. Please start Docker to continue."
  exit 1
fi

# Remember where we started so we can always come back
ORIGINAL_PWD="$(pwd)"

# All "cli-utils…" calls should be relative to this script’s dir
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MODE="${1:-metrics}"
TAG="${2:-latest}"
DOCKER_REPO="${3:-redpanda}"
CONSOLE_TAG="${4:-latest}"
CONSOLE_REPO="${5:-console}"

# if it's an RC tag, switch Docker repo
shopt -s nocasematch
if [[ "$TAG" =~ rc[0-9]+ ]]; then
  DOCKER_REPO="redpanda-unstable"
fi
shopt -u nocasematch

if [[ "$TAG" == "latest" ]]; then
  MAJOR_MINOR="latest"
else
  MAJOR_MINOR="$(echo "$TAG" | sed -E 's/^v?([0-9]+\.[0-9]+).*$/\1/')"
fi

export REDPANDA_VERSION="$TAG"
export REDPANDA_DOCKER_REPO="$DOCKER_REPO"
export REDPANDA_CONSOLE_VERSION="$CONSOLE_TAG"
export REDPANDA_CONSOLE_DOCKER_REPO="$CONSOLE_REPO"

# Start up the cluster
"$SCRIPT_DIR"/start-cluster.sh "$TAG"

# Wait for it to settle
if [[ "$MODE" == "metrics" ]]; then
  echo "Waiting 300 seconds for metrics to be available…"
  sleep 300
else
  echo "Waiting 30 seconds for cluster to be ready…"
  sleep 30
fi

# Go back to where we were
cd "$ORIGINAL_PWD"

# Ensure Python venv (always create under cli-utils/venv)
"$SCRIPT_DIR"/python-venv.sh \
  "$SCRIPT_DIR"/venv \
  "$SCRIPT_DIR"/../tools/metrics/requirements.txt

if [[ "$MODE" == "metrics" ]]; then
  "$SCRIPT_DIR"/venv/bin/python \
    "$SCRIPT_DIR"/../tools/metrics/metrics.py \
    "$TAG"
else
  "$SCRIPT_DIR"/venv/bin/python \
    "$SCRIPT_DIR"/../tools/gen-rpk-ascii.py \
    "$TAG"
fi

echo "✅ Redpanda cluster docs generated successfully!"

# Tear down the cluster
cd "$SCRIPT_DIR"/../docker-compose
docker compose down --volumes

# Return to the original directory
cd "$ORIGINAL_PWD"
