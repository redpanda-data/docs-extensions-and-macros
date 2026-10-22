#!/usr/bin/env bash
# Runs `doc-tools check-dispatch-graph`, which reads the repository_dispatch
# senders and listeners across the engineering and docs repos and the run
# record of every edge, and opens or updates ONE issue in ISSUE_REPO when it
# reports a finding.
#
# Run by .github/workflows/check-dispatch-graph.yml from the checkout.
# __tests__/workflows/check-dispatch-graph.test.js executes this script against
# a stubbed gh and asserts the workflow invokes it.
#
# EXIT STATUS
#   0  the graph is healthy (an open issue from an earlier run is closed)
#   1  findings (issue opened or updated, unless this is a PR or a dispatch
#      from a branch other than main)
#   2  could not find out (a repo or its runs unreadable, bad token, crash,
#      or the existing issue could not be looked up, updated or closed)
#
# The 1 vs 2 split is the whole design. A job that reads "the API was down" or
# "the token cannot see the private repos" as "the graph is broken" files a
# false issue on every blip and people stop reading them. So an inconclusive
# run fails the job loudly but files nothing. The reverse matters as much:
# an unauthenticated run must never look clean, which is why the command
# itself exits 2 when any repo is unreadable.
set -uo pipefail

ISSUE_REPO="${ISSUE_REPO:-${GITHUB_REPOSITORY:-redpanda-data/docs-extensions-and-macros}}"
ISSUE_TITLE="${ISSUE_TITLE:-repository_dispatch graph has broken edges}"
ISSUE_LABEL="${ISSUE_LABEL:-dispatch-graph}"
RUN_URL="${RUN_URL:-}"
# Set by the workflow so a PR run annotates the check instead of filing an issue.
EVENT_NAME="${EVENT_NAME:-schedule}"
# Set by Actions. Only a run against main files an issue; a workflow_dispatch
# from any other branch is someone testing and must not page the docs team.
GITHUB_REF="${GITHUB_REF:-refs/heads/main}"

# -e stays OFF: a non-zero exit from the check is the signal, not a reason to
# abort before it can be reported, and every failure below is checked explicitly.
set +e

# Only a scheduled or dispatched run against main touches the issue.
may_file() {
  [ "$EVENT_NAME" != "pull_request" ] && [ "$GITHUB_REF" = "refs/heads/main" ]
}

# Prints the number of the open issue, or nothing when there is none. Returns
# non-zero when the lookup itself failed, which callers must not read as
# "no issue": that would file a duplicate on every API blip.
# --search restricted to the title, so an unrelated open issue mentioning
# dispatches can never be mistaken for this one and overwritten.
find_existing() {
  local out
  out="$(gh issue list \
    --repo "$ISSUE_REPO" \
    --state open \
    --label "$ISSUE_LABEL" \
    --search "\"${ISSUE_TITLE}\" in:title" \
    --json number \
    --jq '.[0].number')" || return 1
  [ "$out" = "null" ] && out=""
  printf '%s' "$out"
}

OUTPUT="$(npx --no-install doc-tools check-dispatch-graph 2>&1)"
STATUS=$?

printf '%s\n' "$OUTPUT"

if [ "$STATUS" -eq 0 ]; then
  echo "The dispatch graph is healthy. Nothing to report."
  may_file || exit 0
  # A healthy run closes the issue an earlier run opened, so an open issue
  # always means the graph is broken now.
  if ! EXISTING="$(find_existing)"; then
    echo "::error::The graph is healthy, but could not look up an open issue in ${ISSUE_REPO} to close it." >&2
    exit 2
  fi
  if [ -n "$EXISTING" ]; then
    gh issue close "$EXISTING" --repo "$ISSUE_REPO" \
      --comment "The weekly check-dispatch-graph run found no broken edges, so this is resolved. Run: ${RUN_URL:-(not available)}" >/dev/null \
      || { echo "::error::The graph is healthy, but could not close ${ISSUE_REPO}#${EXISTING}." >&2; exit 2; }
    echo "Closed ${ISSUE_REPO}#${EXISTING}: the graph is healthy again."
  fi
  exit 0
