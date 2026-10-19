const { describe, it, expect } = require('@jest/globals')
const {
  latestStablePerLine,
  releaseLineOf,
  isOlderReleaseLine,
} = require('../../../extensions/version-fetcher/release-lines')

describe('latestStablePerLine', () => {
  it('picks the highest patch of each line by semver, not by list order', () => {
    // Docker Hub order: most recently pushed first, so 26.1.9 can follow
    // 26.1.10 and a string sort would pick 26.1.9.
    const lines = latestStablePerLine(['v26.2.4', 'v26.1.9', 'v25.3.10', 'v26.1.12', 'v25.3.9', 'v26.1.10'])

    expect(Object.fromEntries(lines)).toEqual({
      '26.2': 'v26.2.4',
      '26.1': 'v26.1.12',
      '25.3': 'v25.3.10',
    })
  })

  it('skips prereleases and legacy operator tags that embed a Redpanda version', () => {
    const lines = latestStablePerLine([
      'v26.2.1-beta.3',
      'v25.1.1-beta3-76-g869126b6',
      'v2.3.15-24.3.18',
      'v26.2.1',
    ])

    expect(Object.fromEntries(lines)).toEqual({ '26.2': 'v26.2.1' })
  })

  it('ignores tags without a v prefix and non-strings', () => {
    expect(latestStablePerLine(['26.1.3', 'latest', null, undefined]).size).toBe(0)
    expect(latestStablePerLine(undefined).size).toBe(0)
  })
})

describe('releaseLineOf', () => {
  it.each([
    ['25.3', '25.3'],
    ['26.01', '26.1'],
    ['26.2.1', null],
    ['main', null],
    [null, null],
    [undefined, null],
  ])('maps %p to %p', (version, line) => {
    expect(releaseLineOf(version)).toBe(line)
  })
})

describe('isOlderReleaseLine', () => {
  it('is true only for a major.minor version below the latest one', () => {
    expect(isOlderReleaseLine('25.3', '26.2')).toBe(true)
    expect(isOlderReleaseLine('26.1', '26.2')).toBe(true)
    // Numeric, not lexical: 26.10 is newer than 26.9.
    expect(isOlderReleaseLine('26.9', '26.10')).toBe(true)
    expect(isOlderReleaseLine('26.10', '26.9')).toBe(false)
  })

  it('is false for the latest version, prereleases ahead of it, and unversioned components', () => {
    expect(isOlderReleaseLine('26.2', '26.2')).toBe(false)
    expect(isOlderReleaseLine('26.3', '26.2')).toBe(false)
    expect(isOlderReleaseLine(null, null)).toBe(false)
    expect(isOlderReleaseLine('~', '~')).toBe(false)
    expect(isOlderReleaseLine('4.x', '5.x')).toBe(false)
  })
})
