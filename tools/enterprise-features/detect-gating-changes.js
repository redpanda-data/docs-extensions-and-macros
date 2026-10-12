'use strict'

/**
 * Finds enterprise gating changes in a Redpanda core diff that no doc string
 * announces, and shapes them as doc-impact findings.
 *
 * The doc-strings review derives its published-content impact from the doc
 * strings a PR changes. Two kinds of change carry no doc string at all and
 * still change what the licensing docs say:
 *
 *   - a value added to (or removed from) `enum class license_required_feature`
 *     in src/v/features/enterprise_features.h: the feature starts (or stops)
 *     being reported by `rpk cluster license info` and
 *     GET /v1/features/enterprise, and the enterprise features registry in
 *     redpanda-data/docs needs an entry under an approved external name;
 *   - a property wrapped in `config::enterprise<>` in
 *     src/v/config/configuration.h: the property becomes (or stops being)
 *     license-gated, so the licensing tables and the disable page change.
 *
 * streaming-enterprise PR 579 (2026-10-07) was the first miss: it added
 * `manual_finalization` to the enum and changed license enforcement, touched
 * no doc string, and so filed nothing. This module reads the diff text only,
 * so a test can hand it a saved patch; the CLI wrapper runs git.
 *
 * Detection is by added and removed lines, paired by name, so a value that
 * merely moves within the enum is not reported. Both signals the header
 * carries for an enum value are used (the member line inside the enum, and
 * the `case license_required_feature::<name>:` line in format_to), so a
 * hunk header that happens not to name the enum still detects.
 *
 * Each finding names ONE affected page, the licensing overview. The docs-site
 * receiver falls back to matching a finding with no name match against open
 * tickets that share at least two page topics, so two gating findings that
 * both listed the overview and the disable page would be treated as one
 * ticket however different the features. The disable page is named in the
 * summary text instead.
 */

const ENUM_HEADER = 'src/v/features/enterprise_features.h'
const CONFIG_HEADER = 'src/v/config/configuration.h'

const LICENSING_OVERVIEW = 'https://docs.redpanda.com/current/get-started/licensing/overview/'
const DISABLE_PAGE = 'https://docs.redpanda.com/current/get-started/licensing/disable-enterprise-features/'
const REGISTRY_URL = 'https://github.com/redpanda-data/docs/blob/main/shared/modules/ROOT/partials/enterprise-features.yml'

/**
 * Split unified diff text into { path, lines[] } per file, where lines are
 * the raw hunk lines (prefixed with ' ', '+', '-') and hunk headers.
 */
function splitFiles (diffText) {
  const files = []
  let current = null
  for (const raw of String(diffText || '').split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw)
    if (m) {
      current = { path: m[2], lines: [] }
      files.push(current)
      continue
    }
    if (!current) continue
    if (/^(\+\+\+|---|index |new file|deleted file|similarity|rename|old mode|new mode)/.test(raw)) continue
    current.lines.push(raw)
  }
  return files
}

/**
 * Enum values added and removed in enterprise_features.h.
 * @returns {{added: string[], removed: string[]}}
 */
function enumChanges (lines) {
  const added = new Set()
  const removed = new Set()
  // The member line only counts inside the enum. Track that from the hunk
  // header and from context lines, both of which git carries in the diff.
  let inEnum = false
  for (const line of lines) {
    if (line.startsWith('@@')) {
      inEnum = /enum class license_required_feature/.test(line)
      continue
    }
    const body = line.slice(1)
    if (/^\s*enum class license_required_feature\b/.test(body)) { inEnum = true; continue }
    if (inEnum && /^\s*};/.test(body)) { inEnum = false; continue }
    const sign = line[0]
    if (sign !== '+' && sign !== '-') continue
    const target = sign === '+' ? added : removed
    const member = inEnum && /^\s*([a-z][a-z0-9_]*)\s*,?\s*(\/\/.*)?$/.exec(body)
    if (member) target.add(member[1])
    const kase = /^\s*case license_required_feature::([a-z][a-z0-9_]*)\s*:/.exec(body)
    if (kase) target.add(kase[1])
  }
  return {
    added: [...added].filter((n) => !removed.has(n)).sort(),
    removed: [...removed].filter((n) => !added.has(n)).sort()
  }
}

/**
 * Properties whose declaration gained or lost the enterprise<> wrapper in
 * configuration.h. A declaration changed in place shows as a -/+ pair with
 * the same name; the wrapper is on exactly one side.
 * @returns {{added: string[], removed: string[]}}
 */