fi

if [ "$STATUS" -ne 1 ]; then
  echo "::error::Could not check the whole dispatch graph (exit ${STATUS}). No issue filed." >&2
  exit 2
fi

# Exit 1 alone does not mean a finding. Commander exits 1 on a usage error and
# an uncaught throw exits 1 too, so a typo'd flag or a crash would otherwise
# file an issue quoting a stack trace as the report. The command prints this
# sentinel only where it has actually established findings.
if ! printf '%s\n' "$OUTPUT" | grep -qx 'DISPATCH_GRAPH_FINDINGS_CONFIRMED'; then
  echo "::error::check-dispatch-graph exited 1 without confirming findings, so it failed rather than found something. No issue filed." >&2
  exit 2
fi

if [ "$EVENT_NAME" = "pull_request" ]; then
  echo "::error::The dispatch graph has broken edges. See the check output above." >&2
  exit 1
fi

if [ "$GITHUB_REF" != "refs/heads/main" ]; then
  echo "::error::The dispatch graph has broken edges. Not filing an issue from ${GITHUB_REF}; only runs against main do." >&2
  exit 1
fi

# The issue body is the whole report minus the sentinel (machine plumbing a
# reader should not see) and minus the edge table, which is long and is in the
# run log. The findings are what someone acting on the issue needs.
REPORT="$(printf '%s\n' "$OUTPUT" | grep -vx 'DISPATCH_GRAPH_FINDINGS_CONFIRMED' | sed '/^Edges:$/,$d')"

BODY="$(
  printf '%s\n' \
    'The weekly `doc-tools check-dispatch-graph` run found broken edges in the repository_dispatch graph between the engineering repos and the docs repos. A dispatch is accepted (HTTP 204) whether or not anything listens, and a receiver that always fails looks the same as one that always works from the sender side, so these do not surface anywhere else.' \
    '' \
    "Checked: $(date -u +%Y-%m-%dT%H:%MZ). This issue is updated in place on every run that still has findings, and closed by the first run that finds none." \
    '' \
    '```' \
    "$REPORT" \
    '```' \
    '' \
    'The full edge table, with every sender and receiver run record, is in the run log.' \
    '' \
    "Run: ${RUN_URL:-(not available)}"
)"

# Idempotent: `gh label create` fails when the label exists, which is the
# normal case after the first run, so the failure is ignored on purpose. If
# creating it fails for a real reason, the issue create below fails loudly.
gh label create "$ISSUE_LABEL" --repo "$ISSUE_REPO" \
  --description "Filed by the weekly check-dispatch-graph run" --color 'D93F0B' >/dev/null 2>&1 || true

if ! EXISTING="$(find_existing)"; then
  echo "::error::Findings, but could not look up an existing issue in ${ISSUE_REPO}. Not filing, so a failed lookup cannot open a duplicate." >&2
  exit 2
fi

if [ -n "$EXISTING" ]; then
  # Updated in place rather than commented on, so the issue always reads as
  # the current state of the graph and a long-lived break does not pile up
  # one comment per week.
  gh issue edit "$EXISTING" --repo "$ISSUE_REPO" --body "$BODY" >/dev/null \
    || { echo "::error::Findings, but could not update ${ISSUE_REPO}#${EXISTING}." >&2; exit 2; }
  echo "Updated existing issue ${ISSUE_REPO}#${EXISTING}."
else
  gh issue create --repo "$ISSUE_REPO" \
    --title "$ISSUE_TITLE" --label "$ISSUE_LABEL" --body "$BODY" \
    || { echo "::error::Findings, but could not create an issue in ${ISSUE_REPO}." >&2; exit 2; }
  echo "Opened a new issue in ${ISSUE_REPO}."
fi

exit 1
