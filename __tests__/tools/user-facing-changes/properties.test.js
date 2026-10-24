'use strict'

const fs = require('fs')
const path = require('path')
const { detect, kinds } = require('./helpers')
const { detectUserFacingChanges } = require('../../../tools/user-facing-changes')
const { parseInitializers, parseHeaderTypes } = require('../../../tools/user-facing-changes/detectors/properties')

const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'user-facing-changes', name), 'utf8')

const CC = 'src/v/config/configuration.cc'
const H = 'src/v/config/configuration.h'

// A synthetic configuration.cc in the shape of redpanda's: member
// initializers with clang-format-wrapped adjacent literals, a meta struct,
// a default and bounds. Nothing here is copied from the private repo.
const SOURCE = `// Copyright 2026 Fixture
#include "config/configuration.h"

namespace config {

configuration::configuration(ctor_key)
  : rpc_client_connections_per_peer(
      *this,
      "rpc_client_connections_per_peer",
      "The maximum number of connections a broker will open to each of its "
      "peers.",
      {.example = "8"},
      128,
      {.min = 8})
  , rpc_server_compress_replies(
      *this,
      "rpc_server_compress_replies",
      "Enable compression for internal RPC server replies.",
      {.needs_restart = needs_restart::no, .visibility = visibility::tunable},
      false)
  , cloud_storage_segment_max_upload_interval_sec(
      *this,
      "cloud_storage_segment_max_upload_interval_sec",
      "Time that segment can be kept locally without uploading it to the "
      "remote storage (sec).",
      {.needs_restart = needs_restart::no, .visibility = visibility::tunable},
      1h)
  , audit_enabled(
      *this,
      true, /* restricted value */
      "audit_enabled",
      "Enables or disables audit logging.",
      meta{.needs_restart = needs_restart::no, .visibility = visibility::user},
      false)
  , partition_autobalancing_mode(
      *this,
      "partition_autobalancing_mode",
      "Mode of partition balancing for a cluster.",
      {.needs_restart = needs_restart::no, .visibility = visibility::user},
      model::partition_autobalancing_mode::node_add,
      {model::partition_autobalancing_mode::off,
       model::partition_autobalancing_mode::node_add,
       model::partition_autobalancing_mode::continuous})
  , old_knob(*this, "old_knob")
  , kafka_batch_max_bytes(
      *this,
      "kafka_batch_max_bytes",
      "Maximum size of a batch processed by the server.",
      {.needs_restart = needs_restart::no, .visibility = visibility::user},
      1048576,
      [](int32_t v) -> std::optional<ss::sstring> {
          if (v < 1, v > 2) {
              return "must be positive";
          }
          return std::nullopt;
      }) {}

} // namespace config
`

const HEADER = `#pragma once
namespace config {
struct configuration final : public config_store {
public:
    property<int> rpc_client_connections_per_peer;
    property<bool> rpc_server_compress_replies;
    property<std::chrono::seconds>
      cloud_storage_segment_max_upload_interval_sec;
    enterprise<property<bool>> audit_enabled;
    enterprise<enum_property<model::partition_autobalancing_mode>>
      partition_autobalancing_mode;
    deprecated_property old_knob;
    bounded_property<int32_t> kafka_batch_max_bytes;
};
}
`

const base = { [CC]: SOURCE, [H]: HEADER }
const edit = (from, to) => ({ ...base, [CC]: SOURCE.replace(from, to) })

