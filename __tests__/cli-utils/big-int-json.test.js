'use strict'

const bigIntJson = require('../../cli-utils/big-int-json')

const UINT64_MAX = '18446744073709551615'
const INT64_MAX = '9223372036854775807'
const INT64_MIN = '-9223372036854775808'

describe('big-int-json', () => {
  describe('the values that started this', () => {
    // The three limits carried by real property data. A plain round trip loses
    // all three, which is what shipped on the docs site for four months.
    test.each([UINT64_MAX, INT64_MAX, INT64_MIN])('%s survives a round trip', (digits) => {
      const text = `{"maximum":${digits}}`
      expect(bigIntJson.stringify(bigIntJson.parse(text))).toBe(text)
      expect(JSON.stringify(JSON.parse(text))).not.toBe(text)
    })

    test('the parsed value prints exactly, which is what a template or tooltip does', () => {
      const parsed = bigIntJson.parse(`{"maximum":${UINT64_MAX}}`)
      expect(String(parsed.maximum)).toBe(UINT64_MAX)
      expect(`max: ${parsed.maximum}`).toBe(`max: ${UINT64_MAX}`)
      expect(typeof parsed.maximum).toBe('bigint')
    })
  })

  describe('leaves everything else alone', () => {
    test('numbers inside the safe range stay numbers', () => {
      const parsed = bigIntJson.parse('{"a":0,"b":-1,"c":9007199254740991,"d":1.5,"e":1e3}')
      expect(parsed).toEqual({ a: 0, b: -1, c: 9007199254740991, d: 1.5, e: 1000 })
      for (const value of Object.values(parsed)) expect(typeof value).toBe('number')
    })

    test('a long digit run inside a string is not a number', () => {
      const text = `{"description":"the maximum is ${UINT64_MAX} bytes","note":"${INT64_MIN}"}`
      const parsed = bigIntJson.parse(text)
      expect(typeof parsed.description).toBe('string')
      expect(typeof parsed.note).toBe('string')
      expect(bigIntJson.stringify(parsed)).toBe(text)
    })

    test('handles arrays, nesting, and null', () => {
      const text = `{"a":[1,${UINT64_MAX},null],"b":{"c":${INT64_MAX}}}`
      const parsed = bigIntJson.parse(text)
      expect(String(parsed.a[1])).toBe(UINT64_MAX)
      expect(String(parsed.b.c)).toBe(INT64_MAX)
      expect(parsed.a[2]).toBeNull()
      expect(bigIntJson.stringify(parsed)).toBe(text)
    })

    test('preserves indentation when asked', () => {
      const parsed = bigIntJson.parse(`{"maximum":${UINT64_MAX}}`)
      expect(bigIntJson.stringify(parsed, 2)).toBe(`{\n  "maximum": ${UINT64_MAX}\n}`)
    })

    test('invalid JSON still throws', () => {
      expect(() => bigIntJson.parse('{"a":')).toThrow()
    })
  })

  describe('round-trips a real dataset shape', () => {
    test('every unsafe literal comes back identical', () => {
      const source = `{"properties":{"a":{"minimum":0,"maximum":${UINT64_MAX}},` +
        `"b":{"minimum":${INT64_MIN},"maximum":${INT64_MAX}},` +
        `"c":{"minimum":1,"maximum":100}}}`
      expect(bigIntJson.stringify(bigIntJson.parse(source))).toBe(source)
    })
  })

  // Measured across the real datasets: a plain round trip changes 42 literals,
  // of which 28 are wrong values and 14 are formatting -- Python writes 20.0 and
  // 1e-05 where JS writes 20 and 0.00001. Those are the same number, so they are
  // deliberately not preserved; only the values a reader would be misled by are.
  describe('formatting differences are not preserved, only values', () => {
    test.each([
      ['20.0', '20'],
      ['1e-05', '0.00001'],
      ['0.0', '0'],
    ])('%s is emitted as %s, the same number', (source, emitted) => {
      expect(bigIntJson.stringify(bigIntJson.parse(`{"v":${source}}`))).toBe(`{"v":${emitted}}`)
      expect(Number(source)).toBe(Number(emitted))
    })
  })

  // A peer's review of a sibling PR's own lossless-JSON module named this class
  // of defect for a regex-based approach; testing it against this module found
  // it is not theoretical here either.
  describe('JSON-shaped text inside an escaped string', () => {
    test('a Bloblang example value with an escaped colon-number-brace is left alone', () => {
      // The real, published shape: a string field whose value is itself an
      // escaped JSON snippet used as a config example. The regex this module
      // used to have inserted a sentinel inside the string and corrupted it.
      const text = '{"example":"{\\"delay_for_ns\\":110839937000000000}","max":9223372036854775807}'
      expect(bigIntJson.parse(text)).toEqual({ example: '{"delay_for_ns":110839937000000000}', max: 9223372036854775807n })
      expect(bigIntJson.stringify(bigIntJson.parse(text))).toBe(text)
    })

    test('escaped quotes and backslashes do not end a string early', () => {
      const text = '{"a":"x\\\\","b":"\\" 9223372036854775807 \\"","c":-9223372036854775808}'
      expect(bigIntJson.parse(text)).toEqual({ a: 'x\\', b: '" 9223372036854775807 "', c: -9223372036854775808n })
    })

    test('fractions and exponents stay plain numbers', () => {
      expect(bigIntJson.parse('[12345678901234567.5,1e30,-2E+20]')).toEqual([12345678901234567.5, 1e30, -2e20])
    })

    test('a real Connect attachment fixture round-trips unchanged', () => {
      const fs = require('fs')
      const path = require('path')
      const file = path.join(__dirname, '../fixtures/connect-release-attachment/connect-4.115.1.json')
      const raw = fs.readFileSync(file, 'utf8')
      expect(JSON.parse(bigIntJson.stringify(bigIntJson.parse(raw)))).toEqual(JSON.parse(raw))
    })
  })

  describe('isUnsafeInteger', () => {
    test.each([
      ['0', false],
      ['9007199254740991', false],
      ['9007199254740993', true],
      [UINT64_MAX, true],
      [INT64_MIN, true],
    ])('%s -> %s', (digits, expected) => {
      expect(bigIntJson.isUnsafeInteger(digits)).toBe(expected)
    })
  })
})
