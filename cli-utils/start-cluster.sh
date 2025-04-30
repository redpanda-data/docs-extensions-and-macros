#!/usr/bin/env bash
set -euo pipefail

# Usage: start-cluster.sh <tag>
TAG="${1:-latest}"

# Where this script lives (cli-utils)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# One level up is the package root, where we expect docker‑compose/
PACKAGE_ROOT="$(cd "$SCRIPT_DIR"/.. && pwd)"
QUICKSTART_DIR="$PACKAGE_ROOT/docker-compose"

# Remember where the user called us from
CALLER_PWD="$(pwd)"

# Default quickstart version
MAJOR_MINOR="latest"
if [[ "$TAG" != "latest" ]]; then
  MAJOR_MINOR="$(echo "$TAG" | sed -E 's/^v?([0-9]+\.[0-9]+).*$/\1/')"
fi

# Fetch quickstart into package root if needed
if [[ ! -d "$QUICKSTART_DIR" ]]; then
  echo "📥 Fetching Redpanda quickstart for ${MAJOR_MINOR}…"
  if [[ "$TAG" == "latest" ]]; then
	  curl -sSLf --retry 3 https://docs.redpanda.com/redpanda-quickstart.tar.gz \
	  | tar -C "$PACKAGE_ROOT" -xzf -
  else
    curl -sSLf --retry 3 "https://docs.redpanda.com/${MAJOR_MINOR}-redpanda-quickstart.tar.gz" \
      | tar -C "$PACKAGE_ROOT" -xzf -
  fi

  if [[ ! -d "$QUICKSTART_DIR" ]]; then
    echo "❌ Expected '$QUICKSTART_DIR' but none was found after extraction."
    exit 1
  fi
fi

# Switch into the quickstart dir and (re)start the cluster
cd "$QUICKSTART_DIR"

if docker compose ps | grep -q Up; then
  echo "🛑 Stopping existing cluster…"
  docker compose down --volumes
fi

echo "▶️  Starting Redpanda cluster…"
docker compose up -d

# Return to original directory
cd "$CALLER_PWD"
echo "✅ Cluster is up (version: ${TAG})"