function enterprisePropertyChanges (lines) {
  const wrapped = (body) => /^\s*enterprise<.*>\s+([a-z][a-z0-9_]*)\s*;/.exec(body)
  const added = new Set()
  const removed = new Set()
  for (const line of lines) {
    if (line.startsWith('@@')) continue
    const sign = line[0]
    if (sign !== '+' && sign !== '-') continue
    const m = wrapped(line.slice(1))
    if (!m) continue
    ;(sign === '+' ? added : removed).add(m[1])
  }
  return {
    added: [...added].filter((n) => !removed.has(n)).sort(),
    removed: [...removed].filter((n) => !added.has(n)).sort()
  }
}

/**
 * Detect enterprise gating changes in a diff.
 * @param {string} diffText - unified diff (`git diff base...HEAD`)
 * @returns {Array<{surface: string, name: string, change_kind: string, affected_pages: string[], summary: string}>}
 */
function detectGatingChanges (diffText) {
  const findings = []
  for (const file of splitFiles(diffText)) {
    if (file.path === ENUM_HEADER) {
      const { added, removed } = enumChanges(file.lines)
      for (const name of added) {
        findings.push({
          surface: 'enterprise-feature',
          name,
          change_kind: 'enterprise-feature-added',
          affected_pages: [LICENSING_OVERVIEW],
          summary: `\`${name}\` was added to \`license_required_feature\` in \`${ENUM_HEADER}\`. From the first release that contains this change, \`rpk cluster license info\` and \`GET /v1/features/enterprise\` report it and the license nag names it. The enterprise features registry (${REGISTRY_URL}) needs an entry under the approved external name, with a gating property and, where a property turns it off, a row on ${DISABLE_PAGE}; the weekly registry check fails until it has one. Any page that describes this feature's license behavior needs the new reporting and enforcement.`
        })
      }
      for (const name of removed) {
        findings.push({
          surface: 'enterprise-feature',
          name,
          change_kind: 'enterprise-feature-removed',
          affected_pages: [LICENSING_OVERVIEW],
          summary: `\`${name}\` was removed from \`license_required_feature\` in \`${ENUM_HEADER}\`. The release that contains this change no longer reports it as an enterprise feature. The enterprise features registry entry that points at it (${REGISTRY_URL}) needs a new source pointer or a note, never deletion: a published external name stays in the registry.`
        })
      }
    } else if (file.path === CONFIG_HEADER) {
      const { added, removed } = enterprisePropertyChanges(file.lines)
      for (const name of added) {
        findings.push({
          surface: 'enterprise-property',
          name,
          change_kind: 'enterprise-gate-added',
          affected_pages: [LICENSING_OVERVIEW],
          summary: `\`${name}\` is now wrapped in \`config::enterprise<>\` in \`${CONFIG_HEADER}\`, so a restricted value needs a license from the first release that contains this change. The enterprise features registry (${REGISTRY_URL}) needs an entry that names this property as its source or gating property, and ${DISABLE_PAGE} needs a row for the unrestricted value.`
        })
      }
      for (const name of removed) {
        findings.push({
          surface: 'enterprise-property',
          name,
          change_kind: 'enterprise-gate-removed',
          affected_pages: [LICENSING_OVERVIEW],
          summary: `\`${name}\` is no longer wrapped in \`config::enterprise<>\` in \`${CONFIG_HEADER}\`, so it no longer needs a license. The registry entry that names it (${REGISTRY_URL}) and its row on ${DISABLE_PAGE} need to change.`
        })
      }
    }
  }
  return findings
}

/**
 * Shape findings as the doc-impact report the review workflow dispatches
 * (the same JSON the model writes to doc-impact.json), or null when there is
 * nothing to report.
 */
function buildDocImpact (findings) {
  if (!findings || findings.length === 0) return null
  const names = findings.map((f) => `\`${f.name}\``).join(', ')
  const bullets = findings.map((f) => `- ${f.name} (${f.change_kind}): ${f.summary}`).join('\n')
  return {
    findings: findings.slice(0, 10),
    proposed_ticket: {
      title: `Update enterprise feature docs for ${findings.map((f) => f.name).join(', ')}`,
      body: [
        `This PR changes which features Redpanda gates on an enterprise license, without changing any doc string, so the licensing docs do not pick it up on regeneration: ${names}.`,
        '',
        bullets,
        '',
        `Registry: ${REGISTRY_URL}`,
        `Licensing overview: ${LICENSING_OVERVIEW}`,
        `Disable page: ${DISABLE_PAGE}`,
        '',
        'The change is on the default branch until a release contains it; the docs change belongs to the version branch for that release. Confirm the affected release with the PR author.'
      ].join('\n')
    }
  }
}

module.exports = {
  ENUM_HEADER,
  CONFIG_HEADER,
  detectGatingChanges,
  buildDocImpact,
  enumChanges,
  enterprisePropertyChanges,
  splitFiles
}
