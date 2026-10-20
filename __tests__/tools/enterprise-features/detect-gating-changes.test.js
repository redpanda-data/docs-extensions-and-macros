'use strict'

const fs = require('fs')
const path = require('path')
const {
  detectGatingChanges,
  buildDocImpact,
  enterprisePropertyNames,
  ENUM_HEADER,
  CONFIG_HEADER,
  CONFIG_SOURCE
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
    // Exactly one page: the docs-site receiver treats a finding sharing two
    // or more page topics with an open ticket as the same work, so a second
    // page here would merge every gating finding into the first ticket.
    expect(findings[0].affected_pages).toHaveLength(1)
    expect(findings[0].summary).toMatch(/disable-enterprise-features/)
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
    expect(detectGatingChanges(diff, { enterpriseNames: ['features_auto_finalization'] })).toEqual([])
  })

  const headerDiff = (hunkLines) => [
    `diff --git a/${CONFIG_HEADER} b/${CONFIG_HEADER}`,
    `--- a/${CONFIG_HEADER}`,
    `+++ b/${CONFIG_HEADER}`,
    '@@ -590,7 +590,8 @@ struct configuration final : public config_store {',
    ...hunkLines,
    ''
  ].join('\n')

  test('a declaration that wraps across lines is read whole', () => {
    // clang-format splits these three in configuration.h at v26.2.4.
    const diff = headerDiff([
      '     property<bool> enable_rack_awareness;',
      '+    enterprise<property<std::vector<config::sasl_mechanisms_override>>>',
      '+      sasl_mechanisms_overrides;',
      '+    enterprise<enum_property<model::partition_autobalancing_mode>>',
      '+      partition_autobalancing_mode;',
      '+    enterprise<',
      '+      enum_property<pandaproxy::schema_registry::schema_id_validation_mode>>',
      '+      enable_schema_id_validation;',
      '     property<bool> core_balancing_on_core_count_change;'
    ])
    expect(detectGatingChanges(diff).map((f) => [f.change_kind, f.name])).toEqual([
      ['enterprise-gate-added', 'enable_schema_id_validation'],
      ['enterprise-gate-added', 'partition_autobalancing_mode'],
      ['enterprise-gate-added', 'sasl_mechanisms_overrides']
    ])
  })

  test('wrapping only the type line of a split declaration is a gate added', () => {
    const diff = headerDiff([
      '-    enum_property<model::partition_autobalancing_mode>',
      '+    enterprise<enum_property<model::partition_autobalancing_mode>>',
      '       partition_autobalancing_mode;',
      '     property<std::chrono::seconds>'
    ])
    expect(detectGatingChanges(diff).map((f) => [f.change_kind, f.name])).toEqual([['enterprise-gate-added', 'partition_autobalancing_mode']])
  })

  test('an unchanged split declaration in the context is not reported', () => {
    const diff = headerDiff([
      '     enterprise<enum_property<model::partition_autobalancing_mode>>',
      '       partition_autobalancing_mode;',
      '-    property<bool> core_balancing_on_core_count_change;',
      '+    property<bool> core_balancing_on_core_count_changes;'
    ])
    expect(detectGatingChanges(diff)).toEqual([])
  })

  test('a declaration never absorbs the comment, access specifier or brace before it', () => {
    const header = [
      'struct configuration final : public config_store {',
      'public:',
      '    // enables rack aware replica assignment',
      '    enterprise<property<bool>> audit_enabled; // gated',
      '    enterprise<',
      '      enum_property<pandaproxy::schema_registry::schema_id_validation_mode>>',
      '      enable_schema_id_validation;',
      '    property<bool> enable_rack_awareness;',
      '};'
    ].join('\n')
    expect(enterprisePropertyNames(header)).toEqual(['audit_enabled', 'enable_schema_id_validation'])
  })

  test('affected pages use the canonical /streaming/current/ URLs', () => {
    const diff = headerDiff(['+    enterprise<property<bool>> audit_enabled;'])
    const report = buildDocImpact(detectGatingChanges(diff))
    expect(report.findings[0].affected_pages).toEqual(['https://docs.redpanda.com/streaming/current/get-started/licensing/overview/'])
    expect(report.proposed_ticket.body).toMatch('https://docs.redpanda.com/streaming/current/get-started/licensing/disable-enterprise-features/')
    expect(JSON.stringify(report)).not.toMatch('https://docs.redpanda.com/current/')
  })
})

