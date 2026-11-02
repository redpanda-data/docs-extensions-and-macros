#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

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

###############################################################################
# Start Redpanda cluster
###############################################################################
"$SCRIPT_DIR/start-cluster.sh" "$TAG"

# Wait for the cluster to settle
if [[ "$MODE" == "metrics" ]]; then
  echo "⏳ Waiting 300 seconds for metrics to be available…"
  sleep 300
else
  echo "⏳ Waiting 30 seconds for cluster to be ready…"
  sleep 30
fi

###############################################################################
# Python virtual environment setup
###############################################################################
"$SCRIPT_DIR/python-venv.sh" \
  "$SCRIPT_DIR/venv" \
  "$SCRIPT_DIR/../tools/metrics/requirements.txt"

###############################################################################
# Run documentation generator
###############################################################################
if [[ "$MODE" == "metrics" ]]; then
  "$SCRIPT_DIR/venv/bin/python" \
    "$SCRIPT_DIR/../tools/metrics/metrics.py" "$TAG"
else
  "$SCRIPT_DIR/venv/bin/python" \
    "$SCRIPT_DIR/../tools/gen-rpk-ascii.py" "$TAG"
fi

echo "✅ $MODE docs generated successfully!"

# Tear down the cluster
cd "$SCRIPT_DIR"/../docker-compose
docker compose -p "$PROJECT_NAME" down --volumes

# Return to the original directory
cd "$ORIGINAL_PWD" || exit 1
