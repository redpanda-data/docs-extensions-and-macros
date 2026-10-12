'use strict'

const fs = require('fs')
const path = require('path')
const {
  detectGatingChanges,
  buildDocImpact,
  ENUM_HEADER,
  CONFIG_HEADER
} = require('../../../tools/enterprise-features/detect-gating-changes')

const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'enterprise-gating', name), 'utf8')

// A hand-built diff of the enum header, so each test states exactly which
// lines changed. Context lines are real neighbours from the header.
function enumDiff (hunkLines, { header = 'enum class license_required_feature {' } = {}) {
  return [
    `diff --git a/${ENUM_HEADER} b/${ENUM_HEADER}`,
    'index 1111111..2222222 100644',
    `--- a/${ENUM_HEADER}`,
    `+++ b/${ENUM_HEADER}`,
    `@@ -34,6 +34,7 @@ ${header}`,
    ...hunkLines,
    ''
  ].join('\n')
}

describe('detectGatingChanges: license_required_feature enum', () => {
  test('the PR that was missed (streaming-enterprise 579) yields one added-feature finding', () => {
    // Real hunks from the PR: the enum member and the format_to case.
    const findings = detectGatingChanges(fixture('se-579-enum-added.patch'))
    expect(findings).toEqual([expect.objectContaining({
      surface: 'enterprise-feature',
      name: 'manual_finalization',
      change_kind: 'enterprise-feature-added'
    })])
    expect(findings[0].affected_pages.every((u) => u.startsWith('https://docs.redpanda.com/'))).toBe(true)
    expect(findings[0].summary).toMatch(/rpk cluster license info/)
    expect(findings[0].summary).toMatch(/enterprise-features\.yml/)
  })

  test('a member line counts only inside the enum', () => {
    // Same shape of line in an unrelated enum of the same header.
    const diff = enumDiff(['     shadow_linking,', '+    something_else,', ' };'], { header: 'enum class other_thing {' })
    expect(detectGatingChanges(diff)).toEqual([])
  })

  test('the format_to case line detects on its own, when the enum hunk is absent', () => {
    const diff = [
      `diff --git a/${ENUM_HEADER} b/${ENUM_HEADER}`,
      `--- a/${ENUM_HEADER}`,
      `+++ b/${ENUM_HEADER}`,
      '@@ -64,6 +65,8 @@ inline fmt::iterator format_to(license_required_feature f, fmt::iterator out) {',
      '     case license_required_feature::topic_deletion_disabled:',
      '         return fmt::format_to(out, "topic_deletion_disabled");',
      '+    case license_required_feature::manual_finalization:',
      '+        return fmt::format_to(out, "manual_finalization");',
      '     }',
      ''
    ].join('\n')
    expect(detectGatingChanges(diff).map((f) => f.name)).toEqual(['manual_finalization'])
  })

  test('a removed value is reported as removed', () => {
    const diff = enumDiff(['     shadow_linking,', '-    topic_deletion_disabled,', ' };'])
    expect(detectGatingChanges(diff)).toEqual([expect.objectContaining({
      name: 'topic_deletion_disabled',
      change_kind: 'enterprise-feature-removed'
    })])
  })

  test('a value that only moves within the enum is not reported', () => {
    const diff = enumDiff(['-    shadow_linking,', '     topic_deletion_disabled,', '+    shadow_linking,', ' };'])
    expect(detectGatingChanges(diff)).toEqual([])
  })

  test('the enum closing brace ends the member scan', () => {
    const diff = enumDiff(['     topic_deletion_disabled,', ' };', '+    not_a_member,'])
    expect(detectGatingChanges(diff)).toEqual([])
  })

  test('the same header path in a different directory is ignored', () => {
    const diff = fixture('se-579-enum-added.patch').split(ENUM_HEADER).join(`tests/${ENUM_HEADER}`)
    expect(detectGatingChanges(diff)).toEqual([])
  })
})

