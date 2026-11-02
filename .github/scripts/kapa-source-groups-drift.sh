#!/usr/bin/env bash
# Runs `doc-tools validate kapa-source-groups`, which checks that every
# published streaming docs version has a grouped Kapa source and that the
# committed mapping points at that group, and opens or updates one issue in
# ISSUE_REPO when it reports a gap.
#
# Run by .github/workflows/kapa-source-groups-drift.yml from the checkout.
# __tests__/workflows/kapa-source-groups-drift.test.js executes this script
# against a stubbed gh and asserts the workflow invokes it.
#
# EXIT STATUS
#   0  everything in sync
#   1  a gap was found (issue opened or updated, unless this is a PR or a
#      dispatch from a branch other than main)
#   2  could not find out (Kapa or the sitemap unreachable, bad credentials)
#
# The 1 vs 2 split is the whole design. A job that reads "Kapa was down" as
# "a version is missing" files a false issue on every blip and people stop
# reading them. So an inconclusive run fails the job loudly but files nothing.
set -uo pipefail

# The issue lands in the repo the docs team watches, not the one running the
# check. Needs a token with issues:write there; github.token is scoped to this
# repo only, so the workflow supplies the org bot token as GH_TOKEN.
ISSUE_REPO="${ISSUE_REPO:-redpanda-data/docs-ui}"
ISSUE_TITLE="${ISSUE_TITLE:-Kapa source groups are out of sync with the published docs versions}"
ISSUE_LABEL="${ISSUE_LABEL:-documentation}"
RUN_URL="${RUN_URL:-}"
# Set by the workflow so a PR run annotates the check instead of filing an issue.
EVENT_NAME="${EVENT_NAME:-schedule}"
# Set by Actions. Only a run against main files an issue; a workflow_dispatch
# from any other branch is someone testing and must not page the docs team.
GITHUB_REF="${GITHUB_REF:-refs/heads/main}"

# -e stays OFF: a non-zero exit from the check is the signal, not a reason to
# abort before it can be reported, and every failure below is checked explicitly.
set +e
OUTPUT="$(npx --no-install doc-tools validate kapa-source-groups 2>&1)"
STATUS=$?

printf '%s\n' "$OUTPUT"

if [ "$STATUS" -eq 0 ]; then
  echo "Kapa and the committed mapping are in sync. Nothing to report."
  exit 0
fi

if [ "$STATUS" -ne 1 ]; then
  echo "::error::Could not determine whether Kapa covers every published version (exit ${STATUS}). No issue filed." >&2
  exit 2
fi

# Exit 1 alone does not mean a gap. Commander exits 1 on a usage error and an
# uncaught throw exits 1 too, so a typo'd flag or a crash would otherwise file
# an issue quoting a stack trace as the report. The command prints this sentinel
# only where it has actually established a gap.
if ! printf '%s\n' "$OUTPUT" | grep -qx 'KAPA_DRIFT_CONFIRMED'; then
  echo "::error::validate exited 1 without confirming a gap, so it failed rather than found one. No issue filed." >&2
  exit 2
fi

if [ "$EVENT_NAME" = "pull_request" ]; then
  # A failing check on the PR is already the notification; an issue would be noise.
  echo "::error::Kapa and the committed mapping are out of sync. See the check output above." >&2
  exit 1
fi

if [ "$GITHUB_REF" != "refs/heads/main" ]; then
  echo "::error::Kapa and the committed mapping are out of sync. Not filing an issue from ${GITHUB_REF}; only runs against main do." >&2
  exit 1
fi

BODY="$(
  printf '%s\n' \
    'Kapa and the committed source-group mapping are out of sync for a published streaming docs version, so Ask AI cannot scope answers to it correctly. The check output says which version and why.' \
    '' \
    '```' \
    "$(printf '%s\n' "$OUTPUT" | grep -vx 'KAPA_DRIFT_CONFIRMED')" \
    '```' \
    '' \
    'Kapa has no write API, so any dashboard work is by hand: Sources > Add source for a missing crawl, then assign it to its version group under Sources > Manage groups. Then regenerate the mapping in docs-extensions-and-macros with `doc-tools generate kapa-source-groups` and release it.' \
    '' \
    "Run: ${RUN_URL:-(not available)}"
)"

# --search restricted to the title, so an unrelated open issue mentioning Kapa
# can never be mistaken for this one and commented on.
EXISTING="$(gh issue list \
  --repo "$ISSUE_REPO" \
  --state open \
  --search "\"${ISSUE_TITLE}\" in:title" \
  --json number \
  --jq '.[0].number' 2>/dev/null || true)"

if [ -n "$EXISTING" ] && [ "$EXISTING" != "null" ]; then
  gh issue comment "$EXISTING" --repo "$ISSUE_REPO" --body "$BODY" \
    || { echo "::error::Gap found but could not comment on ${ISSUE_REPO}#${EXISTING}." >&2; exit 2; }
  echo "Commented on existing issue ${ISSUE_REPO}#${EXISTING}."
else
  gh issue create --repo "$ISSUE_REPO" \
    --title "$ISSUE_TITLE" --label "$ISSUE_LABEL" --body "$BODY" \
    || { echo "::error::Gap found but could not create an issue in ${ISSUE_REPO}." >&2; exit 2; }
  echo "Opened a new issue in ${ISSUE_REPO}."
fi

exit 1