describe('parseInitializers', () => {
  test('reads every initializer with its name literal, default and meta', () => {
    const { decls, unresolved } = parseInitializers([{ startLine: 1, text: SOURCE }])
    expect(unresolved).toEqual([])
    expect([...decls.keys()]).toEqual([
      'rpc_client_connections_per_peer', 'rpc_server_compress_replies', 'cloud_storage_segment_max_upload_interval_sec',
      'audit_enabled', 'partition_autobalancing_mode', 'old_knob', 'kafka_batch_max_bytes'
    ])
    expect(decls.get('rpc_client_connections_per_peer')).toMatchObject({ name: 'rpc_client_connections_per_peer', defaultText: '128', line: 7, visibility: null })
    expect(decls.get('rpc_server_compress_replies')).toMatchObject({ defaultText: 'false', visibility: 'tunable', needsRestart: 'no' })
    // The restricted value before the name literal (enterprise<>) does not
    // displace the name, and `meta{...}` is the meta argument.
    expect(decls.get('audit_enabled')).toMatchObject({ name: 'audit_enabled', defaultText: 'false', visibility: 'user' })
    // An enum default followed by a brace-list of accepted values.
    expect(decls.get('partition_autobalancing_mode').defaultText).toBe('model::partition_autobalancing_mode::node_add')
    // A deprecated_property initializer has no description and no default.
    expect(decls.get('old_knob')).toMatchObject({ name: 'old_knob', defaultText: null, hasDescription: false })
    // A validator lambda with commas and comparisons does not break the split.
    expect(decls.get('kafka_batch_max_bytes').defaultText).toBe('1048576')
  })

  test('reports an initializer cut by a hunk window instead of guessing', () => {
    const cut = SOURCE.split('\n').slice(6, 10).join('\n')
    const { decls, unresolved } = parseInitializers([{ startLine: 7, text: cut }])
    expect(decls.size).toBe(0)
    expect(unresolved).toEqual([{ line: 7, member: 'rpc_client_connections_per_peer' }])
  })
})

describe('parseHeaderTypes', () => {
  test('reads split declarations and deprecated_property', () => {
    const types = parseHeaderTypes([{ startLine: 1, text: HEADER }])
    expect(types.get('cloud_storage_segment_max_upload_interval_sec')).toBe('property<std::chrono::seconds>')
    expect(types.get('partition_autobalancing_mode')).toBe('enterprise<enum_property<model::partition_autobalancing_mode>>')
    expect(types.get('old_knob')).toBe('deprecated_property')
  })
})

