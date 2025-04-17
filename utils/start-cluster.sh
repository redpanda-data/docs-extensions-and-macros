#!/usr/bin/env bash
set -euo pipefail

# Usage: start-cluster.sh <tag>
TAG="${1:-latest}"
WORK_DIR="$(pwd)"

# Compute MAJOR_MINOR for quickstart URL
if [[ "$TAG" == "latest" ]]; then
  MAJOR_MINOR="latest"
else
  MAJOR_MINOR=$(echo "$TAG" | sed -E 's/^v?([0-9]+\.[0-9]+).*$/\1/')
fi

# Ensure we have a docker-compose/ dir
if [[ ! -d "docker-compose" ]]; then
  echo "Fetching Redpanda quickstart for $MAJOR_MINOR…"
  if [[ "$TAG" == "latest" ]]; then
    curl -sSL https://docs.redpanda.com/redpanda-quickstart.tar.gz | tar xzf -
  else
    curl -sSL "https://docs.redpanda.com/${MAJOR_MINOR}-redpanda-quickstart.tar.gz" | tar xzf -
  fi

  # After extraction we expect to see a folder named docker-compose
  if [[ ! -d "docker-compose" ]]; then
    echo "❌ Expected a 'docker-compose' directory but none was found. Exiting."
    exit 1
  fi
fi

# Now cd in and run Docker commands
cd docker-compose

# Tear down any running cluster
if docker compose ps | grep -q Up; then
  echo "Stopping existing cluster…"
  docker compose down --volumes
fi

# Bring it back up
echo "Starting Redpanda cluster…"
docker compose up -d

# Return to caller
cd "$WORK_DIR"
