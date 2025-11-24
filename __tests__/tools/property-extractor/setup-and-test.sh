#!/bin/bash
# Setup script for property extractor Python tests
# Creates virtual environment and installs dependencies if they don't exist

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL_ROOT="$SCRIPT_DIR/../../../tools/property-extractor"
VENV="$TOOL_ROOT/tmp/redpanda-property-extractor-venv"
REQUIREMENTS="$TOOL_ROOT/requirements.txt"

# Create venv if it doesn't exist
if [ ! -d "$VENV" ]; then
  echo "🐍 Creating virtual environment in $VENV..."
  python3 -m venv "$VENV"
fi

# Upgrade pip and install requirements
echo "🔄 Installing Python dependencies..."
"$VENV/bin/pip" install --upgrade pip --quiet
"$VENV/bin/pip" install --no-cache-dir -r "$REQUIREMENTS" --quiet

# Run tests
echo "🧪 Running Python tests..."
cd "$SCRIPT_DIR"
"$VENV/bin/python" -m pytest . -v
