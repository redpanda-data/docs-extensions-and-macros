'use strict'

const {
  parseIcebergMode,
  formatIcebergMode,
  validateIcebergMode,
  supportsSectionFormat,
  releaseFor,
  LEGACY_NAMES,
  PORTED_PARSERS,
  RELEASES,
} = require('../../extension-utils/iceberg-mode')
const vectors = require('../fixtures/iceberg-mode/upstream-vectors')

const get = (mode, dotted) => dotted.split('.').reduce((o, k) => o[k], mode)

// Build the mode upstream builds with `enabled_impl e{}; e.x.y = ...`.
function fromFields (fields) {
  const mode = parseIcebergMode('key_value').mode
  for (const [dotted, value] of Object.entries(fields)) {
    const [section, field] = dotted.split('.')
    mode[section][field] = value
  }
  return mode
}

describe('redpanda.iceberg.mode parser against upstream vectors', () => {
  test('the fixture names its upstream source', () => {
    expect(vectors.UPSTREAM.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(vectors.UPSTREAM.file).toBe('src/v/model/tests/iceberg_mode_test.cc')
    expect(vectors.sets.length).toBeGreaterThan(0)
  })

  // Every distinct set of upstream cases, replayed with the grammar of every
  // release series that ships it.
  const cases = []
  for (const set of vectors.sets) {
    for (const series of set.series) cases.push([series, set])
  }

  describe.each(cases)('series %s', (series, set) => {
    const grammar = releaseFor(series).grammar
    const parse = (s) => parseIcebergMode(s, grammar)
    const modeOf = (v) => (v.fields ? fromFields(v.fields) : parse(v.input).mode)

    test.each(set.accept.map((v) => [v.test, v.input, v]))('accept %s: %s', (_t, input, v) => {
      const r = parse(input)
      expect(r).toMatchObject({ ok: true })
      if (v.expect.disabled) {
        expect(r.mode.disabled).toBe(true)
        return
      }
      expect(r.mode.disabled).toBe(false)
      for (const [dotted, value] of Object.entries(v.expect)) {
        expect(get(r.mode, dotted)).toBe(value)
      }
      if (v.equals) expect(r.mode).toEqual(parse(v.equals).mode)
    })

    test.each(set.reject.map((v) => [v.test, v.input]))('reject %s: %s', (_t, input) => {
      const r = parse(input)
      expect(r.ok).toBe(false)
      expect(typeof r.error).toBe('string')
      expect(r.error.length).toBeGreaterThan(0)
    })

    test.each(set.errorMessages.map((v) => [v.test, v.input, v]))('error message %s: %s', (_t, input, v) => {
      const r = parse(input)
      expect(r.ok).toBe(false)
      if (v.exact) expect(r.error).toBe(v.exact)
      for (const s of v.contains || []) expect(r.error).toContain(s)
    })

    test.each(set.format.map((v) => [v.test, v]))('format %s', (_t, v) => {
      expect(formatIcebergMode(modeOf(v))).toBe(v.expected)
    })

    test.each(set.roundtrip.map((v) => [v.test, v]))('string round-trip %s', (_t, v) => {
      const m = modeOf(v)
      const s1 = formatIcebergMode(m)
      const r = parse(s1)
      expect(r.ok).toBe(true)
      expect(r.mode).toEqual(m)
      expect(formatIcebergMode(r.mode)).toBe(s1)
    })
  })
})

describe('generated release data', () => {
  const parsers = Object.entries(RELEASES.parsers)

  // The port implements each parser's structure in code. A fingerprint that is
  // not in PORTED_PARSERS is a parser nobody has checked this code against.
  test.each(parsers.map(([fp, p]) => [p.firstTag, fp]))('the parser first released in %s has been ported (%s)', (_tag, fp) => {
    expect(PORTED_PARSERS).toHaveProperty(fp)
  })

  test('PORTED_PARSERS names no parser the data no longer has', () => {
    expect(Object.keys(PORTED_PARSERS).sort()).toEqual(parsers.map(([fp]) => fp).sort())
  })

  test.each(parsers.map(([, p]) => [p.firstTag, p]))('every legacy name %s accepts has a meaning here', (_tag, p) => {
    for (const name of p.legacyNames) expect(LEGACY_NAMES).toHaveProperty(name)
  })

  // The grammar each series accepts, checked from the data itself, so a
  // series without upstream test cases is still exercised.
  const series = Object.entries(RELEASES.series).filter(([, history]) => history.length)
  describe.each(series)('series %s', (name, history) => {
    const { grammar } = releaseFor(name)
    const last = history[history.length - 1]

    test('resolves to its newest parser', () => {
      expect(releaseFor(name).parser).toBe(last.parser)
    })

    test.each(RELEASES.parsers[last.parser].legacyNames)('accepts the legacy name %s', (legacy) => {
      expect(validateIcebergMode(legacy, { version: name })).toMatchObject({ ok: true, canonical: legacy })
    })

    test('accepts value_schema_latest options exactly when its parser has them', () => {
      const r = validateIcebergMode('value_schema_latest:subject=s,protobuf_name=p', { version: name })
      expect(r.ok).toBe(Boolean(grammar.legacySchemaLatest))
    })

    test('accepts the section format exactly when its parser has it', () => {
      expect(validateIcebergMode('headers:value_type=string', { version: name }).ok).toBe(Boolean(grammar.sections))
      expect(supportsSectionFormat(name)).toBe(Boolean(grammar.sections))
    })
  })

  test('a series with no iceberg_mode parser reports that the property does not exist', () => {
    const none = Object.keys(RELEASES.series).find((k) => RELEASES.series[k].length === 0)
    expect(none).toBeDefined()
    expect(validateIcebergMode('key_value', { version: none })).toMatchObject({
      ok: false,
      error: `Redpanda ${none} has no redpanda.iceberg.mode property`,
    })
  })

  // config_utils.h refuses an extended value until the cluster runs the
  // release that introduced the section format. The two come from different
  // files, so a mismatch means one of them was read wrong.
  test('the cluster upgrade gate names the first release with the section format', () => {
    const gates = Object.values(RELEASES.series).flat().map((h) => h.clusterGate).filter(Boolean)
    expect(gates.length).toBeGreaterThan(0)
    const first = Object.values(RELEASES.series).flat()
      .filter((h) => RELEASES.parsers[h.parser].sections && !/-rc/.test(h.since))
      .map((h) => h.since).sort()[0]
    for (const gate of gates) expect(gate).toBe(first)
  })
})

describe('redpanda.iceberg.mode parser details beyond the upstream vectors', () => {
  // Upstream reports these with a generic "malformed options" message; the
  // port keeps that message verbatim and adds the specific reason.
  test.each([
    ['value:mode=binary,mode=schema_id_prefix', "duplicate option 'mode'"],
    ['value:mode=', "option 'mode' has no value"],
    ['value:mode', "option 'mode' has no value"],
    ['value:=binary', "option '=binary' has no name"],
  ])('%s is malformed: %s', (input, reason) => {
    expect(parseIcebergMode(input)).toEqual({
      ok: false,
      error: "malformed options in section 'value'",
      reason,
    })
  })

  test.each([
    ['', 'empty section in iceberg_mode config'],
    ['key:;', 'empty section in iceberg_mode config'],
    ['key_value ', "missing ':' in section 'key_value '"],
    ['value_schema_latest_x', "expected ':' or end of string after 'value_schema_latest'"],
    ['value_schema_latest:', "expected options after ':' in value_schema_latest"],
    ['value_schema_latest:subject=a,subject=b', 'malformed options in value_schema_latest'],
    ['value:subject=foo', "subject and protobuf_name require mode=schema_latest in section 'value'"],
  ])('rejects %j with %j', (input, error) => {
    expect(parseIcebergMode(input)).toMatchObject({ ok: false, error })
  })

  // Upstream splits each option on the first '=' only.
  test('an option value may contain "="', () => {
    const r = parseIcebergMode('value:mode=schema_latest,subject=a=b')
    expect(r.ok).toBe(true)
    expect(r.mode.value.subject).toBe('a=b')
  })

  test('reports which grammar the string used', () => {
    expect(parseIcebergMode('disabled').format).toBe('disabled')
    expect(parseIcebergMode('value_schema_latest:subject=x').format).toBe('legacy')
    expect(parseIcebergMode('value:mode=schema_id_prefix').format).toBe('sections')
  })
})

describe('version gating', () => {
  test.each([
    ['26.2', true], ['26.3', true], ['v26.2', true], ['26.2.1', true],
    ['26.1', false], ['25.3', false], ['24.3', false], ['v26.1.20', false],
    ['', true], [undefined, true], ['master', true], ['beta', true],
    // No release data at all: not claimed either way.
    ['27.0', false], ['23.3', false],
  ])('supportsSectionFormat(%j) is %s', (version, expected) => {
    expect(supportsSectionFormat(version)).toBe(expected)
  })

  test.each(['disabled', 'key_value', 'value_schema_id_prefix', 'value_schema_latest:subject=x,protobuf_name=y'])(
    'a 26.1 page accepts the legacy value %s', (input) => {
      expect(validateIcebergMode(input, { version: '26.1' })).toMatchObject({ ok: true, release: 'v26.1.1' })
    }
  )

  test('a 26.1 page rejects a valid section-format value and names the first release', () => {
    const r = validateIcebergMode('key:mode=schema_id_prefix;value:mode=binary', { version: '26.1' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/section format .* requires Redpanda v26\.2\.1 or later/)
    expect(r.error).toContain('26.1')
  })

  // value:mode=schema_id_prefix normalizes to a legacy name on 26.2, but a
  // 26.1 broker never parses the section syntax, so it is still an error.
  test('a 26.1 page rejects a section-format value even when it is legacy-equivalent', () => {
    expect(validateIcebergMode('value:mode=schema_id_prefix', { version: '26.1' }).ok).toBe(false)
  })

  test('a 26.1 page reports garbage with the legacy forms it accepts', () => {
    const r = validateIcebergMode('banana', { version: '26.1' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not a value Redpanda 26\.1 accepts/)
    expect(r.error).toContain('value_schema_latest with optional :protobuf_name=<name>,subject=<name>')
  })

  // Before v26.2.1 Redpanda rejects a bad value without a reason, so the
  // error is generic and the port's detail is the reason.
  test('a 26.1 page explains a bad value_schema_latest option as a reason', () => {
    expect(validateIcebergMode('value_schema_latest:bogus=1', { version: '26.1' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^not a value Redpanda 26\.1 accepts/),
      reason: "unknown option 'bogus' in value_schema_latest",
    })
  })

  // 24.3's parser compares against three names only.
  test('a 24.3 page rejects value_schema_latest and names the first release with it', () => {
    const r = validateIcebergMode('value_schema_latest', { version: '24.3' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/^value_schema_latest requires Redpanda v25\.1\.1 or later, and this page documents 24\.3/)
    expect(r.error).toContain('disabled, key_value, or value_schema_id_prefix')
  })

  test('a 24.3 page rejects the section format with only the names it accepts', () => {
    const r = validateIcebergMode('headers:value_type=string', { version: '24.3' })
    expect(r.error).toMatch(/requires Redpanda v26\.2\.1 or later/)
    expect(r.error).not.toContain('value_schema_latest')
  })

  test('a 26.2 page accepts the section format and returns the canonical string', () => {
    expect(validateIcebergMode('headers:value_type=string', { version: '26.2' })).toMatchObject({
      ok: true,
      canonical: 'key:mode=binary;value:mode=binary,layout=flat;headers:value_type=string',
    })
  })

  test('a 26.2 page reports the broker message verbatim', () => {
    expect(validateIcebergMode('value:mode=banana', { version: '26.2' })).toEqual({
      ok: false,
      error: "unknown mode 'banana' in section 'value'",
    })
  })

  test('an unversioned page uses the newest GA release, not a release candidate', () => {
    const latest = releaseFor('')
    expect(latest.since).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(validateIcebergMode('value:mode=string').ok).toBe(true)
    expect(validateIcebergMode('value:mode=banana').ok).toBe(false)
  })

  test('a version the data does not cover is reported as unchecked, not borrowed', () => {
    const r = validateIcebergMode('key_value', { version: '27.0' })
    expect(r).toMatchObject({ ok: false, unverified: true })
    expect(r.error).toContain('no Redpanda release for version 27.0')
  })

  test('a patch version uses the parser that patch shipped', () => {
    expect(releaseFor('26.2.3').since).toBe('v26.2.1')
    expect(releaseFor('26.2.0')).toBeNull()
  })
})