describe('detectGatingChanges: restricted values in configuration.cc', () => {
  const ENTERPRISE = ['audit_enabled', 'http_authentication', 'partition_autobalancing_mode']
  const sourceDiff = (hunkLines) => [
    `diff --git a/${CONFIG_SOURCE} b/${CONFIG_SOURCE}`,
    `--- a/${CONFIG_SOURCE}`,
    `+++ b/${CONFIG_SOURCE}`,
    '@@ -3440,9 +3440,9 @@ configuration::configuration()',
    ...hunkLines,
    ''
  ].join('\n')
  const kinds = (findings) => findings.map((f) => [f.change_kind, f.name])

  test('a changed restricted value is reported', () => {
    const diff = sourceDiff([
      '   , partition_autobalancing_mode(',
      '       *this,',
      '-      model::partition_autobalancing_mode::continuous,',
      '+      model::partition_autobalancing_mode::node_add,',
      '       model::partition_autobalancing_mode::node_add,',
      '       "partition_autobalancing_mode",',
      '       "Mode of partition balancing for a cluster. * `node_add`: partition "'
    ])
    const findings = detectGatingChanges(diff, { enterpriseNames: ENTERPRISE })
    expect(kinds(findings)).toEqual([['enterprise-restricted-value-changed', 'partition_autobalancing_mode']])
    expect(findings[0].affected_pages).toHaveLength(1)
  })

  test('a hunk that starts after *this still ties the change to its name literal', () => {
    const diff = sourceDiff([
      '-      true, /* restricted values */',
      '+      false, /* restricted values */',
      '       "audit_enabled",',
      '       "Enables or disables audit logging. When you set this to true, Redpanda "'
    ])
    expect(kinds(detectGatingChanges(diff, { enterpriseNames: ENTERPRISE }))).toEqual([['enterprise-restricted-value-changed', 'audit_enabled']])
  })

  test('a restricted string value is not mistaken for the name', () => {
    const diff = sourceDiff([
      '   , http_authentication(',
      '       *this,',
      '-      "OIDC",',
      '+      "oidc",',
      '       "http_authentication",',
      '       "A list of supported HTTP authentication mechanisms.",'
    ])
    expect(kinds(detectGatingChanges(diff, { enterpriseNames: ENTERPRISE }))).toEqual([['enterprise-restricted-value-changed', 'http_authentication']])
  })

  test('a description or default change after the name literal is not a restricted-value change', () => {
    const diff = sourceDiff([
      '   , audit_enabled(',
      '       *this,',
      '       true, /* restricted values */',
      '       "audit_enabled",',
      '-      "Enables or disables audit logging.",',
      '+      "Turns audit logging on or off.",',
      '       meta{.needs_restart = needs_restart::no, .visibility = visibility::user},',
      '-      false)',
      '+      true)'
    ])
    expect(detectGatingChanges(diff, { enterpriseNames: ENTERPRISE })).toEqual([])
  })

  test('a property that is not enterprise<> is never reported', () => {
    const diff = sourceDiff([
      '   , enable_rack_awareness(',
      '       *this,',
      '-      "enable_rack_awareness",',
      '+      "enable_rack_aware",',
      '       "Enable rack-aware replica assignment.",'
    ])
    expect(detectGatingChanges(diff, { enterpriseNames: ENTERPRISE })).toEqual([])
  })

  test('without the enterprise property list, configuration.cc is not checked', () => {
    const diff = sourceDiff([
      '   , audit_enabled(',
      '       *this,',
      '-      true,',
      '+      false,',
      '       "audit_enabled",'
    ])
    expect(detectGatingChanges(diff)).toEqual([])
  })

  test('a property gated in the same PR is reported once, as a gate added', () => {
    const diff = [
      `diff --git a/${CONFIG_HEADER} b/${CONFIG_HEADER}`,
      `--- a/${CONFIG_HEADER}`,
      `+++ b/${CONFIG_HEADER}`,
      '@@ -380,7 +380,7 @@ struct configuration final : public config_store {',
      '-    property<bool> audit_enabled;',
      '+    enterprise<property<bool>> audit_enabled;',
      sourceDiff([
        '   , audit_enabled(',
        '       *this,',
        '+      true, /* restricted values */',
        '       "audit_enabled",'
      ])
    ].join('\n')
    expect(kinds(detectGatingChanges(diff, { enterpriseNames: ENTERPRISE }))).toEqual([['enterprise-gate-added', 'audit_enabled']])
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

  test('the ticket names only the findings it carries and counts the rest', () => {
    // The receiver dedupes on finding names, so a ticket that names a change
    // the findings leave out can never be matched to an open ticket.
    const many = Array.from({ length: 12 }, (_, i) => ({
      surface: 'enterprise-feature', name: `feat_${i}`, change_kind: 'enterprise-feature-added', affected_pages: [], summary: 's'
    }))
    const { proposed_ticket: t } = buildDocImpact(many)
    for (const dropped of ['feat_10', 'feat_11']) {
      expect(t.title).not.toContain(dropped)
      expect(t.body).not.toContain(dropped)
    }
    expect(t.title).toMatch(/feat_9 and 2 more$/)
    expect(t.body).toMatch(/^- 2 more gating change\(s\) are not listed here/m)
  })
})
