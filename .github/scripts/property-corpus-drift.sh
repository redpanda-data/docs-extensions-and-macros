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
# Refreshes rather than blocks. A stale mirror means the corpus test covers
# older data, which is a coverage gap, not a broken build, and failing unrelated
# PRs in this repo over a merge in another one is the wrong trade. It used to
# file an issue and leave the refresh to a person, but the refresh is the
# README recipe run verbatim, so on drift this runs it and opens (or updates)
# one pull request from PR_BRANCH. That PR's own test run is the review: a
# refresh that exposes a real bug goes red there.
#
# Never overwrites someone else's work. A refresh that exposes a bug gets fixed
# on the bot branch itself, so while the PR is open and the branch head is not
# the bot's own commit, this stops pushing and leaves it to whoever is fixing it.
#
# Exit: 0 no drift, 1 drift reported in the refresh PR, 2 could not tell (fetch,
# git or gh failure), 3 drift found but the open refresh PR has someone else's
# commit, so nothing was pushed.
set -euo pipefail

DOCS_REF="${DOCS_REF:-main}"
DOCS_REPO="${DOCS_REPO:-redpanda-data/docs}"
PR_REPO="${PR_REPO:-redpanda-data/docs-extensions-and-macros}"
PR_BASE="${PR_BASE:-main}"
PR_BRANCH="${PR_BRANCH:-bot/refresh-property-corpus}"
PR_LABEL="${PR_LABEL:-documentation}"
# A pull request that updates the corpus is ahead of docs main by design, so a
# PR run reports drift in the log and opens nothing. Only the unattended paths
# (schedule, workflow_dispatch) need a refresh PR, because nobody is looking.
OPEN_PR="${OPEN_PR:-true}"
GIT_REMOTE_URL="${GIT_REMOTE_URL:-https://github.com/${PR_REPO}.git}"
BOT_NAME="${BOT_NAME:-vbotbuildovich}"
BOT_EMAIL="${BOT_EMAIL:-62446873+vbotbuildovich@users.noreply.github.com}"
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
    const [attachmentLive, corpusDir, overridesLive, deriveScript] = process.argv.slice(1);
    const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

    // The same derivation the refresh recipe in
    // tools/property-extractor/README.adoc runs, so a mirror refreshed by
    // following it always matches here. Descriptions are kept only for
    // links-only overrides, decided from the live overrides file.
    const { deriveSnapshot } = require(require("path").resolve(deriveScript));
    const derived = deriveSnapshot(read(attachmentLive), read(overridesLive));
    const mirrorSnapshot = read(`${corpusDir}/property-snapshot.json`);
    if (JSON.stringify(derived) === JSON.stringify(mirrorSnapshot.properties)) process.exit(0);

    const liveKeys = Object.keys(derived);
    const mirrorKeys = Object.keys(mirrorSnapshot.properties || {});
    process.stdout.write(`- \`property-snapshot.json\`: ${liveKeys.length} properties live, ${mirrorKeys.length} in the mirror`
      + (liveKeys.length === mirrorKeys.length ? " (same count, so the difference is in the field values)" : ""));
  ' "$tmp/attachment.json" "$CORPUS_DIR" "$tmp/overrides.json" "${BASH_SOURCE[0]%/*}/derive-property-snapshot.js")"; then
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

if [ "$OPEN_PR" != "true" ]; then
  echo "Not opening a refresh PR (OPEN_PR=$OPEN_PR). The drift is above."
  exit 1
fi

# The tag docs main is actually on: the highest version among the attachments
# there now, the same discovery as the README recipe. An old RC/beta cycle's
# last file, if one is still sitting there, sorts lower and is skipped.
if ! LATEST_TAG="$(gh api "repos/${DOCS_REPO}/contents/modules/reference/attachments?ref=${DOCS_REF}" --jq '.[].name' 2>/dev/null \
    | grep -oE '^redpanda-properties-v[0-9]+\.[0-9]+\.[0-9]+[^.]*\.json$' \
    | sed -E 's/^redpanda-properties-(.*)\.json$/\1/' \
    | sort -V | tail -1)" || [ -z "$LATEST_TAG" ]; then
  echo "::error::Drift found but could not find a redpanda-properties-<tag>.json attachment on ${DOCS_REPO}@${DOCS_REF} to refresh against." >&2
  exit 2
fi

fetch "modules/reference/attachments/redpanda-properties-${LATEST_TAG}.json" "$tmp/latest-attachment.json"

if ! REPO_DIR="$(git -C "$CORPUS_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
  echo "::error::${CORPUS_DIR} is not inside a git checkout, so the refresh cannot be committed." >&2
  exit 2
fi

# The README recipe: a byte copy of the overrides, and the snapshot re-derived
# from the latest attachment with its _comment kept.
cp "$tmp/overrides.json" "${CORPUS_DIR}/property-overrides.json"
if ! node -e '
  const fs = require("fs");
  const [attachment, overrides, snapshotPath, tag, deriveScript] = process.argv.slice(1);
  const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
  const { deriveSnapshot } = require(require("path").resolve(deriveScript));
  const out = read(snapshotPath);
  out.properties = deriveSnapshot(read(attachment), read(overrides));
  out.source_tag = tag;
  fs.writeFileSync(snapshotPath, JSON.stringify(out, null, 1) + "\n");
