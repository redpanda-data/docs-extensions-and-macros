#!/usr/bin/env bash
#
# Build the LOCAL, token-free macro showcase and report what the prop and
# enterprise macros produced. Same fixtures macro-test.sh checks, minus the
# real docs/cloud-docs/redpanda-labs/rp-connect-docs sources, so this builds
# in seconds with nothing but this checkout -- the fast path for showing or
# teaching the macros themselves. Run macro-test.sh instead when you need the
# fixtures proven against real production content too.
#
#   ./scripts/macro-showcase.sh                  build, then report
#   ./scripts/macro-showcase.sh --report-only    report on the last build
#   ./scripts/macro-showcase.sh --serve          build, report, then serve
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

PLAYBOOK=local-macro-showcase-playbook.yml
OUT=macro-showcase-out
LOG=macro-showcase.log
SERVE=0
BUILD=1

for arg in "$@"; do
  case "$arg" in
    --report-only) BUILD=0 ;;
    --serve) SERVE=1 ;;
    -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ $BUILD -eq 1 ]]; then
  echo "building ($PLAYBOOK) ..."
  npx antora --fetch "$PLAYBOOK" > "$LOG" 2>&1
  status=$?
  if [[ $status -ne 0 ]]; then
    echo "BUILD FAILED (exit $status). Last lines of $LOG:" >&2
    tail -20 "$LOG" >&2
    exit $status
  fi
  echo "built into $OUT/"
fi

[[ -d $OUT ]] || { echo "no build output at $OUT; run without --report-only" >&2; exit 1; }

if [[ -f $LOG ]] && grep -qE '"level":"fatal"|^\[[0-9:.]+\][[:space:]]+FATAL ' "$LOG"; then
  echo "WARNING: the last build logged a fatal error, so $OUT/ may be stale:" >&2
  grep -oE '"level":"fatal"[^}]*"msg":"[^"]{0,140}|^\[[0-9:.]+\][[:space:]]+FATAL .{0,140}' "$LOG" | tail -2 >&2
  echo >&2
fi

hr() { printf '%s\n' "------------------------------------------------------------"; }
count() { grep -Ec "$1" "$LOG" 2>/dev/null | head -1; }

hr; echo "DIAGNOSTICS  ($LOG)"; hr
printf '  %-42s %s\n' "unknown property name"             "$(count 'is not in the property data')"
printf '  %-42s %s\n' "unavailable for this audience"     "$(count 'is not available in the')"
printf '  %-42s %s\n' "enterprise: unreleased on release" "$(count 'is marked status: unreleased')"
printf '  %-42s %s\n' "enterprise: since-gated feature"   "$(count 'is marked since:')"
printf '  %-42s %s\n' "enterprise: unknown feature"       "$(count 'does not match any feature in the enterprise features registry')"

hr; echo "FIXTURE ASSERTIONS"; hr
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FIXTURE_FAIL=1; }
FIXTURE_FAIL=0
has() { grep -rqsE "$2" "$1" 2>/dev/null; }

GA=$OUT/macro-fixtures/26.2/index.html
BETA=$OUT/macro-fixtures/26.3/index.html
CLOUD=$OUT/macro-fixtures-cloud/index.html
REL=$OUT/preview/release-status-test/index.html

# 1. status: unreleased -- gated on the released version, not on the beta one.
if has "$BETA" 'badge--unreleased'; then
  ok "enterprise: unreleased feature badged on the prerelease version (26.3)"
else bad "enterprise: unreleased feature not badged on the prerelease version"; fi
if has "$GA" 'badge--unreleased'; then
  bad "enterprise: unreleased feature rendered on the RELEASED version (26.2)"
else ok "enterprise: unreleased feature gated on the released version (26.2)"; fi
if has "$REL" 'badge--unreleased'; then
  bad "enterprise: unreleased feature rendered on release-status-test"
else ok "enterprise: unreleased feature also gated on release-status-test"; fi

# 2. since: '26.3' -- gated on 26.2 (predates it), shipped plain on 26.3.
if has "$GA" 'class="enterprise-feature"[^>]*>Preview Since-Gated Feature'; then
  bad "enterprise: since-gated feature styled on 26.2 (predates its since version)"
else ok "enterprise: since-gated feature gated on 26.2 (predates its since version)"; fi
if has "$BETA" 'class="enterprise-feature"[^>]*>(<a[^>]*>)?Preview Since-Gated Feature'; then
  ok "enterprise: since-gated feature styled on 26.3 (at its since version)"
else bad "enterprise: since-gated feature not styled on 26.3"; fi
if has "$BETA" 'enterprise-feature"[^>]*>(<a[^>]*>)?Preview Since-Gated Feature(</a>)?</span> <span class="badge'; then
  bad "enterprise: since-gated feature carries a badge on 26.3 (it is plain GA there)"
else ok "enterprise: since-gated feature carries no badge on 26.3"; fi

# 3. status: beta -- styled everywhere, badged either side of the version split.
if has "$GA" 'badge--beta' && has "$BETA" 'badge--beta'; then
  ok "enterprise: beta feature badged on both the released and prerelease versions"
else bad "enterprise: beta feature not badged on both versions"; fi

# 4. Cloud: cloud_supported gates a cluster property; scope-only properties don't.
if has "$CLOUD" 'data-property-name="iceberg_enabled"'; then
  ok "cloud: a cloud_supported cluster property is marked"
else bad "cloud: cloud_supported cluster property was not marked"; fi
if has "$CLOUD" '<code>log_segment_size</code>'; then
  ok "cloud: a non-cloud_supported cluster property renders plain"
else bad "cloud: non-cloud_supported cluster property was not gated"; fi

[[ $FIXTURE_FAIL -eq 0 ]] && echo "  all fixture assertions passed" || echo "  SOME FIXTURE ASSERTIONS FAILED"

echo
echo "full log: $LOG      site: $OUT/"
echo "start here: $OUT/preview/macros-course/index.html"
echo "then compare: $OUT/macro-fixtures/26.2/ (released) vs $OUT/macro-fixtures/26.3/ (beta)"

[[ $FIXTURE_FAIL -eq 0 ]] || exit 1

if [[ $SERVE -eq 1 ]]; then
  echo "serving $OUT on http://localhost:5300 (ctrl-c to stop)"
  npx wds --node-resolve --root-dir "$OUT" --port 5300 --open /
fi
