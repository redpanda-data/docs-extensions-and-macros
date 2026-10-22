'use strict'

/**
 * The finding shape every detector returns, and the vocabulary it uses.
 *
 * Kinds and severities follow the docs team's docs-gate skill
 * (docs-team-standards/skills/docs-gate/SKILL.md), so a mechanical finding
 * reads the same as one a reviewer would raise:
 *
 *   high    published docs now contradict shipped behaviour: a default,
 *           name or surface the reference states no longer holds
 *           (removed, renamed, default-changed, deprecated, a license gate
 *           removed or its restricted value changed)
 *   medium  a user-facing change with nothing filed yet (added, a new
 *           license gate, a behaviour change such as a new enum value or a
 *           changed restart requirement)
 *   low     the obligation is met but incomplete (a regenerated reference
 *           string changed; the page follows on regeneration)
 *
 * The five fields the doc-impact dispatch schema validates (surface, name,
 * change_kind, affected_pages, summary) are what the docs-site router
 * reads; the rest (severity, file, line, evidence, detector, confidence)
 * ride along for the ticket body and the job summary. `confidence` is
 * always "mechanical": these findings come from the diff, not a model, and
 * the receiver can tell them apart from model-authored ones by it.
 */

const KINDS = ['added', 'removed', 'renamed', 'default-changed', 'deprecated', 'enterprise-gated', 'behaviour']

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 }

function severityFor (changeKind) {
  switch (changeKind) {
    case 'removed':
    case 'renamed':
    case 'default-changed':
    case 'deprecated':
      return 'high'
    case 'low':
      return 'low'
    default:
      return 'medium'
  }
}

const DOCS = 'https://docs.redpanda.com'
const PAGES = {
  clusterProperties: `${DOCS}/streaming/current/reference/properties/cluster-properties/`,
  brokerProperties: `${DOCS}/streaming/current/reference/properties/broker-properties/`,
  rpk: `${DOCS}/streaming/current/reference/rpk/`,
  publicMetrics: `${DOCS}/streaming/current/reference/public-metrics-reference/`,
  internalMetrics: `${DOCS}/streaming/current/reference/internal-metrics-reference/`,
  helm: {
    redpanda: `${DOCS}/streaming/current/reference/k-redpanda-helm-spec/`,
    console: `${DOCS}/streaming/current/reference/k-console-helm-spec/`,
    connectors: `${DOCS}/streaming/current/reference/k-connector-helm-spec/`,
    operator: `${DOCS}/streaming/current/reference/k-operator-helm-spec/`
  },
  reference: `${DOCS}/streaming/current/reference/`,
  crd: `${DOCS}/streaming/current/reference/k-crd/`,
  api: {
    admin: `${DOCS}/api/doc/admin/`,
    controlplane: `${DOCS}/api/doc/cloud-controlplane/`,
    dataplane: `${DOCS}/api/doc/cloud-dataplane/`,
    index: `${DOCS}/api/`
  },
  features: `${DOCS}/streaming/current/reference/rpk/rpk-cluster/rpk-cluster-config/`
}

/**
 * Build one finding. `change_kind` must be one of KINDS; severity defaults
 * from it. Each finding names exactly ONE affected page: the docs-site
 * receiver treats a finding sharing two or more page topics with an open
 * ticket as that ticket's work, so a second page here would merge every
 * finding of a surface into the first ticket filed for it.
 */
function makeFinding ({ detector, surface, name, change_kind: changeKind, severity, file, line, evidence, page, summary, detail }) {
  if (!KINDS.includes(changeKind)) throw new Error(`unknown change_kind ${changeKind}`)
  const finding = {
    surface,
    name,
    change_kind: changeKind,
    severity: severity || severityFor(changeKind),
    file,
    line: line == null ? null : line,
    evidence: evidence || '',
    affected_pages: [page],
    summary,
    detector,
    confidence: 'mechanical'
  }
  if (detail) finding.detail = detail
  return finding
}

function compareFindings (a, b) {
  return (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) ||
    a.surface.localeCompare(b.surface) ||
    String(a.file || '').localeCompare(String(b.file || '')) ||
    ((a.line || 0) - (b.line || 0)) ||
    a.name.localeCompare(b.name)
}

module.exports = { KINDS, SEVERITY_RANK, severityFor, PAGES, makeFinding, compareFindings }
