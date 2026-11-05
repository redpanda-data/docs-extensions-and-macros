'use strict'

// Test vectors for redpanda.iceberg.mode, extracted by hand from
// src/v/model/tests/iceberg_mode_test.cc in redpanda-data/streaming-enterprise
// at commit 3832b70d2dea0b8cd9e5f79e6ce5bcd8102cf66c (dev, 2026-11-05).
// The test file first appears at v26.2.1-rc1, and its cases are unchanged
// from v26.2.1 to that commit, so these vectors describe every release that
// has the section format.
//
// Each entry names the upstream TEST it came from. Keep this file a faithful
// copy: when upstream adds or changes a case, update the vector here rather
// than adjusting the parser to pass a hand-written expectation.
//
// Wire round-trip and needs_extended_cluster_feature cases are omitted: they
// test the broker's serialization, not the config string grammar.

const UPSTREAM = {
  repo: 'redpanda-data/streaming-enterprise',
  file: 'src/v/model/tests/iceberg_mode_test.cc',
  sha: '3832b70d2dea0b8cd9e5f79e6ce5bcd8102cf66c',
}

// parse(s) succeeds. `expect` lists the fields the upstream test asserts.
const accept = [
  { test: 'IcebergModeParse.Disabled', input: 'disabled', expect: { disabled: true } },
  { test: 'IcebergModeParse.LegacyKeyValue', input: 'key_value', expect: { 'key.mode': 'binary', 'value.mode': 'binary', 'headers.value_type': 'binary' } },
  { test: 'IcebergModeParse.LegacyValueSchemaIdPrefix', input: 'value_schema_id_prefix', expect: { 'key.mode': 'binary', 'value.mode': 'schema_id_prefix' } },
  { test: 'IcebergModeParse.LegacyValueSchemaLatestBare', input: 'value_schema_latest', expect: { 'value.mode': 'schema_latest', 'value.subject': '', 'value.protobuf_name': '' } },
  { test: 'IcebergModeParse.LegacyValueSchemaLatestWithSubject', input: 'value_schema_latest:subject=my-topic-value', expect: { 'value.mode': 'schema_latest', 'value.subject': 'my-topic-value', 'value.protobuf_name': '' } },
  { test: 'IcebergModeParse.LegacyValueSchemaLatestWithProtobufName', input: 'value_schema_latest:protobuf_name=com.example.Msg', expect: { 'value.mode': 'schema_latest', 'value.protobuf_name': 'com.example.Msg', 'value.subject': '' } },
  { test: 'IcebergModeParse.LegacyValueSchemaLatestBoth', input: 'value_schema_latest:subject=my-topic-value,protobuf_name=com.example.Msg', expect: { 'value.mode': 'schema_latest', 'value.subject': 'my-topic-value', 'value.protobuf_name': 'com.example.Msg' } },
  { test: 'IcebergModeParse.NewValueSchemaIdPrefix', input: 'value:mode=schema_id_prefix', expect: { 'key.mode': 'binary', 'value.mode': 'schema_id_prefix' }, equals: 'value_schema_id_prefix' },
  { test: 'IcebergModeParse.NewValueSchemaLatestWithSubject', input: 'value:mode=schema_latest,subject=my-topic-value', expect: { 'value.mode': 'schema_latest', 'value.subject': 'my-topic-value' } },
  { test: 'IcebergModeParse.NewKeyAndValue', input: 'key:mode=schema_id_prefix;value:mode=schema_latest,subject=my-topic-value', expect: { 'key.mode': 'schema_id_prefix', 'value.mode': 'schema_latest', 'value.subject': 'my-topic-value' } },
  { test: 'IcebergModeParse.NewHeadersString', input: 'headers:value_type=string', expect: { 'key.mode': 'binary', 'value.mode': 'binary', 'headers.value_type': 'string' } },
  { test: 'IcebergModeParse.NewFullCombination', input: 'key:mode=schema_id_prefix;value:mode=schema_latest,subject=my-topic-value;headers:value_type=string', expect: { 'key.mode': 'schema_id_prefix', 'value.mode': 'schema_latest', 'value.subject': 'my-topic-value', 'headers.value_type': 'string' } },
  { test: 'IcebergModeParse.NewSectionOrderIrrelevant', input: 'headers:value_type=string;key:mode=schema_id_prefix;value:mode=schema_id_prefix', expect: { 'key.mode': 'schema_id_prefix', 'value.mode': 'schema_id_prefix', 'headers.value_type': 'string' } },
  { test: 'IcebergModeParse.NewFormatEquivalentToOld', input: 'value:mode=schema_id_prefix', expect: {}, equals: 'value_schema_id_prefix' },
  { test: 'IcebergModeNormalize.EmptyKeySection', input: 'key:', expect: {} },
  { test: 'IcebergModeNormalize.HeadersBinaryExplicit', input: 'headers:value_type=binary', expect: {} },
  { test: 'IcebergModeNormalize.AllSectionsAllDefaults', input: 'key:;value:;headers:', expect: {} },
  { test: 'IcebergModeParse.KeyModeString', input: 'key:mode=string', expect: { 'key.mode': 'string', 'value.mode': 'binary' } },
  { test: 'IcebergModeParse.ValueModeString', input: 'value:mode=string', expect: { 'key.mode': 'binary', 'value.mode': 'string' } },
  { test: 'IcebergModeParse.KeyAndValueModeString', input: 'key:mode=string;value:mode=string', expect: { 'key.mode': 'string', 'value.mode': 'string' } },
  { test: 'IcebergModeParse.StringModeWithHeaders', input: 'key:mode=string;value:mode=string;headers:value_type=string', expect: { 'key.mode': 'string', 'value.mode': 'string', 'headers.value_type': 'string' } },
  { test: 'IcebergModeLayout.ParseNestedWithSchemaIdPrefix', input: 'value:mode=schema_id_prefix,layout=nested', expect: { 'value.mode': 'schema_id_prefix', 'value.layout': 'nested' } },
  { test: 'IcebergModeLayout.ParseNestedWithSchemaLatest', input: 'value:mode=schema_latest,layout=nested', expect: { 'value.mode': 'schema_latest', 'value.layout': 'nested' } },
  { test: 'IcebergModeLayout.ParseFlatExplicit', input: 'value:layout=flat', expect: { 'value.layout': 'flat' } },
]

