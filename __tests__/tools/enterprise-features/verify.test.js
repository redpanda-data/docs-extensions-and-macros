'use strict'

const {
  parseCoreEnum,
  parseEnterpriseProperties,
  parseConnectEnterprisePlugins,
  parseDisableTable,
  extractAntoraEnterpriseComponents,
} = require('../../../tools/enterprise-features/parsers')

const {
  lintRegistry,
  checkCoreEnum,
  checkConnect,
  buildMappingPartial,
  runChecks,
} = require('../../../tools/enterprise-features/verify')

const CORE_HEADER = `
namespace features {

enum class license_required_feature {
    audit_logging,
    cloud_storage,
    partition_auto_balancing_continuous, // core comment
    fips,
};

std::ostream& operator<<(std::ostream&, license_required_feature);
}
`

const CONFIGURATION_HEADER = `
struct configuration final : public config_store {
    enterprise<property<bool>> audit_enabled;
    property<bool> not_enterprise;
    enterprise<enum_property<model::partition_autobalancing_mode>>
      partition_autobalancing_mode;
    enterprise<property<std::vector<config::sasl_mechanisms_override>>>
      sasl_mechanisms_override;
};
`

// The real header has spaces after the commas.
const INFO_CSV = `name, type, commercial_name, support, deprecated, cloud, cloud_with_gpu, cloud_unsupported_reason
iceberg,output,Apache Iceberg,enterprise,n,y,n,
kafka,input,Kafka,certified,n,y,n,
gateway,input,Gateway,enterprise,n,n,n,"not, supported"
`

const DISABLE_PAGE = `
= Disable enterprise features

[cols="1a,1a"]
|===
| Feature | Action to Disable

| xref:manage:audit-logging.adoc[Audit Logging]
| Set \`audit_enabled\` to \`false\`, reverting to \`node_add\` behavior: rpk cluster config set audit_enabled false

| xref:manage:tiered-storage.adoc[Tiered Storage]
| Run: rpk cluster config set cloud_storage_enabled false
|===
`

const REGISTRY = `
schema-version: 1
features:
  - name: Audit Logging
    scope: redpanda
    xref: manage:audit-logging.adoc
    description: |
      Records logs.
    source:
      kind: core-enum
      value: audit_logging
    gating-property: audit_enabled
  - name: Tiered Storage
    scope: redpanda
    xref: manage:tiered-storage.adoc
    description: |
      Object storage.
    aliases: [cloud_storage]
    source:
      kind: core-enum
      value: cloud_storage
    gating-property: cloud_storage_enabled
  - name: Continuous Data Balancing
    scope: redpanda
    description: |
      Balances partitions.
    source:
      kind: core-enum
      value: partition_auto_balancing_continuous
    gating-property: partition_autobalancing_mode
  - name: FIPS Compliance
    scope: redpanda
    description: |
      FIPS.
    source:
      kind: core-enum
      value: fips
`

describe('enterprise-features parsers', () => {
  test('parseCoreEnum extracts enum values and ignores comments', () => {
    expect(parseCoreEnum(CORE_HEADER)).toEqual([
      'audit_logging', 'cloud_storage', 'partition_auto_balancing_continuous', 'fips',
    ])
  })

  test('parseCoreEnum throws when the enum is missing', () => {
    expect(() => parseCoreEnum('int x;')).toThrow(/Could not find enum/)
  })

  test('parseEnterpriseProperties handles single and multi-line declarations', () => {
    expect(parseEnterpriseProperties(CONFIGURATION_HEADER)).toEqual([
      'audit_enabled', 'partition_autobalancing_mode', 'sasl_mechanisms_override',
    ])
  })

  test('parseConnectEnterprisePlugins returns only enterprise rows, handling quoted commas', () => {
    expect(parseConnectEnterprisePlugins(INFO_CSV)).toEqual(['iceberg', 'gateway'])
  })

  test('parseDisableTable extracts features and snake_case properties', () => {
    const rows = parseDisableTable(DISABLE_PAGE)
    expect(rows).toEqual([
      { feature: 'Audit Logging', properties: ['audit_enabled'] },
      { feature: 'Tiered Storage', properties: ['cloud_storage_enabled'] },
    ])
  })

  test('extractAntoraEnterpriseComponents reads the attribute list', () => {
    expect(extractAntoraEnterpriseComponents({ asciidoc: { attributes: { 'enterprise-components': ['a', 'b'] } } })).toEqual(['a', 'b'])
    expect(extractAntoraEnterpriseComponents({})).toBeUndefined()
  })
})

