'use strict'

const gating = require('../../enterprise-features/detect-gating-changes')
const { makeFinding } = require('../finding')

/**
 * Enterprise license gating, wrapping tools/enterprise-features: values of
 * license_required_feature, config::enterprise<> wrappers and restricted
 * values. That module keeps its own detailed change kinds
 * (enterprise-feature-added, enterprise-gate-removed, ...) and its own
 * CLI; here each of its findings is reshaped to the common kind
 * `enterprise-gated` with the detail kept, and given a severity: losing a
 * gate or changing a restricted value makes the licensing pages wrong
 * (high); a new gate or feature is new work (medium).
 */

const FILES = {
  'enterprise-feature': gating.ENUM_HEADER,
  'enterprise-property': gating.CONFIG_HEADER
}

function detect ({ diffText, readHead, files, excerpt }) {
  const header = readHead ? readHead(gating.CONFIG_HEADER) : null
  const enterpriseNames = header ? gating.enterprisePropertyNames(header) : []
  const found = gating.detectGatingChanges(diffText, { enterpriseNames })
  return found.map((f) => {
    const file = f.change_kind === 'enterprise-restricted-value-changed' ? gating.CONFIG_SOURCE : FILES[f.surface]
    const diffFile = files.find((x) => x.path === file)
    const at = diffFile ? firstChangedLineNaming(diffFile, f.name) : null
    return makeFinding({
      detector: 'enterprise-gating',
      surface: f.surface,
      name: f.name,
      change_kind: 'enterprise-gated',
      severity: /removed|restricted-value-changed/.test(f.change_kind) ? 'high' : 'medium',
      file,
      line: at ? at.line : null,
      evidence: diffFile && at ? excerpt(diffFile, at.side, at.line, at.line) : '',
      page: f.affected_pages[0],
      summary: f.summary,
      detail: f.change_kind
    })
  })
}

function firstChangedLineNaming (file, name) {
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      if (l.sign === '+' && re.test(l.text)) return { side: 'head', line: l.newLine }
    }
  }
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      if (l.sign === '-' && re.test(l.text)) return { side: 'base', line: l.oldLine }
    }
  }
  return null
}

module.exports = { id: 'enterprise-gating', surface: 'enterprise', routes: [/^src\/v\/(?:features\/enterprise_features\.h|config\/configuration\.(?:h|cc))$/], detect, wholeDiff: true }