// parse(s) fails (EXPECT_FALSE(parse(...).has_value()) or parse_err).
const reject = [
  { test: 'IcebergModeParseError.UnknownTopLevelGarbage', input: 'totally_invalid' },
  { test: 'IcebergModeParseError.AllUnknownSections', input: 'hederas:value_type=string' },
  { test: 'IcebergModeParseError.AllUnknownSections', input: 'future_section:opt=val' },
  { test: 'IcebergModeParseError.UnknownSection', input: 'value:mode=schema_id_prefix;future_section:new_opt=foo' },
  { test: 'IcebergModeParseError.UnknownOptionKey', input: 'value:mode=schema_id_prefix,future_opt=bar' },
  { test: 'IcebergModeParseError.UnknownOptionKey', input: 'headers:value_type=string,future_opt=bar' },
  { test: 'IcebergModeParseError.DuplicateSection', input: 'value:mode=binary;value:mode=schema_id_prefix' },
  { test: 'IcebergModeParseError.DuplicateOption', input: 'value:mode=binary,mode=schema_id_prefix' },
  { test: 'IcebergModeParseError.BadModeValue', input: 'value:mode=banana' },
  { test: 'IcebergModeParseError.BadHeaderValueType', input: 'headers:value_type=blob' },
  { test: 'IcebergModeParseError.EmptyOptValue', input: 'value:mode=' },
  { test: 'IcebergModeParseError.LegacyUnknownOpt', input: 'value_schema_latest:unknown_opt=foo' },
  { test: 'IcebergModeParseError.SubjectWithBinaryMode', input: 'value:mode=binary,subject=foo' },
  { test: 'IcebergModeParseError.SubjectWithBinaryMode', input: 'key:mode=binary,subject=foo' },
  { test: 'IcebergModeParseError.SubjectWithSchemaIdPrefixMode', input: 'value:mode=schema_id_prefix,subject=foo' },
  { test: 'IcebergModeParseError.ProtobufNameWithBinaryMode', input: 'value:mode=binary,protobuf_name=foo.Bar' },
  { test: 'IcebergModeParseError.SubjectWithStringMode', input: 'value:mode=string,subject=foo' },
  { test: 'IcebergModeParseError.SubjectWithStringMode', input: 'key:mode=string,subject=foo' },
  { test: 'IcebergModeParseError.ProtobufNameWithStringMode', input: 'value:mode=string,protobuf_name=foo.Bar' },
  { test: 'IcebergModeLayout.ParseNestedWithBinaryRejected', input: 'value:layout=nested' },
  { test: 'IcebergModeLayout.ParseNestedWithStringRejected', input: 'value:mode=string,layout=nested' },
  { test: 'IcebergModeLayout.ParseLayoutInKeySection', input: 'key:layout=nested' },
  { test: 'IcebergModeLayout.ParseUnknownLayout', input: 'value:layout=sideways' },
]

