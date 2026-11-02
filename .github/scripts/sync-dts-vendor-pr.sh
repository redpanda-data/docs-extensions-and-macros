#!/usr/bin/env bash
# Opens, updates, or closes the one pull request that carries a vendor/dts/
# sync. Runs after sync-dts-vendor.js has rewritten vendor/dts/ in the
# checkout, so the working tree holds the result and this script only ships it.
#
# The branch belongs to the workflow and is rebuilt from the base branch on
# every run, so it is force-pushed: a newer sync replaces an older one, and a
# hand commit on that branch would be lost (change the source repo instead).
#
# Exit: 0 nothing to do or PR opened/updated/closed, 2 could not finish.
set -euo pipefail

REPO="${REPO:?REPO is required, for example redpanda-data/docs-extensions-and-macros}"
BASE="${BASE:-main}"
BRANCH="${BRANCH:-ci/sync-dts-vendor}"
VENDOR_DIR="${VENDOR_DIR:-vendor/dts}"
SOURCE_REPO="${SOURCE_REPO:-redpanda-data/docs-team-standards}"
RUN_URL="${RUN_URL:-}"
# fix: so release-please cuts a patch release and the copy reaches npm.
TITLE="fix(vendor): sync Vale styles and page templates from docs-team-standards"

# Fail closed: a gh error must not read as "no PR open".
if ! open_pr=$(gh pr list --repo "$REPO" --head "$BRANCH" --base "$BASE" --state open --json number --jq '.[0].number // empty'); then
  echo "::error::could not list pull requests in $REPO" >&2
  exit 2
fi

# Only the vendored copy may change. Anything else in the tree means the sync
# wrote outside its directory, and shipping that would be worse than failing.
outside=$(git status --porcelain --untracked-files=all | awk '{print $NF}' | grep -v "^${VENDOR_DIR}/" || true)
if [[ -n "$outside" ]]; then
  echo "::error::the sync changed files outside ${VENDOR_DIR}/:" >&2
  printf '%s\n' "$outside" >&2
  exit 2
fi

if [[ -z "$(git status --porcelain --untracked-files=all -- "$VENDOR_DIR")" ]]; then
  echo "${VENDOR_DIR}/ already matches ${SOURCE_REPO}."
  if [[ -n "$open_pr" ]]; then
    # The source went back to what the base branch already has, so the open
    # PR would now ship a stale copy.
    gh pr close "$open_pr" --repo "$REPO" --delete-branch \
      --comment "Closing: ${VENDOR_DIR}/ on ${BASE} already matches ${SOURCE_REPO}.${RUN_URL:+ Run: $RUN_URL}" \
      || { echo "::error::could not close #$open_pr" >&2; exit 2; }
    echo "Closed #$open_pr."
  fi
  exit 0
fi

changes=$(git status --porcelain --untracked-files=all -- "$VENDOR_DIR" | awk '{print "- " $NF}')
commit=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).source.commit)' "$VENDOR_DIR/manifest.json") \
  || { echo "::error::could not read $VENDOR_DIR/manifest.json" >&2; exit 2; }

git checkout -q -B "$BRANCH"
git add -A -- "$VENDOR_DIR"
git commit -q -m "$TITLE" -m "From ${SOURCE_REPO}@${commit}."
git push -q --force origin "HEAD:refs/heads/$BRANCH" || { echo "::error::could not push $BRANCH" >&2; exit 2; }

body="Copies the Vale style and page templates from ${SOURCE_REPO}@${commit} into \`${VENDOR_DIR}/\`. The sync-dts-vendor workflow opened this and replaces it on its next run if the source changes again.

This package is public on npm. Check that nothing here should stay private before merging.

${changes}"

if [[ -n "$open_pr" ]]; then
  gh pr edit "$open_pr" --repo "$REPO" --body "$body" || { echo "::error::could not update #$open_pr" >&2; exit 2; }
  echo "Updated #$open_pr."
else
  gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH" --title "$TITLE" --body "$body" \
    || { echo "::error::could not open the pull request" >&2; exit 2; }
fi
