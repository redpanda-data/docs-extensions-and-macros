#!/usr/bin/env bash
# Fail a pull request that edits generated files without an allow label.
#
# This file is the SOURCE OF TRUTH. A reusable workflow runs in the caller's
# repository, so it cannot read files out of this one, which is why
# .github/workflows/guard-generated-files.yml embeds this script verbatim in its
# run: block. __tests__/workflows/guard-generated-files.test.js asserts the two
# copies are byte-identical and drives this file directly, so edit here and
# re-embed rather than editing the workflow.
#
# Inputs, all through the environment:
#   EVENT_NAME       github.event_name of the calling workflow
#   REPO             owner/name of the repository
#   PR_NUMBER        pull request number
#   GENERATED_PATHS  newline-separated generated paths
#   EXCLUDE_PATHS    newline-separated paths to exempt (may be empty)
#   ALLOW_LABELS     newline-separated labels that permit the change
#   PR_LABELS_JSON   JSON array of the label names on the pull request
#   GH_TOKEN         token with pull-requests: read, for gh api
#
# The guard is a merge gate, so every unexpected condition FAILS CLOSED: a
# missing PR context, an API error, a truncated changed-file list and an
# unreadable label list all exit non-zero with an ::error:: annotation. A green
# check therefore means "checked and clean", never "could not check".
#
# Known and deliberate limitation: the guard compares paths only, never content,
# because it runs without a checkout. A pull request that carries an allow label
# can change anything under the generated paths, so allow labels belong to
# generation workflows, not to people.
#
# Label matching is exact and case-sensitive: 'Auto-Docs' does not satisfy an
# allow-labels entry of 'auto-docs'.
set -euo pipefail

fail() {
  echo "::error::$*"
  exit 1
}

# One parser for all three newline-separated inputs: trim both ends, drop blanks.
# Trimming only the trailing end silently disables an over-indented entry.
normalize_list() {
  printf '%s\n' "${1-}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | sed '/^$/d'
}

# Join a newline-separated list for human-readable messages. `paste -sd ', '`
# looks like it does this but treats ', ' as a cycling list of delimiters, so
# three labels come out as "a,b c".
join_list() {
  printf '%s\n' "${1-}" | awk 'NF { if (n++) printf ", "; printf "%s", $0 } END { if (n) printf "\n" }'
}

# Match a file against a configured path at a path boundary: "a/b" matches "a/b"
# and "a/b/c", never "a/bc". A bare prefix test over-matches in both directions:
# it invents violations for siblings, and, worse, an exclusion silently exempts
# every sibling whose name merely starts with it.
path_matches() {
  local file=$1
  local path=${2%/}
  [ -n "$path" ] || return 1
  case $file in
    "$path"|"$path"/*) return 0 ;;
  esac
  return 1
}

command -v gh >/dev/null 2>&1 || fail "gh CLI not found; cannot list the changed files."
command -v jq >/dev/null 2>&1 || fail "jq not found; cannot read the pull request labels."

# github.event.pull_request is absent on push, schedule, workflow_dispatch and
# merge_group, which would leave PR_NUMBER empty and the API URL malformed.
case "${EVENT_NAME:-}" in
  pull_request|pull_request_target) ;;
  *) fail "guard-generated-files runs on pull_request events only, but the caller ran on '${EVENT_NAME:-<unset>}'. Call it from 'on: pull_request' so the guard can read the pull request's changed files." ;;
esac

case "${PR_NUMBER:-}" in
  '') fail "PR_NUMBER is empty, so the changed files cannot be read. The caller must run on a pull_request event." ;;
  *[!0-9]*) fail "PR_NUMBER '${PR_NUMBER}' is not a number." ;;
esac

[ -n "${REPO:-}" ] || fail "REPO is empty; expected owner/name."

prefixes=$(normalize_list "${GENERATED_PATHS:-}")
[ -n "$prefixes" ] || fail "generated-paths input is empty."
excludes=$(normalize_list "${EXCLUDE_PATHS:-}")
allow_labels=$(normalize_list "${ALLOW_LABELS:-}")
[ -n "$allow_labels" ] || fail "allow-labels input is empty, which would leave no way to land a genuine generator change."

# toJSON(github.event.pull_request.labels.*.name) yields 'null' with no pull
# request context. Reject anything that is not a JSON array here, loudly, rather
# than letting jq die later with "Cannot iterate over null".
printf '%s' "${PR_LABELS_JSON:-}" | jq -e 'type == "array"' >/dev/null 2>&1 ||
  fail "Could not read the pull request labels: expected a JSON array in PR_LABELS_JSON, got '${PR_LABELS_JSON:-<unset>}'."

changed_files=$(mktemp)
violating_files=$(mktemp)
trap 'rm -f "$changed_files" "$violating_files"' EXIT

# A renamed file is reported under its new path only, with the old path in
# previous_filename, so moving a generated file out of a generated directory
# would otherwise be invisible. Check both paths.
if ! gh api "repos/${REPO}/pulls/${PR_NUMBER}/files?per_page=100" --paginate \
  --jq '.[] | [.filename, (.previous_filename // "")] | @tsv' >"$changed_files"; then
  fail "Could not list the changed files of ${REPO}#${PR_NUMBER} through the GitHub API, so this pull request cannot be verified. Check that the calling job grants 'permissions: pull-requests: read'."
fi

# The pull request files endpoint returns at most 3000 files, even with
# pagination, and silently drops the rest. A padded pull request must not be able
# to hide a generated-file edit past the cap.
entry_count=$(grep -c '' <"$changed_files" || true)
if [ "${entry_count:-0}" -ge 3000 ]; then
  fail "${REPO}#${PR_NUMBER} reports ${entry_count} changed files, at or above the GitHub API's 3000-file limit, so the changed-file list may be truncated and cannot be verified. Split the pull request."
fi

while IFS="$(printf '\t')" read -r new_path old_path; do
  for candidate in "$new_path" "$old_path"; do
    [ -n "$candidate" ] || continue

    excluded=false
    while IFS= read -r exclude; do
      [ -n "$exclude" ] || continue
      if path_matches "$candidate" "$exclude"; then
        excluded=true
        break
      fi
    done <<<"$excludes"
    [ "$excluded" = false ] || continue

    while IFS= read -r prefix; do
      [ -n "$prefix" ] || continue
      if path_matches "$candidate" "$prefix"; then
        printf '%s\n' "$candidate" >>"$violating_files"
        break
      fi
    done <<<"$prefixes"
  done
done <"$changed_files"

violations=$(awk 'NF && !seen[$0]++' "$violating_files")
if [ -z "$violations" ]; then
  echo "No generated files changed."
  exit 0
fi

matched_label=$(printf '%s' "$PR_LABELS_JSON" | jq -r --arg allow "$allow_labels" '
  ($allow | split("\n") | map(select(length > 0))) as $wanted
  | map(select(. as $name | $wanted | index($name))) | first // empty')

if [ -n "$matched_label" ]; then
  echo "PR has the '${matched_label}' label; generated-file changes are allowed:"
  printf '%s\n' "$violations" | sed 's/^/  /'
  exit 0
fi

allow_list=$(join_list "$allow_labels")
echo "::error::This PR modifies auto-generated files without an allow label (${allow_list}):"
printf '%s\n' "$violations" | while IFS= read -r file; do
  echo "::error file=${file}::Auto-generated file edited by hand: ${file}"
done
echo "::error::These files are produced by a generation workflow. Update the source data or the generator template instead, or add one of the labels (${allow_list}) if this change genuinely comes from the generator."
exit 1