// parse_err(s): `exact` is EXPECT_EQ on the message, `contains` is HasSubstr.
const errorMessages = [
  { test: 'IcebergModeParseErrorMsg.UnknownSection', input: 'hederas:value_type=string', contains: ['hederas'] },
  { test: 'IcebergModeParseErrorMsg.UnknownOptionInValueSection', input: 'value:mode=schema_id_prefix,future_opt=bar', contains: ['future_opt', 'value'] },
  { test: 'IcebergModeParseErrorMsg.UnknownOptionInHeadersSection', input: 'headers:value_type=string,future_opt=bar', contains: ['future_opt', 'headers'] },
  { test: 'IcebergModeParseErrorMsg.UnknownModeValue', input: 'value:mode=banana', contains: ['banana', 'value'] },
  { test: 'IcebergModeParseErrorMsg.UnknownHeaderValueType', input: 'headers:value_type=blob', contains: ['blob'] },
  { test: 'IcebergModeParseErrorMsg.DuplicateSection', input: 'value:mode=binary;value:mode=schema_id_prefix', contains: ['value'] },
  { test: 'IcebergModeParseErrorMsg.SubjectWithBinaryMode', input: 'value:mode=binary,subject=foo', exact: "subject and protobuf_name require mode=schema_latest in section 'value'" },
  { test: 'IcebergModeParseErrorMsg.LegacyUnknownOpt', input: 'value_schema_latest:unknown_opt=foo', contains: ['unknown_opt'] },
  { test: 'IcebergModeParseErrorMsg.SubjectWithStringMode', input: 'value:mode=string,subject=foo', exact: "subject and protobuf_name require mode=schema_latest in section 'value'" },
  { test: 'IcebergModeLayout.ParseNestedWithBinaryRejected', input: 'value:layout=nested', exact: "layout=nested requires a schema mode (schema_id_prefix or schema_latest) in section 'value'" },
  { test: 'IcebergModeLayout.ParseNestedWithStringRejected', input: 'value:mode=string,layout=nested', exact: "layout=nested requires a schema mode (schema_id_prefix or schema_latest) in section 'value'" },
  { test: 'IcebergModeLayout.ParseLayoutInKeySection', input: 'key:layout=nested', exact: "layout is only valid in the value section, not 'key'" },
  { test: 'IcebergModeLayout.ParseUnknownLayout', input: 'value:layout=sideways', exact: "unknown layout 'sideways' in section 'value'" },
]

