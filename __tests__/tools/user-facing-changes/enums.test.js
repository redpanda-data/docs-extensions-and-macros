'use strict'

const { detect, kinds } = require('./helpers')
const { configEnumTypes, parseEnums } = require('../../../tools/user-facing-changes/detectors/enums')

const CONFIG_H = 'src/v/config/configuration.h'
const MODEL_H = 'src/v/model/metadata.h'
const FEATURE_TABLE = 'src/v/features/feature_table.h'

// Synthetic headers: a config header naming enum_property types, the
// model header defining one of them plus an internal enum, and a feature
// table. Nothing here is copied from a private repo.
const CONFIG = `#pragma once
namespace config {
struct configuration final : public config_store {
    enum_property<model::partition_autobalancing_mode> partition_autobalancing_mode;
    enterprise<enum_property<pandaproxy::schema_registry::schema_id_validation_mode>>
      enable_schema_id_validation;
    property<bool> enable_rack_awareness;
};
}
`

const MODEL = `#pragma once
namespace model {

// User-settable through partition_autobalancing_mode.
enum class partition_autobalancing_mode {
    off,
    node_add,
    continuous, // the enterprise one
};

// Internal: never set by a user.
enum class leader_balancer_state : uint8_t {
    idle = 0,
    running,
};

std::ostream& operator<<(std::ostream&, partition_autobalancing_mode);
}
`

const FEATURES = `#pragma once
namespace features {
enum class feature : std::uint64_t {
    serde_raft_0 = 1ULL << 0U,
    cloud_retention = 1ULL << 1U,
    node_isolation = 1ULL << 2U,
};
}
`

const base = { [CONFIG_H]: CONFIG, [MODEL_H]: MODEL, [FEATURE_TABLE]: FEATURES }

describe('configEnumTypes and parseEnums', () => {
  test('the enum types a user can set are the enum_property type arguments', () => {
    expect([...configEnumTypes(CONFIG)]).toEqual(['partition_autobalancing_mode', 'schema_id_validation_mode'])
  })

  test('only wanted enums are read, with their values paired by name', () => {
    const { enums } = parseEnums([{ startLine: 1, text: MODEL }], new Set(['partition_autobalancing_mode']))
    expect([...enums.keys()]).toEqual(['partition_autobalancing_mode'])
    expect([...enums.get('partition_autobalancing_mode').values.keys()]).toEqual(['off', 'node_add', 'continuous'])
  })
})

