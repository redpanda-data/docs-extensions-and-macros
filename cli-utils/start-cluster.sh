#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

###############################################################################
# Set START_CLUSTER_LOG=/path/to/logfile to capture output
###############################################################################
if [[ -n "${START_CLUSTER_LOG:-}" ]]; then
  exec > >(tee -a "$START_CLUSTER_LOG") 2>&1
fi

###############################################################################
# Prevent concurrent runs with a simple lockfile
###############################################################################
LOCKFILE="/tmp/start-cluster.lock"
if [[ -e "$LOCKFILE" ]]; then
  echo "❗ Another start-cluster.sh is already running. Remove $LOCKFILE if stale." >&2
  exit 1
fi
trap 'rm -f "$LOCKFILE"' EXIT
touch "$LOCKFILE"

###############################################################################
# Input parameters and defaults
###############################################################################
TAG="${1:-${CLUSTER_TAG:-latest}}"
PROJECT_NAME="${PROJECT_NAME:-redpanda_quickstart}"

###############################################################################
# Directory discovery
###############################################################################
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
QUICKSTART_DIR="$PACKAGE_ROOT/docker-compose"
CALLER_PWD="$(pwd)"

###############################################################################
# Determine major.minor for quickstart override
###############################################################################
MAJOR_MINOR="latest"
if [[ "$TAG" != "latest" ]]; then
  MAJOR_MINOR="$(echo "$TAG" | sed -E 's/^v?([0-9]+\.[0-9]+).*$/\1/')"
fi

if [[ "$MAJOR_MINOR" =~ ^([0-9]+)\.([0-9]+)$ ]]; then
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  if (( major > 25 )) || (( major == 25 && minor >= 1 )); then
    QUICKSTART_DIR="$PACKAGE_ROOT/docker-compose/25.1"
  fi
fi

###############################################################################
# Fetch quickstart bundle if missing
###############################################################################
if [[ ! -d "$QUICKSTART_DIR" ]]; then
  echo "📥 Fetching Redpanda quickstart for ${MAJOR_MINOR}…"
  url="https://docs.redpanda.com"
  if [[ "$TAG" == "latest" ]]; then
    url="$url/redpanda-quickstart.tar.gz"
  else
    url="$url/${MAJOR_MINOR}-redpanda-quickstart.tar.gz"
  fi
  curl -sSLf --retry 3 "$url" | tar -C "$PACKAGE_ROOT" -xzf -
  [[ -d "$QUICKSTART_DIR" ]] || { echo "❌ Expected '$QUICKSTART_DIR' but none was found."; exit 1; }
fi

###############################################################################
# Move into compose directory and clean up existing cluster
###############################################################################
cd "$QUICKSTART_DIR" || { echo "❌ Cannot cd to '$QUICKSTART_DIR'"; exit 1; }

if docker compose -p "$PROJECT_NAME" ps -q | grep -q .; then
  echo "🛑 Cleaning up existing cluster…"
  docker compose -p "$PROJECT_NAME" down --volumes
else
  echo "No running containers to remove for project \"$PROJECT_NAME\"."
fi

###############################################################################
# Remove globally conflicting containers (dynamic list + legacy minio)
###############################################################################
services=$(docker compose -p "$PROJECT_NAME" config --services 2>/dev/null || true)
services+=" minio"   # ensure legacy /minio container is handled

for svc in $services; do
  if docker ps -a --format '{{.Names}}' | grep -wq "$svc"; then
    echo "🧹 Removing existing container: $svc"
    docker rm -f "$svc"
  fi
done

###############################################################################
# Start cluster
###############################################################################
echo "▶️  Starting Redpanda cluster (version: ${TAG})…"
docker compose -p "$PROJECT_NAME" up -d

###############################################################################
# Return to caller and report success
###############################################################################
cd "$CALLER_PWD" || exit 1
echo "✅ Cluster is up (version: ${TAG})"