// to_string(m). Upstream builds `m` either by parsing `input` or by setting
// fields on a default enabled_impl (`fields`), or uses a named constant.
const format = [
  { test: 'IcebergModeFormat.Disabled', input: 'disabled', expected: 'disabled' },
  { test: 'IcebergModeFormat.KeyValue', input: 'key_value', expected: 'key_value' },
  { test: 'IcebergModeFormat.ValueSchemaIdPrefix', input: 'value_schema_id_prefix', expected: 'value_schema_id_prefix' },
  { test: 'IcebergModeFormat.ValueSchemaLatestBare', fields: { 'value.mode': 'schema_latest' }, expected: 'value_schema_latest' },
  { test: 'IcebergModeFormat.ValueSchemaLatestWithSubject', fields: { 'value.mode': 'schema_latest', 'value.subject': 'my-topic-value' }, expected: 'value_schema_latest:subject=my-topic-value' },
  { test: 'IcebergModeFormat.ValueSchemaLatestWithProtobuf', fields: { 'value.mode': 'schema_latest', 'value.protobuf_name': 'com.example.Msg', 'value.subject': 'my-topic-value' }, expected: 'value_schema_latest:protobuf_name=com.example.Msg,subject=my-topic-value' },
  { test: 'IcebergModeFormat.NewKeySchema', fields: { 'key.mode': 'schema_id_prefix' }, expected: 'key:mode=schema_id_prefix;value:mode=binary,layout=flat;headers:value_type=binary' },
  { test: 'IcebergModeFormat.NewHeadersString', fields: { 'headers.value_type': 'string' }, expected: 'key:mode=binary;value:mode=binary,layout=flat;headers:value_type=string' },
  { test: 'IcebergModeFormat.NewFormatEquivalentSerializesAsOld', input: 'value:mode=schema_id_prefix', expected: 'value_schema_id_prefix' },
  { test: 'IcebergModeNormalize.EmptyKeySection', input: 'key:', expected: 'key_value' },
  { test: 'IcebergModeNormalize.HeadersBinaryExplicit', input: 'headers:value_type=binary', expected: 'key_value' },
  { test: 'IcebergModeNormalize.AllSectionsAllDefaults', input: 'key:;value:;headers:', expected: 'key_value' },
  { test: 'IcebergModeFormat.KeyModeString', fields: { 'key.mode': 'string' }, expected: 'key:mode=string;value:mode=binary,layout=flat;headers:value_type=binary' },
  { test: 'IcebergModeFormat.ValueModeString', fields: { 'value.mode': 'string' }, expected: 'key:mode=binary;value:mode=string,layout=flat;headers:value_type=binary' },
  { test: 'IcebergModeFormat.KeyAndValueModeString', fields: { 'key.mode': 'string', 'value.mode': 'string' }, expected: 'key:mode=string;value:mode=string,layout=flat;headers:value_type=binary' },
  { test: 'IcebergModeLayout.ParseFlatExplicit', input: 'value:layout=flat', expected: 'key_value' },
  { test: 'IcebergModeLayout.FormatNested', fields: { 'value.mode': 'schema_id_prefix', 'value.layout': 'nested' }, expected: 'key:mode=binary;value:mode=schema_id_prefix,layout=nested;headers:value_type=binary' },
]

// check_stable(m): parse(to_string(m)) == m and to_string is a fixed point.
const roundtrip = [
  { test: 'IcebergModeStringRoundtrip.Disabled', input: 'disabled' },
  { test: 'IcebergModeStringRoundtrip.KeyValue', input: 'key_value' },
  { test: 'IcebergModeStringRoundtrip.ValueSchemaIdPrefix', input: 'value_schema_id_prefix' },
  { test: 'IcebergModeStringRoundtrip.ValueSchemaLatest', fields: { 'value.mode': 'schema_latest', 'value.protobuf_name': 'com.example.Msg', 'value.subject': 'my-topic-value' } },
  { test: 'IcebergModeStringRoundtrip.KeySchema', fields: { 'key.mode': 'schema_id_prefix' } },
  { test: 'IcebergModeStringRoundtrip.HeadersString', fields: { 'headers.value_type': 'string' } },
  { test: 'IcebergModeStringRoundtrip.FullCombination', fields: { 'key.mode': 'schema_id_prefix', 'value.mode': 'schema_latest', 'value.subject': 'my-topic-value', 'headers.value_type': 'string' } },
  { test: 'IcebergModeStringRoundtrip.KeyModeString', fields: { 'key.mode': 'string' } },
  { test: 'IcebergModeStringRoundtrip.ValueModeString', fields: { 'value.mode': 'string' } },
  { test: 'IcebergModeStringRoundtrip.KeyAndValueModeStringWithHeaders', fields: { 'key.mode': 'string', 'value.mode': 'string', 'headers.value_type': 'string' } },
  { test: 'IcebergModeLayout.StringRoundtripNested', fields: { 'value.mode': 'schema_id_prefix', 'value.layout': 'nested' } },
]

module.exports = { UPSTREAM, accept, reject, errorMessages, format, roundtrip }
