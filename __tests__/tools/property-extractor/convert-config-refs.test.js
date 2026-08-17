'use strict'

const { convertConfigRefsToProp } = require('../../../tools/property-extractor/generate-handlebars-docs')

describe('convertConfigRefsToProp (render-time safety net)', () => {
  test('converts linked calls, dropping the manual path', () => {
    expect(convertConfigRefsToProp('See config_ref:tombstone_retention_ms,true,properties/cluster-properties[].'))
      .toBe('See prop:tombstone_retention_ms[link=true].')
  })

  test('drops payloads that repeat the backticked name', () => {
    expect(convertConfigRefsToProp('Set config_ref:enable_rack_awareness,true,properties/cluster-properties[`enable_rack_awareness`].'))
      .toBe('Set prop:enable_rack_awareness[link=true].')
  })

  test('keeps differing payloads as text overrides', () => {
    expect(convertConfigRefsToProp('Use config_ref:log_segment_size,true,cluster-properties[segment size].'))
      .toBe('Use prop:log_segment_size[link=true,text=segment size].')
  })

  test('handles multiple calls and leaves other text alone', () => {
    const input = 'config_ref:a_b,true,x[] and config_ref:c_d,false[] with `plain` text.'
    expect(convertConfigRefsToProp(input)).toBe('prop:a_b[link=true] and prop:c_d[] with `plain` text.')
  })

  test('passes through non-strings and macro-free text', () => {
    expect(convertConfigRefsToProp(undefined)).toBeUndefined()
    expect(convertConfigRefsToProp('no macros here')).toBe('no macros here')
  })
})
