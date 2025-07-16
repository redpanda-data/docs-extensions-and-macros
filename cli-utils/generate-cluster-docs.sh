#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Function to log with timestamp (only for key operations)
log_step() {
  echo "[$(date '+%H:%M:%S')] $1" 
}

log_step "🚀 Starting cluster setup..."

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

if ! command -v curl &> /dev/null; then
  echo "❌ curl is not installed or not in PATH. Please install curl to continue."
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
log_step "� Starting Redpanda cluster..."
"$SCRIPT_DIR/start-cluster.sh" "$TAG"

# Wait for the cluster to settle
if [[ "$MODE" == "metrics" ]]; then
  log_step "⏳ Waiting for metrics endpoint..."
  
  # Wait for metrics endpoint to be responsive
  timeout=300
  counter=0
  metrics_url="http://localhost:19644/public_metrics/"
  
  while ! curl -f -s "$metrics_url" > /dev/null 2>&1; do
    if [ $counter -ge $timeout ]; then
      echo "❌ Metrics endpoint did not become ready within ${timeout}s"
      exit 1
    fi
    sleep 10
    counter=$((counter + 10))
  done
  
  log_step "✅ Metrics endpoint ready"
else
  sleep 30
fi

###############################################################################
# Python virtual environment setup
###############################################################################
log_step "🐍 Setting up Python environment..."
"$SCRIPT_DIR/python-venv.sh" \
  "$SCRIPT_DIR/venv" \
  "$SCRIPT_DIR/../tools/metrics/requirements.txt"

###############################################################################
# Run documentation generator
###############################################################################
log_step "📝 Generating $MODE documentation..."

if [[ "$MODE" == "metrics" ]]; then
  "$SCRIPT_DIR/venv/bin/python" \
    "$SCRIPT_DIR/../tools/metrics/metrics.py" "$TAG"
else
  "$SCRIPT_DIR/venv/bin/python" \
    "$SCRIPT_DIR/../tools/gen-rpk-ascii.py" "$TAG"
fi

log_step "✅ Documentation generated successfully"

# Tear down the cluster
log_step "🧹 Cleaning up cluster..."
cd "$SCRIPT_DIR"/../docker-compose
docker compose -p "$PROJECT_NAME" down --volumes > /dev/null 2>&1

# Return to the original directory
cd "$ORIGINAL_PWD" || exit 1