' "$tmp/latest-attachment.json" "$tmp/overrides.json" "${CORPUS_DIR}/property-snapshot.json" "$LATEST_TAG" \
    "${BASH_SOURCE[0]%/*}/derive-property-snapshot.js"; then
  echo "::error::Drift found but re-deriving property-snapshot.json failed." >&2
  exit 2
fi

# The bot token reaches git through GIT_CONFIG_* for one command at a time, so
# it is never in argv and never written to .git/config. Only for github.com:
# the tests push to a local bare repo.
git_remote() {
  if [ -n "${GH_TOKEN:-}" ] && [[ "$GIT_REMOTE_URL" == https://github.com/* ]]; then
    local auth
    auth="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=http.https://github.com/.extraheader \
    GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth" \
      git -C "$REPO_DIR" "$@"
  else
    git -C "$REPO_DIR" "$@"
  fi
}

CORPUS_FILES=("${CORPUS_DIR}/property-overrides.json" "${CORPUS_DIR}/property-snapshot.json")
TITLE="test(property-extractor): refresh the overrides corpus to docs main and ${LATEST_TAG}"

# Looked up first: the authorship guard below only applies while a PR is open.
EXISTING="$(gh pr list --repo "$PR_REPO" --head "$PR_BRANCH" --state open \
  --json number --jq '.[0].number // empty')" || {
    echo "::error::Drift found but could not list pull requests in ${PR_REPO}." >&2
    exit 2
  }

# ls-remote exits 2 for "no such branch" and anything else for a real failure,
# which must not read as "no branch yet" and force-push over one.
PUSH=true
rc=0
git_remote ls-remote --exit-code --heads "$GIT_REMOTE_URL" "$PR_BRANCH" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  git_remote fetch --quiet "$GIT_REMOTE_URL" "refs/heads/${PR_BRANCH}" \
    || { echo "::error::Drift found but could not fetch ${PR_BRANCH}." >&2; exit 2; }
  HEAD_AUTHOR="$(git -C "$REPO_DIR" log -1 --format=%ae FETCH_HEAD)"
  if [ "$HEAD_AUTHOR" != "$BOT_EMAIL" ]; then
    # A closed PR's branch survives (GitHub deletes only on merge), and
    # nobody is working on it, so rebuild it rather than stall every week.
    if [ -n "$EXISTING" ]; then
      echo "::warning::${PR_BRANCH} has a commit from ${HEAD_AUTHOR}, so someone is working on ${PR_REPO}#${EXISTING}. Not pushing over it." >&2
      exit 3
    fi
    echo "${PR_BRANCH} has a commit from ${HEAD_AUTHOR} but no open pull request, so rebuilding it."
  elif git -C "$REPO_DIR" diff --quiet FETCH_HEAD -- "${CORPUS_FILES[@]}"; then
    echo "${PR_BRANCH} already holds this refresh."
    PUSH=false
  fi
elif [ "$rc" -ne 2 ]; then
  echo "::error::Drift found but could not read ${PR_BRANCH} from ${GIT_REMOTE_URL}." >&2
  exit 2
fi

if [ "$PUSH" = "true" ]; then
  # Rebuilt from the checked-out base every time, so the PR never falls behind it.
  if ! { git -C "$REPO_DIR" checkout --quiet -B "$PR_BRANCH" \
      && git -C "$REPO_DIR" add -- "${CORPUS_FILES[@]}" \
      && git -C "$REPO_DIR" -c user.name="$BOT_NAME" -c user.email="$BOT_EMAIL" commit --quiet -m "$TITLE" \
      && git_remote push --quiet --force "$GIT_REMOTE_URL" "HEAD:refs/heads/${PR_BRANCH}"; }; then
    echo "::error::Drift found but could not commit and push the refresh to ${PR_BRANCH}." >&2
    exit 2
  fi
  echo "Pushed the refresh to ${PR_BRANCH}."
fi

BODY="$(cat <<EOF
The property test corpus in \`${CORPUS_DIR}\` had fallen behind
[${DOCS_REPO}@${DOCS_REF}](https://github.com/${DOCS_REPO}/tree/${DOCS_REF}/docs-data):

${DRIFT}

This refreshes both files with the recipe in
\`tools/property-extractor/README.adoc\` ("The live overrides corpus"): a copy
of \`docs-data/property-overrides.json\`, and the snapshot re-derived from
\`redpanda-properties-${LATEST_TAG}.json\`.

If the property-extractor tests fail here, the refresh has exposed a real bug.
Push the fix to this branch. The weekly job stops updating the branch once its
head is not a commit by the bot.

Opened by \`.github/workflows/property-corpus-drift.yml\`, which updates this
PR on later runs rather than opening another.
EOF
)"

if [ -n "$EXISTING" ]; then
  gh pr edit "$EXISTING" --repo "$PR_REPO" --title "$TITLE" --body "$BODY" >/dev/null \
    || { echo "::error::Drift found but could not update ${PR_REPO}#${EXISTING}." >&2; exit 2; }
  echo "Updated existing pull request ${PR_REPO}#${EXISTING}."
else
  gh pr create --repo "$PR_REPO" --base "$PR_BASE" --head "$PR_BRANCH" \
    --title "$TITLE" --label "$PR_LABEL" --body "$BODY" \
    || { echo "::error::Drift found but could not open a pull request in ${PR_REPO}." >&2; exit 2; }
  echo "Opened a pull request in ${PR_REPO}."
fi
exit 1
