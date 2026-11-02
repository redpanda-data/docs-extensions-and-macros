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

describe('array descriptions', () => {
  // An array is the audience-scoped paragraph form of a description, and it
  // reaches this pass BEFORE applyPropertyLinks flattens it. The
  // `typeof text !== 'string'` guard returned the array untouched, so a
  // config_ref inside a scoped paragraph survived into the published page as
  // literal text, contradicting this pass's contract of emitting the prop
  // macro regardless of what the input or the overrides carry.
  it('converts a config_ref inside every paragraph', () => {
    const out = convertConfigRefsToProp([
      'Base prose with config_ref:admin,true,properties/broker-properties[`admin`].',
      'cloud-only: Scoped prose with config_ref:rpc_server,true,properties/broker-properties[`rpc_server`].'
    ])
    expect(Array.isArray(out)).toBe(true)
    expect(out[0]).toBe('Base prose with prop:admin[link=true].')
    expect(out[1]).toBe('cloud-only: Scoped prose with prop:rpc_server[link=true].')
  })

  it('leaves the audience prefix intact so the flatten pass can still read it', () => {
    const out = convertConfigRefsToProp(['cloud-only: config_ref:admin,true,x[`admin`].'])
    expect(out[0].startsWith('cloud-only: ')).toBe(true)
  })

  it('still passes a plain string through unchanged in behaviour', () => {
    expect(convertConfigRefsToProp('See config_ref:admin,true,x[`admin`].'))
      .toBe('See prop:admin[link=true].')
  })
})
