#!/usr/bin/env bash
#
# Build the macro test site and report what the prop and enterprise macros
# actually produced.
#
#   ./scripts/macro-test.sh                  build, then report
#   ./scripts/macro-test.sh --report-only    report on the last build
#   ./scripts/macro-test.sh --serve          build, report, then serve on :5002
#
# Point at local checkouts instead of the PR branches:
#   DOCS_DIR=~/Documents/docs CLOUD_DOCS_DIR=~/Documents/cloud-docs ./scripts/macro-test.sh
#
# A private repo needs credentials for the remote sources. Either export
# REDPANDA_GITHUB_TOKEN, or pass --git-credentials-path to antora yourself.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

PLAYBOOK=local-macro-test-playbook.yml
OUT=macro-test-out
LOG=macro-test.log
SERVE=0
BUILD=1

for arg in "$@"; do
  case "$arg" in
    --report-only) BUILD=0 ;;
    --serve) SERVE=1 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Swap the remote sources for local checkouts when asked. Written to a generated
# playbook so the committed one stays untouched.
if [[ -n "${DOCS_DIR:-}${CLOUD_DOCS_DIR:-}" ]]; then
  PLAYBOOK=.macro-test-local-playbook.yml
  python3 - "${DOCS_DIR:-}" "${CLOUD_DOCS_DIR:-}" <<'PY' > "$PLAYBOOK"
import re, sys, pathlib
docs, cloud = sys.argv[1], sys.argv[2]
text = pathlib.Path('local-macro-test-playbook.yml').read_text()

def repoint(text, repo, local):
    """Point every source for `repo` at a local checkout, whatever its branches."""
    pattern = re.compile(
        r'^(  - url: https://github\.com/redpanda-data/' + re.escape(repo) + r')\n(    branches:.*)$',
        re.M)
    return pattern.sub(lambda m: f'  - url: {local}\n    branches: HEAD', text)

if docs:
    text = repoint(text, 'docs', docs)
if cloud:
    text = repoint(text, 'cloud-docs', cloud)
sys.stdout.write(text)
PY
  echo "using local checkouts via $PLAYBOOK"
  grep -A1 '^  - url:' "$PLAYBOOK" | grep -E 'url:|branches:' | sed 's/^/  /'
fi

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

hr() { printf '%s\n' "------------------------------------------------------------"; }
count() { grep -Ec "$1" "$LOG" 2>/dev/null | head -1; }

hr; echo "DIAGNOSTICS  ($LOG)"; hr
printf '  %-42s %s\n' "unknown property name"            "$(count 'is not in the property data')"
printf '  %-42s %s\n' "unavailable for this audience"    "$(count 'is not available in the')"
printf '  %-42s %s\n' "no property data for the series"  "$(count 'publishes no redpanda-properties')"
printf '  %-42s %s\n' "no property data at all"          "$(count 'no redpanda-properties-<tag>.json attachment')"
printf '  %-42s %s\n' "cloud found only prereleases"     "$(count 'found only prerelease property data')"
printf '  %-42s %s\n' "published nowhere (link=true)"    "$(count 'renders without a link')"
printf '  %-42s %s\n' "unusable property JSON"           "$(count 'is not valid JSON\|no usable .properties. object')"
printf '  %-42s %s\n' "two declared property sources"    "$(count 'claimed by two declared property sources')"
printf '  %-42s %s\n' "index built after conversion"     "$(count 'after conversion started')"
printf '  %-42s %s\n' "enterprise: unreleased on release" "$(count 'is marked status: unreleased')"
printf '  %-42s %s\n' "enterprise: unknown feature"      "$(count 'does not match any enterprise feature')"
printf '  %-42s %s\n' "enterprise: bad registry status"  "$(count 'is not one of ga, beta, unreleased')"