describe('detectGatingChanges: config::enterprise<> wrappers', () => {
  test('the commit that gated features_auto_finalization yields one gate-added finding', () => {
    const findings = detectGatingChanges(fixture('se-property-gate-added.patch'))
    expect(findings).toEqual([expect.objectContaining({
      surface: 'enterprise-property',
      name: 'features_auto_finalization',
      change_kind: 'enterprise-gate-added'
    })])
  })

  test('wrapping an existing declaration in place is a gate added, not a rename', () => {
    const diff = [
      `diff --git a/${CONFIG_HEADER} b/${CONFIG_HEADER}`,
      `--- a/${CONFIG_HEADER}`,
      `+++ b/${CONFIG_HEADER}`,
      '@@ -700,7 +700,7 @@ struct configuration final : public config_store {',
      '     property<bool> features_auto_enable;',
      '-    property<bool> features_auto_finalization;',
      '+    enterprise<property<bool>> features_auto_finalization;',
      '     property<bool> fetch_reads_debounce;',
      ''
    ].join('\n')
    expect(detectGatingChanges(diff).map((f) => [f.change_kind, f.name])).toEqual([['enterprise-gate-added', 'features_auto_finalization']])
  })

  test('unwrapping is a gate removed', () => {
    const diff = [
      `diff --git a/${CONFIG_HEADER} b/${CONFIG_HEADER}`,
      `--- a/${CONFIG_HEADER}`,
      `+++ b/${CONFIG_HEADER}`,
      '@@ -700,7 +700,7 @@ struct configuration final : public config_store {',
      '-    enterprise<property<std::vector<ss::sstring>>> sasl_mechanisms_overrides;',
      '+    property<std::vector<ss::sstring>> sasl_mechanisms_overrides;',
      ''
    ].join('\n')
    expect(detectGatingChanges(diff).map((f) => [f.change_kind, f.name])).toEqual([['enterprise-gate-removed', 'sasl_mechanisms_overrides']])
  })

  test('a wrapped declaration that merely moves is not reported', () => {
    const diff = [
      `diff --git a/${CONFIG_HEADER} b/${CONFIG_HEADER}`,
      `--- a/${CONFIG_HEADER}`,
      `+++ b/${CONFIG_HEADER}`,
      '@@ -700,7 +700,7 @@ struct configuration final : public config_store {',
      '-    enterprise<property<bool>> features_auto_finalization;',
      '     property<bool> fetch_reads_debounce;',
      '+    enterprise<property<bool>> features_auto_finalization;',
      ''
    ].join('\n')
    expect(detectGatingChanges(diff)).toEqual([])
  })

  test('a change to configuration.cc alone (descriptions) is not a gating change', () => {
    const diff = [
      'diff --git a/src/v/config/configuration.cc b/src/v/config/configuration.cc',
      '--- a/src/v/config/configuration.cc',
      '+++ b/src/v/config/configuration.cc',
      '@@ -3910,7 +3910,7 @@ configuration::configuration()',
      '   , features_auto_finalization(',
      '-      "Whether the cluster active logical version is advanced automatically",',
      '+      "Whether the cluster active logical version advances automatically",',
      ''
    ].join('\n')
    expect(detectGatingChanges(diff)).toEqual([])
  })
})

describe('buildDocImpact', () => {
  test('nothing to report is null, so the caller writes no file', () => {
    expect(buildDocImpact([])).toBeNull()
    expect(buildDocImpact(undefined)).toBeNull()
  })

  test('the report has the shape the dispatch step validates', () => {
    const report = buildDocImpact(detectGatingChanges(fixture('se-579-enum-added.patch')))
    expect(report.findings).toHaveLength(1)
    expect(typeof report.proposed_ticket.title).toBe('string')
    expect(typeof report.proposed_ticket.body).toBe('string')
    expect(report.proposed_ticket.title).toMatch(/manual_finalization/)
    // Jira renders only backticks, "- " bullets and bare URLs.
    expect(report.proposed_ticket.body).not.toMatch(/\[[^\]]+\]\(https?:/)
    expect(report.proposed_ticket.body).toMatch(/^- manual_finalization \(enterprise-feature-added\)/m)
  })

  test('findings are capped at ten, matching the dispatch schema', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      surface: 'enterprise-feature', name: `f${i}`, change_kind: 'enterprise-feature-added', affected_pages: [], summary: 's'
    }))
    expect(buildDocImpact(many).findings).toHaveLength(10)
  })
})
