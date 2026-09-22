#!/usr/bin/env bash
# Reports when the property test corpus has fallen behind the docs repo.
#
# __tests__/docs-data/property-overrides.json and property-snapshot.json are
# mirrors of redpanda-data/docs. The corpus test renders the real overrides
# file rather than a fixture, because a fixture passes while the live corpus
# breaks; that only holds while the mirror is current.
#
# It has gone stale before: the overrides mirror sat three months and 114
# entries behind, because it doubled as one test's fixture and refreshing it
# would have broken that test. The fixture is separate now, so the remaining
# failure mode is nobody remembering. Hence a schedule rather than a PR check:
# an overrides change lands in the docs repo with no file change here at all,
# so no PR-triggered check in this repo would ever see it.
#
# Reports rather than blocks. A stale mirror means the corpus test covers older
# data, which is a coverage gap, not a broken build, and failing unrelated PRs
# in this repo over a merge in another one is the wrong trade.
#
# Exit: 0 no drift, 1 drift reported, 2 could not tell (fetch or gh failure).
set -euo pipefail

DOCS_REF="${DOCS_REF:-main}"
DOCS_REPO="${DOCS_REPO:-redpanda-data/docs}"
ISSUE_REPO="${ISSUE_REPO:-redpanda-data/docs-extensions-and-macros}"
# A pull request that updates the corpus is ahead of docs main by design, so a
# PR run reports drift in the log and files nothing. Only the unattended paths
# (schedule, workflow_dispatch) need an issue, because nobody is looking.
FILE_ISSUE="${FILE_ISSUE:-true}"
ISSUE_TITLE="${ISSUE_TITLE:-Property test corpus has fallen behind redpanda-data/docs}"
ISSUE_LABEL="${ISSUE_LABEL:-documentation}"
CORPUS_DIR="${CORPUS_DIR:-__tests__/docs-data}"

if ! command -v gh >/dev/null 2>&1; then
  echo "::error::gh is required: the docs repo is private, so both the fetch and the report go through it." >&2
  exit 2
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# gh api, not curl to raw.githubusercontent: redpanda-data/docs is private, so
# an unauthenticated raw fetch 404s. gh carries GH_TOKEN, and the raw media
# type returns the file body rather than base64 inside a JSON envelope.
#
# Fail closed on a fetch problem. Treating an unreachable docs repo as "no
# drift" would turn this check into a no-op the first time the network hiccuped
# or the token expired, which is the failure it exists to prevent.
fetch() {
  local path="$1" dest="$2"
  if ! gh api "repos/${DOCS_REPO}/contents/${path}?ref=${DOCS_REF}" \
       -H 'Accept: application/vnd.github.raw' > "$dest" 2>/dev/null; then
    echo "::error::Could not fetch ${path} from ${DOCS_REPO}@${DOCS_REF}, so drift could not be determined. The token needs read access to that private repo." >&2
    exit 2
  fi
}

fetch "docs-data/property-overrides.json" "$tmp/overrides.json"

# The tag the snapshot mirrors, read from the corpus itself rather than
# hardcoded, so bumping the tag in one place is enough.
# Exit 2, not 1, when this cannot be read: exit 1 is reserved for "drift found
# and reported". Letting the node failure propagate as 1 made the workflow log
# "drift reported in an issue" on a green run, with no issue filed and no
# comparison having happened.
if ! SOURCE_TAG="$(node -e '
  const fs = require("fs");
  const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!doc.source_tag) { console.error("property-snapshot.json has no source_tag"); process.exit(1); }
  process.stdout.write(doc.source_tag);
' "${CORPUS_DIR}/property-snapshot.json")"; then
  echo "could not read source_tag from ${CORPUS_DIR}/property-snapshot.json" >&2
  exit 2
fi

ATTACHMENT_PATH="modules/reference/attachments/redpanda-properties-${SOURCE_TAG}.json"

# Not the shared fetch(): a 404 here is not "could not tell", it is itself
# drift. docs' own regen renames this file forward on every release (there is
# never more than one live copy per tracked line), so the moment docs moves
# past SOURCE_TAG, the exact file this corpus is pinned to stops existing at
# all -- not "changed", gone. Treating that as exit 2 (inconclusive) is why
# this check could go red every week from here on without ever filing the
# issue that would get someone to refresh the pin: exit 2 never files one.
attachment_err="$tmp/attachment.err"
if gh api "repos/${DOCS_REPO}/contents/${ATTACHMENT_PATH}?ref=${DOCS_REF}" \
     -H 'Accept: application/vnd.github.raw' > "$tmp/attachment.json" 2>"$attachment_err"; then
  ATTACHMENT_STALE=false
elif grep -q "HTTP 404" "$attachment_err"; then
  ATTACHMENT_STALE=true
else
  echo "::error::Could not fetch ${ATTACHMENT_PATH} from ${DOCS_REPO}@${DOCS_REF}, so drift could not be determined. The token needs read access to that private repo. $(cat "$attachment_err")" >&2
  exit 2
fi

