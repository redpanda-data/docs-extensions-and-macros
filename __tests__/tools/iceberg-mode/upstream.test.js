'use strict'

// The extractor reads Redpanda's C++, which is private, so these tests use
// small synthetic sources shaped like each generation of the parser. The real
// sources are exercised by the drift job (.github/workflows/iceberg-mode-drift.yml).

const upstream = require('../../../tools/iceberg-mode/upstream')
const { seriesTags, buildReleases, buildVectorSets, renderVectors } = require('../../../tools/iceberg-mode/generate')

// Shaped like v24.3: three names through string_switch, no reasons.
const ENUM_PARSER = `
std::istream& operator>>(std::istream& is, iceberg_mode& mode) {
    using enum iceberg_mode;
    ss::sstring s;
    is >> s;
    try {
        mode = string_switch<iceberg_mode>(s)
                 .match("disabled", disabled)
                 .match("key_value", key_value)
                 .match("value_schema_id_prefix", value_schema_id_prefix);
    } catch (const std::runtime_error&) {
        is.setstate(std::ios::failbit);
    }
    return is;
}
`

// Shaped like v25.1 to v26.1: value_schema_latest with options.
const LEGACY_PARSER = `
std::istream& operator>>(std::istream& is, iceberg_mode& mode) {
    ss::sstring s;
    is >> s;
    if (s == "disabled") {
        mode = iceberg_mode::disabled;
    } else if (s == "key_value") {
        mode = iceberg_mode::key_value;
    } else if (s.starts_with("value_schema_latest")) {
        auto options = parse_config_options(s);
        for (const auto& [key, value] : options.value()) {
            if (key == "subject") {
                subject = value;
            } else {
                is.setstate(std::ios::failbit);
            }
        }
    } else {
        is.setstate(std::ios::failbit);
    }
    return is;
}
`

// Shaped like v26.2.1: parse_iceberg_mode delegating to the section parser.
const SECTION_PARSER = `
std::expected<iceberg_mode, ss::sstring>
parse_extended_iceberg_mode(std::string_view str) {
    for (std::string_view sec_str : absl::StrSplit(str, ";")) {
        if (sec_name == "key") {
        } else if (sec_name == "value") {
        } else {
            return std::unexpected(fmt::format("unknown section '{}'", sec_name));
        }
    }
    for (const auto& [k, v] : opts) {
        if (k == "mode") {
            auto m = string_switch<std::optional<sm>>(v)
                       .match("binary", sm::binary)
                       .match("string", sm::string)
                       .default_match(std::nullopt);
        } else if (k == "layout") {
            auto l = string_switch<std::optional<vl>>(v)
                       .match("flat", vl::flat)
                       .default_match(std::nullopt);
        }
    }
    for (const auto& [k, v] : *headers_opts) {
        if (k == "value_type") {
            auto t = string_switch<std::optional<hsm>>(v).match("binary", hsm::binary).default_match(std::nullopt);
        }
    }
    return iceberg_mode{std::move(result)};
}

namespace {
std::expected<iceberg_mode, ss::sstring>
parse_legacy_schema_latest(std::string_view suffix) {
    for (const auto& [k, v] : opts) {
        if (k == "protobuf_name") {
            proto_name = v;
        } else {
            return std::unexpected(fmt::format("unknown option '{}' in value_schema_latest", k));
        }
    }
}
} // namespace

std::expected<iceberg_mode, ss::sstring>
parse_iceberg_mode(std::string_view s) {
    if (s == "disabled") {
        return iceberg_mode::disabled;
    } else if (s.starts_with("value_schema_latest")) {
        return parse_legacy_schema_latest(s.substr(19));
    } else {
        return parse_extended_iceberg_mode(s);
    }
}

std::istream& operator>>(std::istream& is, iceberg_mode& mode) {
    ss::sstring s;
    is >> s;
    auto result = parse_iceberg_mode(s);
    return is;
}
`