hr; echo "RENDERED OUTPUT PER COMPONENT"; hr
for comp in "$OUT"/*/; do
  name=$(basename "$comp")
  case "$name" in _|assets|search|sitemap*|*.html|*.xml|*.json|*.txt) continue ;; esac
  marked=$(grep -rho 'class="property-ref"' "$comp" 2>/dev/null | wc -l | tr -d ' ')
  plain=$(grep -rhoE '<code>[a-z_][a-z0-9_.]*</code>' "$comp" 2>/dev/null | wc -l | tr -d ' ')
  linked=$(grep -rhoE '<code class="property-ref"[^>]*><a ' "$comp" 2>/dev/null | wc -l | tr -d ' ')
  ent=$(grep -rho 'class="enterprise-feature"' "$comp" 2>/dev/null | wc -l | tr -d ' ')
  badge=$(grep -rhoE 'badge--(beta|unreleased)' "$comp" 2>/dev/null | sort | uniq -c | tr '\n' ' ')
  printf '  %-22s marked=%-6s linked=%-6s plain-code=%-6s enterprise=%-5s %s\n' \
    "$name" "$marked" "$linked" "$plain" "$ent" "$badge"
done

hr; echo "WHERE PROPERTY TOOLTIPS POINT (unique targets per component)"; hr
for comp in "$OUT"/*/; do
  name=$(basename "$comp")
  urls=$(grep -rhoE 'data-doc-url="[^"#]+' "$comp" 2>/dev/null | sed 's/data-doc-url="//' | sort -u)
  [[ -z "$urls" ]] && continue
  echo "  $name:"
  printf '%s\n' "$urls" | sed 's/^/     /'
done

hr; echo "PROPERTIES RENDERED AS PLAIN CODE (unavailable or unverified)"; hr
grep -oE "prop:[^ ]+\[\][^:]*: '[^']+' is (not available|not in)" "$LOG" 2>/dev/null \
  | sed -E "s/prop:([^[]+).*is (not available|not in).*/  \1  (\2)/" | sort -u | head -25
echo
hr; echo "FIXTURE ASSERTIONS (the paths real content cannot reach)"; hr
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FIXTURE_FAIL=1; }
FIXTURE_FAIL=0
has() { grep -rqs "$2" "$1" 2>/dev/null; }

F=$OUT/macro-fixtures/26.3/index.html
C=$OUT/macro-fixtures-cloud/index.html
R=$OUT/preview/release-status-test/index.html

# 1. page-property-source declarations actually resolve links.
if has "$OUT/preview" 'data-doc-url="[^"]*preview/reference/properties/cluster-properties'; then
  ok "declarations resolve: preview links land on the declared page"
else bad "declarations did not resolve to the declared reference page"; fi

# 2. A prerelease version validates against its own release candidate.
if has "$F" 'data-property-name="iceberg_delete_orphans_enabled"'; then
  ok "prerelease uses its RC dataset (RC-only property is marked)"
else bad "prerelease did not validate against its RC dataset"; fi

# 3. Cloud ignores the RC and gates on cloud_supported.
if has "$C" 'data-property-name="iceberg_enabled"'; then
  ok "cloud: a cloud_supported property is marked"
else bad "cloud: cloud_supported property was not marked"; fi
if has "$C" '<code>log_segment_size</code>'; then
  ok "cloud: a non-cloud_supported property renders plain"
else bad "cloud: non-cloud_supported property was not gated"; fi
if has "$C" 'data-property-name="iceberg_delete_orphans_enabled"'; then
  bad "cloud validated against the release candidate (must use GA only)"
else ok "cloud ignores the release candidate (RC-only property not marked)"; fi

# 4. Enterprise release status.
if has "$F" 'badge--unreleased'; then
  ok "enterprise: unreleased feature badged on a prerelease page"
else bad "enterprise: unreleased feature not badged on prerelease page"; fi
if has "$R" 'badge--unreleased'; then
  bad "enterprise: unreleased feature rendered on a RELEASED page"
else ok "enterprise: unreleased feature gated on a released page"; fi
if grep -qs 'is marked status: unreleased' "$LOG"; then
  ok "enterprise: the gate reported why"
else bad "enterprise: no diagnostic for the gated mention"; fi
if has "$R" 'badge--beta'; then
  ok "enterprise: beta feature badged on a released page"
else bad "enterprise: beta feature not badged"; fi
[[ $FIXTURE_FAIL -eq 0 ]] && echo "  all fixture assertions passed" || echo "  SOME FIXTURE ASSERTIONS FAILED"

echo "full log: $LOG      site: $OUT/"

if [[ $SERVE -eq 1 ]]; then
  echo "serving $OUT on http://localhost:5002 (ctrl-c to stop)"
  npx wds --node-resolve --root-dir "$OUT" --port 5002 --open /
fi