describe('enums detector', () => {
  test('a new value in an enum_property type is a behaviour finding (DOC-2600 class)', () => {
    const r = detect(base, { ...base, [MODEL_H]: MODEL.replace('    continuous, // the enterprise one', '    continuous, // the enterprise one\n    continuous_with_rack,') }, { detectors: ['enums'] })
    expect(kinds(r)).toEqual([['behaviour', 'partition_autobalancing_mode=continuous_with_rack']])
    expect(r.findings[0]).toMatchObject({ surface: 'properties', severity: 'medium', file: MODEL_H, line: 8, detail: 'enum-value-added' })
    expect(r.findings[0].summary).toMatch(/identifier is reported/)
    expect(r.findings[0].affected_pages).toEqual(['https://docs.redpanda.com/streaming/current/reference/properties/cluster-properties/'])
  })

  test('a removed value is high', () => {
    const r = detect(base, { ...base, [MODEL_H]: MODEL.replace('    continuous, // the enterprise one\n', '') }, { detectors: ['enums'] })
    expect(kinds(r)).toEqual([['removed', 'partition_autobalancing_mode=continuous']])
    expect(r.findings[0].severity).toBe('high')
  })

  test('feature flags are not read: the docs do not list them (review item 13)', () => {
    // Negative control for the old behaviour, which filed a medium finding
    // for every new value and a high one for every retired flag.
    const r = detect(base, { ...base, [FEATURE_TABLE]: FEATURES.replace('    node_isolation = 1ULL << 2U,', '    manual_finalization = 1ULL << 3U,') }, { detectors: ['enums'] })
    expect(r.findings).toEqual([])
  })

  test('an enum is matched by namespace, so a same-named enum elsewhere is not read', () => {
    const CONFIG2 = CONFIG.replace('    property<bool> enable_rack_awareness;', '    enum_property<fips_mode_flag> fips_mode;\n    property<bool> enable_rack_awareness;')
    const TYPES = 'src/v/config/types.h'
    const FUND = 'src/v/model/fundamental.h'
    const cfgEnum = 'namespace config {\nenum class fips_mode_flag : uint8_t {\n    disabled,\n    enabled,\n};\n}\n'
    const modelEnum = 'namespace model {\nenum class fips_mode_flag : uint8_t {\n    disabled,\n    enabled,\n};\n}\n'
    const b = { ...base, [CONFIG_H]: CONFIG2, [TYPES]: cfgEnum, [FUND]: modelEnum }
    const add = (t) => t.replace('    enabled,', '    enabled,\n    permissive,')
    // The config:: enum is the property's type: named after the property.
    expect(kinds(detect(b, { ...b, [TYPES]: add(cfgEnum) }, { detectors: ['enums'] }))).toEqual([['behaviour', 'fips_mode=permissive']])
    // The model:: enum of the same name is not.
    expect(detect(b, { ...b, [FUND]: add(modelEnum) }, { detectors: ['enums'] }).findings).toEqual([])
  })

  test('enum_property<std::optional<T>> names T', () => {
    const { configEnums } = require('../../../tools/user-facing-changes/detectors/enums')
    const m = configEnums('namespace config {\nstruct c {\n    enum_property<std::optional<s3_url_style>> cloud_storage_url_style;\n};\n}\n')
    expect(m.get('s3_url_style')).toEqual([{ ns: 'config', properties: ['cloud_storage_url_style'] }])
  })

  test('the config header text carried by the diff names the enum types when no checkout is available', () => {
    const head = { ...base, [MODEL_H]: MODEL.replace('    continuous, // the enterprise one', '    continuous, // the enterprise one\n    continuous_with_rack,') }
    // Hunk-only mode with configuration.h unchanged: no way to know the type is user-settable.
    expect(detect(base, head, { whole: false, detectors: ['enums'] }).findings).toEqual([])
    // Hunk-only mode with the enum_property line inside a hunk's context: enough.
    const head2 = { ...head, [CONFIG_H]: CONFIG.replace('    enum_property<model::partition_autobalancing_mode> partition_autobalancing_mode;', '    enum_property<model::partition_autobalancing_mode> partition_autobalancing_mode;\n    property<bool> other;') }
    expect(kinds(detect(base, head2, { whole: false, detectors: ['enums'] }))).toEqual([['behaviour', 'partition_autobalancing_mode=continuous_with_rack']])
  })
})

describe('enums detector: negative controls', () => {
  test('a new value in an internal enum is never a finding', () => {
    const r = detect(base, { ...base, [MODEL_H]: MODEL.replace('    running,', '    running,\n    paused,') }, { detectors: ['enums'] })
    expect(r.findings).toEqual([])
  })

  test('a value that moves, a comment change, and an explicit-value change yield nothing', () => {
    expect(detect(base, { ...base, [MODEL_H]: MODEL.replace('    off,\n    node_add,', '    node_add,\n    off,') }, { detectors: ['enums'] }).findings).toEqual([])
    expect(detect(base, { ...base, [MODEL_H]: MODEL.replace('// the enterprise one', '// needs a license') }, { detectors: ['enums'] }).findings).toEqual([])
  })

  test('a whole new enum is not this detector\'s (the property that exposes it is the properties detector\'s)', () => {
    const r = detect(base, { ...base, [MODEL_H]: MODEL + '\nnamespace model { enum class schema_id_validation_mode { none, redpanda, compat }; }\n' }, { detectors: ['enums'] })
    expect(r.findings).toEqual([])
  })

  test('test headers are not routed', () => {
    const T = 'src/v/model/tests/metadata.h'
    expect(detect({ ...base, [T]: MODEL }, { ...base, [T]: MODEL.replace('    continuous,', '    continuous,\n    extra,') }, { detectors: ['enums'] }).findings).toEqual([])
  })
})