# Inconclusive, not clean and not drift, for the same reason as above.
if ! OVERRIDES_DRIFT="$(node -e '
  const fs = require("fs");
  const [overridesLive, corpusDir] = process.argv.slice(1);
  const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

  const liveOverrides = read(overridesLive);
  const mirrorOverrides = read(`${corpusDir}/property-overrides.json`);
  if (JSON.stringify(liveOverrides) === JSON.stringify(mirrorOverrides)) process.exit(0);

  const live = Object.keys(liveOverrides.properties || {});
  const mirror = Object.keys(mirrorOverrides.properties || {});
  const missing = live.filter((k) => !mirror.includes(k));
  const extra = mirror.filter((k) => !live.includes(k));
  let detail = "";
  if (missing.length) detail += `, ${missing.length} missing here`;
  if (extra.length) detail += `, ${extra.length} no longer in the docs repo`;
  if (!detail) {
    // Same keys on both sides, so the difference is inside the entries. Name
    // a few, because "438 live, 438 in the mirror" on its own says nothing.
    const changed = live.filter((k) => JSON.stringify(liveOverrides.properties[k]) !== JSON.stringify(mirrorOverrides.properties[k]));
    detail = ` (same entries, ${changed.length} of them differing in content`
      + (changed.length ? `: ${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", ..." : ""}` : "")
      + ")";
  }
  process.stdout.write(`- \`property-overrides.json\`: ${live.length} entries live, ${mirror.length} in the mirror${detail}`);
' "$tmp/overrides.json" "$CORPUS_DIR")"; then
  echo "the overrides comparison failed to run" >&2
  exit 2
fi

if [ "$ATTACHMENT_STALE" = "true" ]; then
  SNAPSHOT_DRIFT="- \`property-snapshot.json\` pins \`${SOURCE_TAG}\`, but \`${ATTACHMENT_PATH}\` no longer exists on ${DOCS_REPO}@${DOCS_REF} -- docs' regen has renamed that tag's attachment forward since. The corpus cannot be compared against a tag that no longer has a live file; refresh the pin to a current tag."
else
  # The snapshot is a reduction, so re-derive it the same way the refresh
  # instructions in tools/property-extractor/README.adoc do, then compare.
  if ! SNAPSHOT_DRIFT="$(node -e '
    const fs = require("fs");
    const [attachmentLive, corpusDir] = process.argv.slice(1);
    const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

    const keep = ["name","config_scope","type","description","cloud_supported","cloud_editable",
                  "cloud_readonly","cloud_byoc_only","is_deprecated","nullable"];
    const liveProps = read(attachmentLive).properties || {};
    const derived = {};
    for (const [k, v] of Object.entries(liveProps)) {
      derived[k] = Object.fromEntries(keep.filter((f) => f in v).map((f) => [f, v[f]]));
    }
    const mirrorSnapshot = read(`${corpusDir}/property-snapshot.json`);
    if (JSON.stringify(derived) === JSON.stringify(mirrorSnapshot.properties)) process.exit(0);

    const liveKeys = Object.keys(derived);
    const mirrorKeys = Object.keys(mirrorSnapshot.properties || {});
    process.stdout.write(`- \`property-snapshot.json\`: ${liveKeys.length} properties live, ${mirrorKeys.length} in the mirror`
      + (liveKeys.length === mirrorKeys.length ? " (same count, so the difference is in the field values)" : ""));
  ' "$tmp/attachment.json" "$CORPUS_DIR")"; then
    echo "the snapshot comparison failed to run" >&2
    exit 2
  fi
fi

DRIFT="$(printf '%s\n%s' "$OVERRIDES_DRIFT" "$SNAPSHOT_DRIFT" | sed '/^$/d')"

if [ -z "$DRIFT" ]; then
  echo "Property test corpus matches ${DOCS_REPO}@${DOCS_REF}."
  exit 0
fi

echo "Drift found:"
echo "$DRIFT"

BODY="$(cat <<EOF
The property test corpus in \`${CORPUS_DIR}\` no longer matches
[${DOCS_REPO}@${DOCS_REF}](https://github.com/${DOCS_REPO}/tree/${DOCS_REF}/docs-data).

${DRIFT}

\`__tests__/tools/property-extractor/property-corpus-rendering.test.js\` renders
the real overrides file rather than a fixture, so a stale mirror means it is
covering older data than the docs repo actually publishes. Nothing is broken;
the coverage is just behind.

Refresh both files with the commands in
\`tools/property-extractor/README.adoc\` (see "The live overrides corpus"), then
re-run \`npx jest __tests__/tools/property-extractor/\`.

Reported by \`.github/workflows/property-corpus-drift.yml\` for
\`${SOURCE_TAG}\`. This issue is reused, so a later run comments rather than
opening a duplicate.
EOF
)"

if [ "$FILE_ISSUE" != "true" ]; then
  echo "Not filing an issue (FILE_ISSUE=$FILE_ISSUE). The drift is above."
  exit 1
fi

# Title-scoped, so an unrelated open issue that happens to mention the corpus
# does not get commented on instead.
EXISTING="$(gh issue list \
  --repo "$ISSUE_REPO" \
  --state open \
  --search "\"${ISSUE_TITLE}\" in:title" \
  --json number --jq '.[0].number // empty')" || {
    echo "::error::Drift found but could not list issues in ${ISSUE_REPO}." >&2
    exit 2
  }

if [ -n "$EXISTING" ]; then
  gh issue comment "$EXISTING" --repo "$ISSUE_REPO" --body "$BODY" \
    || { echo "::error::Drift found but could not comment on ${ISSUE_REPO}#${EXISTING}." >&2; exit 2; }
  echo "Commented on existing issue ${ISSUE_REPO}#${EXISTING}."
else
  gh issue create --repo "$ISSUE_REPO" \
    --title "$ISSUE_TITLE" --label "$ISSUE_LABEL" --body "$BODY" \
    || { echo "::error::Drift found but could not create an issue in ${ISSUE_REPO}." >&2; exit 2; }
  echo "Opened a new issue in ${ISSUE_REPO}."
fi
exit 1
