#!/usr/bin/env bash
#
#   Create a new venv at $1 and install from $2

set -euo pipefail

VENV_DIR="${1:-venv}"
REQ_FILE="${2:-requirements.txt}"

echo "Recreating Python venv at $VENV_DIR..." 
rm -rf "$VENV_DIR"
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip --quiet

if [[ -f "$REQ_FILE" ]]; then
  echo "Installing $REQ_FILE..."
  "$VENV_DIR/bin/pip" install -r "$REQ_FILE" --quiet
else
  echo "⚠️  Requirements file not found at $REQ_FILE"
fi