describe('properties detector: whole files', () => {
  test('a changed default is found and named even though the hunk never shows the name (PR 203 shape)', () => {
    const r = detect(base, edit('      128,\n      {.min = 8})', '      256,\n      {.min = 8})'))
    expect(kinds(r)).toEqual([['default-changed', 'rpc_client_connections_per_peer']])
    const [f] = r.findings
    expect(f).toMatchObject({ surface: 'properties', severity: 'high', file: CC, line: 7, confidence: 'mechanical', detector: 'properties' })
    expect(f.summary).toMatch(/from `128` to `256`/)
    expect(f.evidence).toMatch(/^-      128,$/m)
    expect(f.evidence).toMatch(/^\+      256,$/m)
    expect(f.affected_pages).toEqual(['https://docs.redpanda.com/streaming/current/reference/properties/cluster-properties/'])
    expect(r.notes).toEqual([])
  })

  test('a changed restart requirement is a behaviour finding (PR 774 shape)', () => {
    const r = detect(base, edit(
      '"remote storage (sec).",\n      {.needs_restart = needs_restart::no,',
      '"remote storage (sec).",\n      {.needs_restart = needs_restart::yes,'))
    expect(kinds(r)).toEqual([['behaviour', 'cloud_storage_segment_max_upload_interval_sec']])
    // High: the reference and procedures state the old restart requirement.
    expect(r.findings[0]).toMatchObject({ severity: 'high', detail: 'restart-requirement-changed' })
    expect(r.findings[0].summary).toMatch(/now requires a restart/)
  })

  test('a changed visibility is a behaviour finding, and visibility::deprecated is a deprecation', () => {
    const r1 = detect(base, edit('.visibility = visibility::tunable},\n      false)', '.visibility = visibility::user},\n      false)'))
    expect(kinds(r1)).toEqual([['behaviour', 'rpc_server_compress_replies']])
    const r2 = detect(base, edit('.visibility = visibility::tunable},\n      false)', '.visibility = visibility::deprecated},\n      false)'))
    expect(kinds(r2)).toEqual([['deprecated', 'rpc_server_compress_replies']])
    // Medium: a deprecated property still works, so no page is wrong yet.
    expect(r2.findings[0].severity).toBe('medium')
  })

  test('a new property is added (medium) and a deleted one removed (high)', () => {
    const added = SOURCE.replace('  , old_knob(*this, "old_knob")', '  , protected_mode(\n      *this,\n      "protected_mode",\n      "Rejects non-loopback connections on listeners with no authentication.",\n      {.needs_restart = needs_restart::no, .visibility = visibility::user},\n      false)\n  , old_knob(*this, "old_knob")')
    const r = detect(base, { ...base, [CC]: added, [H]: HEADER.replace('    deprecated_property old_knob;', '    property<bool> protected_mode;\n    deprecated_property old_knob;') })
    expect(kinds(r)).toEqual([['added', 'protected_mode']])
    expect(r.findings[0]).toMatchObject({ severity: 'medium' })
    expect(r.findings[0].summary).toMatch(/default `false`/)

    const removed = SOURCE.replace(/  , rpc_server_compress_replies\([\s\S]*?false\)\n/, '')
    const r2 = detect(base, { ...base, [CC]: removed, [H]: HEADER.replace('    property<bool> rpc_server_compress_replies;\n', '') })
    expect(kinds(r2)).toEqual([['removed', 'rpc_server_compress_replies']])
    expect(r2.findings[0]).toMatchObject({ severity: 'high', line: 15 })
    expect(r2.findings[0].evidence).toMatch(/^-  , rpc_server_compress_replies\($/m)
  })

  test('a changed name literal is a rename, reported once under the new name', () => {
    const r = detect(base, edit('"rpc_server_compress_replies",', '"rpc_server_compress_responses",'))
    expect(kinds(r)).toEqual([['renamed', 'rpc_server_compress_responses']])
    expect(r.findings[0].summary).toMatch(/`rpc_server_compress_replies` was renamed to `rpc_server_compress_responses`/)
  })

  test('a property whose header type becomes deprecated_property is deprecated, with no second finding for its lost default', () => {
    const head = {
      [CC]: SOURCE.replace(/  , rpc_server_compress_replies\([\s\S]*?false\)\n/, '  , rpc_server_compress_replies(*this, "rpc_server_compress_replies")\n'),
      [H]: HEADER.replace('property<bool> rpc_server_compress_replies;', 'deprecated_property rpc_server_compress_replies;')
    }
    const r = detect(base, head)
    expect(kinds(r)).toEqual([['deprecated', 'rpc_server_compress_replies']])
  })

  test('a header-only flip to deprecated_property is still found', () => {
    const r = detect(base, { ...base, [H]: HEADER.replace('bounded_property<int32_t> kafka_batch_max_bytes;', 'deprecated_property kafka_batch_max_bytes;') })
    expect(kinds(r)).toEqual([['deprecated', 'kafka_batch_max_bytes']])
    expect(r.findings[0].file).toBe(H)
  })

  test('the restricted value of an enterprise property is the gating detector\'s, not a default change', () => {
    const r = detect(base, edit('      true, /* restricted value */', '      false, /* restricted value */'), { detectors: ['properties'] })
    expect(kinds(r)).toEqual([])
  })

  test('node_config.cc routes to the broker properties page', () => {
    const NODE = 'src/v/config/node_config.cc'
    const src = 'node_config::node_config()\n  : data_directory(\n      *this,\n      "data_directory",\n      "Place where redpanda will keep the data.",\n      {.required = required::yes, .visibility = visibility::user},\n      std::nullopt)\n  , developer_mode(\n      *this,\n      "developer_mode",\n      "Skips most of the checks performed at startup.",\n      {.visibility = visibility::tunable},\n      false) {}\n'
    const r = detect({ [NODE]: src }, { [NODE]: src.replace('      false) {}', '      true) {}') })
    expect(kinds(r)).toEqual([['default-changed', 'developer_mode']])
    expect(r.findings[0].affected_pages).toEqual(['https://docs.redpanda.com/streaming/current/reference/properties/broker-properties/'])
  })
})

describe('properties detector: negative controls', () => {
  test('a description-only change is the lint\'s business and yields nothing here', () => {
    const r = detect(base, edit('"Enable compression for internal RPC server replies."', '"Enables compression for internal RPC server replies."'))
    expect(r.findings).toEqual([])
  })

  test('a comment-only change yields nothing', () => {
    const r = detect(base, edit('  , rpc_server_compress_replies(', '  // Compression is applied to every reply over 1 KiB.\n  , rpc_server_compress_replies('))
    expect(r.findings).toEqual([])
  })

  test('reordering initializers (a refactor) yields nothing', () => {
    const a = /  , rpc_server_compress_replies\([\s\S]*?false\)\n/.exec(SOURCE)[0]
    const b = /  , cloud_storage_segment_max_upload_interval_sec\([\s\S]*?1h\)\n/.exec(SOURCE)[0]
    const r = detect(base, { ...base, [CC]: SOURCE.replace(a + b, b + a) })
    expect(r.findings).toEqual([])
  })

  test('a changed validator or example (not default, not meta fields the docs show) yields nothing', () => {
    const r = detect(base, edit('return "must be positive";', 'return "must be greater than zero";'))
    expect(r.findings).toEqual([])
    const r2 = detect(base, edit('{.example = "8"},', '{.example = "16"},'))
    expect(r2.findings).toEqual([])
  })

  test('the same change under a tests/ directory is not routed', () => {
    const T = 'src/v/config/tests/configuration.cc'
    const r = detect({ [T]: SOURCE }, { [T]: SOURCE.replace('      128,', '      256,') })
    expect(r.findings).toEqual([])
  })

  test('a .cc with no *this initializers (not a config store) yields nothing', () => {
    const P = 'src/v/config/property.cc'
    const r = detect({ [P]: 'int f() {\n  return 128;\n}\n' }, { [P]: 'int f() {\n  return 256;\n}\n' })
    expect(r.findings).toEqual([])
  })
})

describe('properties detector: hunks only (no checkout)', () => {
  test('a default change whose name is outside the window is a note, never a guess', () => {
    const r = detect(base, edit('      128,\n      {.min = 8})', '      256,\n      {.min = 8})'), { whole: false })
    expect(r.findings).toEqual([])
    // Two notes: the initializer that starts inside the window and runs
    // past it, and the changed line that no visible initializer covers
    // (the default sits three lines below its name, outside -U3 context).
    expect(r.notes.map((n) => n.message)).toEqual([
      expect.stringMatching(/initializer of rpc_server_compress_replies is cut by the hunk; run with --repo/),
      expect.stringMatching(/2 changed line\(s\) fall outside every initializer the hunks show \(for example line 13\); run with --repo/)
    ])
  })

  test('a complete initializer inside the window is still found and named', () => {
    const r = detectUserFacingChanges(fixture('properties-default-changed.patch'))
    expect(kinds(r)).toEqual([['default-changed', 'rpc_client_connections_per_peer']])
    expect(r.findings[0].line).toBe(158)
  })

  test('the comment-only fixture yields nothing', () => {
    const r = detectUserFacingChanges(fixture('properties-comment-only.patch'))
    expect(r.findings).toEqual([])
    expect(r.notes).toEqual([])
  })
})

describe('properties detector: defaults compared by value', () => {
  const D = '      1h)\n  , audit_enabled('
  const withDefault = (text) => edit(D, `      ${text})\n  , audit_enabled(`)
  const reported = (from, to) => kinds(detect(withDefault(from), withDefault(to)))

  test.each([
    ['std::chrono::milliseconds(150)', '150ms'],
    ['std::chrono::seconds(3600)', '1h'],
    ['128_MiB', '134217728'],
    ['134\'217\'728', '128 * 1024 * 1024'],
    ['true', 'true'],
    ['"abc"', '"a" "bc"']
  ])('%s to %s keeps the value and yields nothing', (from, to) => {
    expect(reported(from, to)).toEqual([])
  })

  test.each([
    ['std::chrono::milliseconds(150)', '200ms'],
    ['128_MiB', '256_MiB'],
    ['"abc"', '"abd"'],
    ['model::mode::a', 'model::mode::b']
  ])('%s to %s is still a default change', (from, to) => {
    expect(reported(from, to)).toEqual([['default-changed', 'cloud_storage_segment_max_upload_interval_sec']])
  })
})
