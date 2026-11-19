#!/usr/bin/env bash
# Runs the metrics cluster for .github/workflows/metrics-close-gaps.yml.
# The workflow calls this. The model never does: it has no shell.
#
#   gap_loop_run.sh generate <tag> <source> <out-dir>
#       Start the cluster, run the generator into <out-dir>, stop the cluster.
#
#   gap_loop_run.sh attempt <tag> <source> <state-dir> <max> <response-file>
#       One attempt: count it, apply the model's response, run the cluster,
#       compare with the baseline, then keep or revert the change. Exits 0
#       whatever the attempt's result. The result is in <state-dir>.
#
# Run it from the root of this repository. GAP_LOOP_PY names the gap_loop.py
# to use. The workflow points it at a copy outside the tree, so a change to
# the tree cannot change the judge.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GAP_LOOP_PY="${GAP_LOOP_PY:-$HERE/gap_loop.py}"
PYTHON="${PYTHON:-python3}"

gap_loop() {
  "$PYTHON" "$GAP_LOOP_PY" "$@"
}

generate() {
  local tag="$1" source="$2" out="$3" rc=0
  rm -rf "$out"
  mkdir -p "$out"
  node bin/doc-tools.js generate metrics-docs \
    --tag "$tag" --skip-pages --source-repo "$source" --output-dir "$out" \
    > "$out/run.log" 2>&1 || rc=$?
  # The run's output has no source code: metric names and file paths only.
  tail -n 60 "$out/run.log"
  if (( rc != 0 )); then
    echo "The metrics run failed with exit code $rc."
    return "$rc"
  fi
  if [[ ! -s "$out/metrics-gaps.json" || ! -s "$out/redpanda-metrics-$tag.json" ]]; then
    echo "The metrics run wrote no gaps file or no dataset."
    return 1
  fi
}

attempt() {
  local tag="$1" source="$2" state="$3" max="$4" response="$5" number rc=0 dir out
  # First, so the cap holds whatever the response says.
  number="$(gap_loop attempt --state "$state" --max "$max")" || return 0
  dir="$state/attempts/$(printf '%02d' "$number")"
  out="$dir/out"

  gap_loop apply --state "$state" --response "$response" --source "$source" || rc=$?
  if (( rc != 0 )); then
    # 4: refused. 5: valid, and nothing to run. Both are in the state now.
    return 0
  fi

  if generate "$tag" "$source" "$out"; then
    rc=0
    gap_loop compare --state "$state" --gaps "$out/metrics-gaps.json" \
      --dataset "$out/redpanda-metrics-$tag.json" --json > "$dir/compare.json" || rc=$?
    if (( rc == 2 )); then
      gap_loop record --state "$state" --failed --log "$out/run.log"
    else
      gap_loop record --state "$state" --compare "$dir/compare.json"
    fi
  else
    gap_loop record --state "$state" --failed --log "$out/run.log"
  fi
  # The datasets are large and the state is read again on every attempt.
  rm -rf "$out"
  return 0
}

case "${1:-}" in
  generate)
    [[ $# -eq 4 ]] || { echo "usage: $0 generate <tag> <source> <out-dir>" >&2; exit 2; }
    generate "$2" "$3" "$4"
    ;;
  attempt)
    [[ $# -eq 6 ]] || { echo "usage: $0 attempt <tag> <source> <state-dir> <max> <response-file>" >&2; exit 2; }
    attempt "$2" "$3" "$4" "$5" "$6"
    ;;
  *)
    echo "usage: $0 generate|attempt ..." >&2
    exit 2
    ;;
esac