describe('extractGrammar', () => {
  test('a file with no iceberg_mode parser has no grammar', () => {
    expect(upstream.extractGrammar('int main() { return 0; }')).toBeNull()
  })

  test('reads the names a string_switch parser matches', () => {
    expect(upstream.extractGrammar(ENUM_PARSER)).toEqual({
      legacyNames: ['disabled', 'key_value', 'value_schema_id_prefix'],
      legacySchemaLatest: null,
      sections: null,
      messages: false,
    })
  })

  // `key == "subject"` compares an option name, not the whole value, so it
  // must not become a legacy name.
  test('separates legacy names from value_schema_latest option names', () => {
    expect(upstream.extractGrammar(LEGACY_PARSER)).toEqual({
      legacyNames: ['disabled', 'key_value'],
      legacySchemaLatest: { prefix: 'value_schema_latest', options: ['subject'] },
      sections: null,
      messages: false,
    })
  })

  test('reads the section grammar from parse_extended_iceberg_mode', () => {
    expect(upstream.extractGrammar(SECTION_PARSER)).toEqual({
      legacyNames: ['disabled'],
      legacySchemaLatest: { prefix: 'value_schema_latest', options: ['protobuf_name'] },
      sections: {
        names: ['key', 'value'],
        options: ['mode', 'layout', 'value_type'],
        schemaModes: ['binary', 'string'],
        layouts: ['flat'],
        headerValueTypes: ['binary'],
      },
      messages: true,
    })
  })

  test('fails loudly when the section parser it delegates to is missing', () => {
    const broken = SECTION_PARSER.replace('parse_extended_iceberg_mode(std::string_view str) {', 'other(std::string_view str) {')
    expect(() => upstream.extractGrammar(broken)).toThrow(/parse_extended_iceberg_mode, which is not defined/)
  })

  test('fails loudly when the section parser matches no enum names', () => {
    const broken = SECTION_PARSER.replace(/\.match\("(\w+)", hsm::\w+\)/, '')
    expect(() => upstream.extractGrammar(broken)).toThrow(/found no headerValueTypes/)
  })
})

describe('parserFingerprint', () => {
  const fp = (src) => upstream.parserFingerprint(upstream.parserFunctions(src))

  test('ignores comments and whitespace', () => {
    const reformatted = LEGACY_PARSER.replace('is >> s;', '// read it\n      is   >>   s;   /* done */')
    expect(fp(reformatted)).toBe(fp(LEGACY_PARSER))
  })

  test('changes when the parser logic changes', () => {
    expect(fp(LEGACY_PARSER.replace('if (key == "subject")', 'if (key == "subject" && !value.empty())'))).not.toBe(fp(LEGACY_PARSER))
  })

  test('ignores code outside the parser functions', () => {
    expect(fp(`${LEGACY_PARSER}\nint unrelated() { return 1; }\n`)).toBe(fp(LEGACY_PARSER))
  })
})

describe('extractClusterGate', () => {
  test('reads the release a cluster must run before extended values are accepted', () => {
    const src = `if (value.needs_extended_cluster_feature() && !extended_mode_config) {
      return "Invalid iceberg mode: extended key/headers config requires "
             "the cluster to be fully upgraded to at least v26.2.1."; }`
    expect(upstream.extractClusterGate(src)).toBe('v26.2.1')
  })

  test('is null without the gate or the file', () => {
    expect(upstream.extractClusterGate('struct x {};')).toBeNull()
    expect(upstream.extractClusterGate(null)).toBeNull()
  })
})

describe('extractVectors', () => {
  const TESTS = `
std::optional<model::iceberg_mode> parse(std::string_view s) { return std::nullopt; }

TEST(IcebergModeParse, Split) {
    auto m = parse(
      "key:mode=schema_id_prefix;value:mode=schema_latest,subject=my-topic-"
      "value");
    ASSERT_TRUE(m.has_value());
    EXPECT_EQ(m->key().mode, sm::schema_id_prefix);
    EXPECT_EQ(m->value().subject, "my-topic-value");
    EXPECT_TRUE(m->value().protobuf_name.empty());
    EXPECT_EQ(*m, model::iceberg_mode::value_schema_id_prefix);
}

TEST(IcebergModeParseError, Two) {
    EXPECT_FALSE(parse("a;b").has_value());
    EXPECT_FALSE(parse("value:mode=schema_id_prefix;future_section:new_opt=foo")
                   .has_value());
}

TEST(IcebergModeFormat, Built) {
    enabled e{};
    e.key.mode = sm::string;
    e.value.subject = "s";
    model::iceberg_mode m{std::move(e)};
    EXPECT_EQ(to_string(m), "key:mode=string");
}

TEST(IcebergModeFormat, Latest) {
    auto m = model::iceberg_mode::value_schema_latest("com.example.Msg", "");
    EXPECT_EQ(to_string(m), "value_schema_latest:protobuf_name=com.example.Msg");
}

TEST(IcebergModeStringRoundtrip, Named) {
    check_stable(model::iceberg_mode::key_value);
}

TEST(IcebergModeParseErrorMsg, Layout) {
    auto e = parse_err("key:layout=nested");
    EXPECT_EQ(e, "layout is only valid in the value section, not 'key'");
    EXPECT_THAT(e, testing::HasSubstr("key"));
}

TEST(IcebergModeWireRoundtrip, Ignored) {
    EXPECT_EQ(wire_roundtrip(model::iceberg_mode::disabled), model::iceberg_mode::disabled);
}
`

  test('reads every kind of case, joining split string literals', () => {
    expect(upstream.extractVectors(TESTS)).toEqual({
      accept: [{
        test: 'IcebergModeParse.Split',
        input: 'key:mode=schema_id_prefix;value:mode=schema_latest,subject=my-topic-value',
        expect: { 'key.mode': 'schema_id_prefix', 'value.subject': 'my-topic-value', 'value.protobuf_name': '' },
        equals: 'value_schema_id_prefix',
      }],
      reject: [
        { test: 'IcebergModeParseError.Two', input: 'a;b' },
        { test: 'IcebergModeParseError.Two', input: 'value:mode=schema_id_prefix;future_section:new_opt=foo' },
        { test: 'IcebergModeParseErrorMsg.Layout', input: 'key:layout=nested' },
      ],
      errorMessages: [{
        test: 'IcebergModeParseErrorMsg.Layout',
        input: 'key:layout=nested',
        exact: "layout is only valid in the value section, not 'key'",
        contains: ['key'],
      }],
      format: [
        { test: 'IcebergModeFormat.Built', fields: { 'key.mode': 'string', 'value.subject': 's' }, expected: 'key:mode=string' },
        { test: 'IcebergModeFormat.Latest', fields: { 'value.mode': 'schema_latest', 'value.protobuf_name': 'com.example.Msg' }, expected: 'value_schema_latest:protobuf_name=com.example.Msg' },
      ],
      roundtrip: [{ test: 'IcebergModeStringRoundtrip.Named', input: 'key_value' }],
    })
  })

  // A new kind of assertion upstream must fail the drift job, not vanish.
  test('throws on a statement it cannot read, naming the TEST', () => {
    const src = 'TEST(IcebergModeParse, New) {\n  auto m = parse("key_value");\n  EXPECT_NEAR(m->score(), 1.0, 0.1);\n}\n'
    expect(() => upstream.extractVectors(src)).toThrow(/IcebergModeParse\.New: unrecognized statement: EXPECT_NEAR/)
  })
})

