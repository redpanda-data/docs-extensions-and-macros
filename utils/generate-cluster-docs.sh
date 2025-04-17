#!/usr/bin/env bash

MODE="${1:-metrics}"
TAG="${2:-latest}"
DOCKER_REPO="${3:-redpanda}"
CONSOLE_TAG="${4:-latest}"
CONSOLE_REPO="${5:-console}"

# If TAG contains "rc" (such as v25.1.1-rc3), switch to the unstable repo
shopt -s nocasematch
if [[ "$TAG" =~ rc[0-9]* ]]; then
  DOCKER_REPO="redpanda-unstable"
fi
shopt -u nocasematch

export REDPANDA_VERSION="$TAG"
export REDPANDA_DOCKER_REPO="$DOCKER_REPO"
export REDPANDA_CONSOLE_VERSION="$CONSOLE_TAG"
export REDPANDA_CONSOLE_DOCKER_REPO="$CONSOLE_REPO"

# Start cluster
utils/start-cluster.sh "$TAG"

MAJOR_MINOR="latest"
if [[ "$TAG" != "latest" ]]; then
  MAJOR_MINOR=$(echo "$TAG" | sed -E 's/^v?([0-9]+\.[0-9]+).*$/\1/')
fi

# Wait based on mode
if [[ "$MODE" == "metrics" ]]; then
  echo "Waiting 120 seconds for metrics to be available…"
  sleep 120
else
  echo "Waiting 30 seconds for cluster to be ready…"
  sleep 30
fi

# Back to repo root
cd "$(pwd)"

# Create venv
if [[ "$MODE" == "metrics" ]]; then
  utils/python-venv.sh venv tools/metrics/requirements.txt
fi

# Run the right tool
if [[ "$MODE" == "metrics" ]]; then
  venv/bin/python tools/metrics/metrics.py "$MAJOR_MINOR"
else
  venv/bin/python tools/gen-rpk-ascii.py "$MAJOR_MINOR"
fi

echo "Redpanda cluster docs generated successfully!"

echo "Stopping the cluster…"
# Tear down
cd docker-compose
docker compose down --volumes
