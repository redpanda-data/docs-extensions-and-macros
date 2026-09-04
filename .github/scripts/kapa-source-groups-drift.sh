#!/usr/bin/env bash
# Reports drift between docs-data/kapa-source-groups.json, Kapa, and the
# published docs versions, and opens or updates a single GitHub issue when it
# finds any.
#
# Embedded verbatim into .github/workflows/kapa-source-groups-drift.yml.
# __tests__/workflows/kapa-source-groups-drift.test.js asserts the two stay
# byte-identical and executes this script against a stubbed gh, mirroring
# guard-generated-files.sh.
#
# EXIT STATUS
#   0  in sync
#   1  drift found (issue opened or updated)
#   2  could not find out (Kapa unreachable, bad credentials, sitemap moved)
#
# The 1 vs 2 split is the whole design. A scheduled job that treats "the API was
# down" as "the mapping is stale" files a false issue every time Kapa blips, and
# people stop reading the issues. So an inconclusive run fails the job loudly but
# files nothing.
#
# One issue is reused rather than reopened per run, matching check-env-vars.yml in
# redpanda-data/docs: a weekly job that opens a fresh issue every week buries the
# original context.
set -uo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
ISSUE_TITLE="${ISSUE_TITLE:-Kapa source-group mapping is out of date}"
ISSUE_LABEL="${ISSUE_LABEL:-documentation}"
RUN_URL="${RUN_URL:-}"
# Set by the workflow so a PR run annotates the check instead of filing an issue.
EVENT_NAME="${EVENT_NAME:-schedule}"

# set +e around the check: a non-zero exit is the signal, not a reason to abort
# before the result can be reported.
# -e stays OFF for the rest of the script. Every failure below is checked
# explicitly, and with -e on, a failing `gh issue list` aborted the script before
# it could file anything while still exiting 1 — which reads as "drift reported"
# when nothing was reported.
set +e
OUTPUT="$(npx --no-install doc-tools validate kapa-source-groups 2>&1)"
STATUS=$?

printf '%s\n' "$OUTPUT"

if [ "$STATUS" -eq 0 ]; then
  echo "In sync. Nothing to report."
  exit 0
fi

if [ "$STATUS" -ne 1 ]; then
  # Status 2, or an unexpected status. Either way the mapping's state is unknown,
  # so filing a drift issue would be a guess.
  echo "::error::Could not determine whether the Kapa mapping is current (exit ${STATUS}). No issue filed." >&2
  exit 2
fi

# Drift confirmed from here on.
if [ "$EVENT_NAME" = "pull_request" ]; then
  # A failing check on the PR is already the notification; an issue would be noise.
  echo "::error::Kapa source-group mapping is out of date. See the check output above." >&2
  exit 1
fi

BODY="$(
  printf '%s\n' \
    'The committed Kapa source-group mapping no longer matches reality.' \
    '' \
    '```' \
    "$OUTPUT" \
    '```' \
    '' \
    '## What to do' \
    '' \
    'If a version is published but has no Kapa source group, create the source and' \
    'group in the Kapa dashboard first (Sources > Add source for the crawl, then' \
    'Manage groups for the group), because Kapa has no write API. Then regenerate:' \
    '' \
    '```' \
    'doc-tools generate kapa-source-groups' \
    '```' \
    '' \
    'If a version is mapped but no longer published, remove its Kapa source so' \
    'answers stop citing pages that 404, then regenerate.' \
    '' \
    'Until this is fixed, readers on any unmapped version silently get the default' \
    'segment rather than their own version, which is the DOC-2450 failure mode.' \
    '' \
    "Run: ${RUN_URL:-(not available)}"
)"

# --search restricted to the title, so an unrelated open issue mentioning Kapa
# can never be mistaken for this one and commented on.
EXISTING="$(gh issue list \
  --repo "$GITHUB_REPOSITORY" \
  --state open \
  --search "\"${ISSUE_TITLE}\" in:title" \
  --json number \
  --jq '.[0].number' 2>/dev/null || true)"

if [ -n "$EXISTING" ] && [ "$EXISTING" != "null" ]; then
  gh issue comment "$EXISTING" --repo "$GITHUB_REPOSITORY" --body "$BODY" \
    || { echo "::error::Drift found but could not comment on issue #${EXISTING}." >&2; exit 2; }
  echo "Commented on existing issue #${EXISTING}."
else
  gh issue create --repo "$GITHUB_REPOSITORY" \
    --title "$ISSUE_TITLE" --label "$ISSUE_LABEL" --body "$BODY" \
    || { echo "::error::Drift found but could not create an issue." >&2; exit 2; }
  echo "Opened a new drift issue."
fi

exit 1