describe('generate', () => {
  const tag = (name) => ({ name, commit: '0'.repeat(40) })

  test('uses GA tags, or RC tags only for a series with no GA, newest series first', () => {
    const out = seriesTags(['v26.2.1-rc1', 'v26.2.2', 'v26.2.1', 'v26.3.1-rc2', 'v26.3.1-rc1', 'v26.2.0-dev', 'v25.3.1'].map(tag))
    expect(out.map((s) => [s.series, s.tags.map((t) => t.name)])).toEqual([
      ['26.3', ['v26.3.1-rc1', 'v26.3.1-rc2']],
      ['26.2', ['v26.2.1', 'v26.2.2']],
      ['25.3', ['v25.3.1']],
    ])
  })

  const g = (legacyNames) => ({ legacyNames, legacySchemaLatest: null, sections: null, messages: false })
  const read = (name, parser, grammar = g(['key_value'])) => ({ tag: name, parser, grammar, clusterGate: null, tests: null })

  // Only grammar changes are recorded, so a patch release that leaves the
  // parser alone does not change the generated file.
  test('records the first tag of each parser, not every patch', () => {
    const releases = buildReleases([
      { series: '26.1', reads: [read('v26.1.1', 'a'), read('v26.1.2', 'a'), read('v26.1.3', 'b', g(['disabled']))] },
      { series: '25.3', reads: [read('v25.3.1', 'a')] },
      { series: '25.2', reads: [] },
    ])
    expect(releases.series).toEqual({
      '26.1': [{ since: 'v26.1.1', parser: 'a', clusterGate: null }, { since: 'v26.1.3', parser: 'b', clusterGate: null }],
      '25.3': [{ since: 'v25.3.1', parser: 'a', clusterGate: null }],
      '25.2': [],
    })
    expect(releases.parsers.a.firstTag).toBe('v25.3.1')
    expect(releases.parsers.b.legacyNames).toEqual(['disabled'])
  })

  test('groups test files by the vectors they hold, not by blob', () => {
    const file = (extra) => `TEST(IcebergModeParseError, X) {\n EXPECT_FALSE(parse("x").has_value());\n}\n${extra}`
    const withTests = (name, sha, text) => ({ ...read(name, 'a'), tests: { sha, text } })
    const sets = buildVectorSets([
      { series: '26.3', reads: [withTests('v26.3.1-rc1', 'b2', file('TEST(IcebergModeWireRoundtrip, Y) { EXPECT_EQ(wire_roundtrip(m), m); }'))] },
      { series: '26.2', reads: [withTests('v26.2.1', 'b1', file(''))] },
    ])
    expect(sets).toHaveLength(1)
    expect(sets[0]).toMatchObject({ since: 'v26.2.1', sha: 'b1', series: ['26.2', '26.3'] })
    const rendered = renderVectors(sets)
    expect(rendered).toMatch(/^'use strict'\n\n\/\/ GENERATED by tools\/iceberg-mode\/generate\.js/)
    const mod = { exports: {} }
    new Function('module', rendered)(mod) // eslint-disable-line no-new-func
    expect(mod.exports.reject).toEqual([{ test: 'IcebergModeParseError.X', input: 'x' }])
    expect(mod.exports.sets[0].reject).toBe(mod.exports.reject)
  })
})