describe('enterprise-features checks', () => {
  test('a clean registry produces no drift findings', () => {
    const { findings } = runChecks({
      registryYaml: REGISTRY,
      coreHeader: CORE_HEADER,
      configurationHeader: CONFIGURATION_HEADER,
      disablePage: DISABLE_PAGE,
    })
    const drift = findings.filter((f) => f.level === 'error' || f.level === 'needs-human')
    expect(drift).toEqual([])
  })

  test('lintRegistry flags duplicates, bad scopes, and empty sources', () => {
    const bad = `
features:
  - name: A
    scope: mainframe
    description: |
      x
    source: {kind: manual, value: ok}
  - name: B
    scope: redpanda
    aliases: [a]
    description: |
      x
    source: {kind: manual, value: ''}
  - name: C
    scope: redpanda
    source: {kind: nonsense, value: x}
`
    const { findings } = lintRegistry(bad)
    const messages = findings.map((f) => f.message).join('\n')
    expect(messages).toMatch(/Duplicate name or alias 'a'/)
    expect(messages).toMatch(/unknown scope 'mainframe'/)
    expect(messages).toMatch(/empty source value/)
    expect(messages).toMatch(/unknown source kind 'nonsense'/)
    expect(messages).toMatch(/'C' has no description/)
  })

  test('a new core enum value is reported as needs-human', () => {
    const { features } = lintRegistry(REGISTRY)
    const findings = checkCoreEnum(features, ['audit_logging', 'cloud_storage', 'partition_auto_balancing_continuous', 'fips', 'quantum_topics'])
    expect(findings).toEqual([
      expect.objectContaining({ level: 'needs-human', message: expect.stringContaining("'quantum_topics'") }),
    ])
  })

  test('a registry pointer at a nonexistent enum value is an error', () => {
    const { features } = lintRegistry(REGISTRY)
    const findings = checkCoreEnum(features, ['audit_logging', 'cloud_storage', 'partition_auto_balancing_continuous'])
    expect(findings).toEqual([
      expect.objectContaining({ level: 'error', message: expect.stringContaining("'fips'") }),
    ])
  })

  test('multiple registry entries may share one enum value', () => {
    const shared = `${REGISTRY}
  - name: Remote Read Replicas
    scope: redpanda
    description: |
      RRR.
    source:
      kind: core-enum
      value: cloud_storage
`
    const { features, findings: lintFindings } = lintRegistry(shared)
    expect(lintFindings).toEqual([])
    const findings = checkCoreEnum(features, ['audit_logging', 'cloud_storage', 'partition_auto_balancing_continuous', 'fips'])
    expect(findings).toEqual([])
  })

  test('checkConnect reports contradictions in both directions', () => {
    const findings = checkConnect(['iceberg', 'gateway'], ['iceberg', 'openai_chat_completion'])
    const messages = findings.map((f) => f.message).join('\n')
    expect(messages).toMatch(/'gateway' is enterprise in info.csv but missing/)
    expect(messages).toMatch(/'openai_chat_completion' is in the enterprise-components list .* but not enterprise in info.csv/)
  })

  test('buildMappingPartial renders one row per enum value with all mapped features', () => {
    const registryWithRrr = `${REGISTRY}
  - name: Remote Read Replicas
    scope: redpanda
    xref: manage:remote-read-replicas.adoc
    description: |
      RRR.
    source:
      kind: core-enum
      value: cloud_storage
`
    const { features } = lintRegistry(registryWithRrr)
    const partial = buildMappingPartial(features, ['audit_logging', 'cloud_storage', 'fips'])
    expect(partial).toContain('| audit_logging')
    expect(partial).toContain('xref:manage:audit-logging.adoc[Audit Logging]')
    expect(partial).toContain('xref:manage:tiered-storage.adoc[Tiered Storage]')
    expect(partial).toContain('xref:manage:remote-read-replicas.adoc[Remote Read Replicas]')
    expect(partial.indexOf('audit_logging')).toBeLessThan(partial.indexOf('cloud_storage'))
    expect(partial).toContain('| fips')
  })

  test('runChecks skips missing sources with info findings only', () => {
    const { findings } = runChecks({ registryYaml: REGISTRY })
    expect(findings.filter((f) => f.level === 'error' || f.level === 'needs-human')).toEqual([])
    expect(findings.filter((f) => f.level === 'info').length).toBeGreaterThanOrEqual(3)
  })
})
