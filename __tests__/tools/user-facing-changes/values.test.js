'use strict'

const { canonicalValue, sameValue } = require('../../../tools/user-facing-changes/values')

describe('canonicalValue (C++)', () => {
  test.each([
    ['std::chrono::milliseconds(150)', '150ms'],
    ['std::chrono::milliseconds{150}', 'chrono::milliseconds(150)'],
    ['std::chrono::seconds(1)', '1000ms'],
    ['1h', 'std::chrono::minutes(60)'],
    ['5min * 2', '10min'],
    ['std::chrono::duration_cast<std::chrono::seconds>(1500ms)', '1s'],
    ['128_MiB', '134217728'],
    ['1_GiB', '1024 * 1024 * 1024'],
    ['134\'217\'728', '134217728'],
    ['128ul', '0x80'],
    ['1.0', '1'],
    ['true', ' true '],
    ['"abc"', '"a" "bc"'],
    ['ss::sstring{"abc"}', '"abc"s']
  ])('%s and %s are the same value', (a, b) => {
    expect(canonicalValue(a)).not.toBeNull()
    expect(canonicalValue(a)).toBe(canonicalValue(b))
    expect(sameValue(a, b)).toBe(true)
  })

  test.each([
    ['150ms', '200ms'],
    ['std::chrono::seconds(1)', '1001ms'],
    ['128_MiB', '256_MiB'],
    ['128_MiB', '128'],
    ['150ms', '150'],
    ['true', 'false'],
    ['"abc"', '"abd"'],
    ['1', '"1"']
  ])('%s and %s differ', (a, b) => {
    expect(sameValue(a, b)).toBe(false)
  })

  test('forms it does not understand are null and compare as text', () => {
    for (const t of ['std::nullopt', 'model::compression::zstd', 'default_rpc_conns', 'std::chrono::seconds(1500ms)', '1d', 'f(1)']) {
      expect(canonicalValue(t)).toBeNull()
    }
    expect(sameValue('model::x', 'model::x')).toBe(true)
    expect(sameValue('model::x', 'model::y')).toBe(false)
    expect(sameValue('std::nullopt', '0')).toBe(false)
  })
})

describe('canonicalValue (Go)', () => {
  test('separators, raw strings and time durations', () => {
    expect(sameValue('1_000', '1000', 'go')).toBe(true)
    expect(sameValue('`x`', '"x"', 'go')).toBe(true)
    expect(sameValue('5 * time.Second', 'time.Second*5', 'go')).toBe(true)
    expect(sameValue('1', '3', 'go')).toBe(false)
    expect(canonicalValue('defaultPartitions', 'go')).toBeNull()
  })
})
