'use strict'

const {
  parseIcebergMode,
  formatIcebergMode,
  validateIcebergMode,
  supportsSectionFormat,
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

const modeOf = (v) => (v.fields ? fromFields(v.fields) : parseIcebergMode(v.input).mode)

describe('redpanda.iceberg.mode parser against upstream vectors', () => {
  test('the fixture names its upstream source', () => {
    expect(vectors.UPSTREAM.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(vectors.UPSTREAM.file).toBe('src/v/model/tests/iceberg_mode_test.cc')
  })

  describe('accept', () => {
    test.each(vectors.accept.map((v) => [v.test, v.input, v]))('%s: %s', (_t, input, v) => {
      const r = parseIcebergMode(input)
      expect(r).toMatchObject({ ok: true })
      if (v.expect.disabled) {
        expect(r.mode.disabled).toBe(true)
        return
      }
      expect(r.mode.disabled).toBe(false)
      for (const [dotted, value] of Object.entries(v.expect)) {
        expect(get(r.mode, dotted)).toBe(value)
      }
      if (v.equals) expect(r.mode).toEqual(parseIcebergMode(v.equals).mode)
    })
  })

  describe('reject', () => {
    test.each(vectors.reject.map((v) => [v.test, v.input]))('%s: %s', (_t, input) => {
      const r = parseIcebergMode(input)
      expect(r.ok).toBe(false)
      expect(typeof r.error).toBe('string')
      expect(r.error.length).toBeGreaterThan(0)
    })
  })

  describe('error messages', () => {
    test.each(vectors.errorMessages.map((v) => [v.test, v.input, v]))('%s: %s', (_t, input, v) => {
      const r = parseIcebergMode(input)
      expect(r.ok).toBe(false)
      if (v.exact) expect(r.error).toBe(v.exact)
      for (const s of v.contains || []) expect(r.error).toContain(s)
    })
  })

  describe('format', () => {
    test.each(vectors.format.map((v) => [v.test, v]))('%s', (_t, v) => {
      expect(formatIcebergMode(modeOf(v))).toBe(v.expected)
    })
  })

  describe('string round-trip', () => {
    test.each(vectors.roundtrip.map((v) => [v.test, v]))('%s', (_t, v) => {
      const m = modeOf(v)
      const s1 = formatIcebergMode(m)
      const r = parseIcebergMode(s1)
      expect(r.ok).toBe(true)
      expect(r.mode).toEqual(m)
      expect(formatIcebergMode(r.mode)).toBe(s1)
    })
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
    ['26.2', true], ['26.3', true], ['27.0', true], ['v26.2', true], ['26.2.1', true],
    ['26.1', false], ['25.3', false], ['24.3', false], ['v26.1.20', false],
    ['', true], [undefined, true], ['master', true], ['beta', true],
  ])('supportsSectionFormat(%j) is %s', (version, expected) => {
    expect(supportsSectionFormat(version)).toBe(expected)
  })

  test.each(['disabled', 'key_value', 'value_schema_id_prefix', 'value_schema_latest:subject=x,protobuf_name=y'])(
    'a 26.1 page accepts the legacy value %s', (input) => {
      expect(validateIcebergMode(input, { version: '26.1' })).toMatchObject({ ok: true })
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
    expect(r.error).toContain('value_schema_id_prefix')
  })

  test('a 26.1 page keeps the legacy-option error', () => {
    expect(validateIcebergMode('value_schema_latest:bogus=1', { version: '26.1' })).toMatchObject({
      ok: false,
      error: "unknown option 'bogus' in value_schema_latest",
    })
  })

  test('a 26.2 page accepts the section format and returns the canonical string', () => {
    expect(validateIcebergMode('headers:value_type=string', { version: '26.2' })).toMatchObject({
      ok: true,
      canonical: 'key:mode=binary;value:mode=binary,layout=flat;headers:value_type=string',
    })
  })

  test('an unversioned page uses the latest grammar', () => {
    expect(validateIcebergMode('value:mode=string').ok).toBe(true)
    expect(validateIcebergMode('value:mode=banana').ok).toBe(false)
  })
})
