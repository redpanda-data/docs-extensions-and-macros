const { describe, it, expect } = require('@jest/globals')
const { getMajorMinor, toShortVersion } = require('../../cli-utils/version')

describe('cli-utils/version', () => {
  describe('getMajorMinor (strict, used by the OpenAPI bundler)', () => {
    it('derives major.minor from a semantic version', () => {
      expect(getMajorMinor('24.3.2')).toBe('24.3')
      expect(getMajorMinor('1.0.0-rc1')).toBe('1.0')
      expect(getMajorMinor('0.0.0')).toBe('0.0')
    })

    it('returns a non-semver value unchanged so branch names survive', () => {
      expect(getMajorMinor('dev')).toBe('dev')
      expect(getMajorMinor('feature/foo')).toBe('feature/foo')
      expect(getMajorMinor('1')).toBe('1')
    })

    it('throws on empty or non-string input', () => {
      expect(() => getMajorMinor('')).toThrow('Version must be a non-empty string')
      expect(() => getMajorMinor(null)).toThrow('Version must be a non-empty string')
      expect(() => getMajorMinor(123)).toThrow('Version must be a non-empty string')
    })
  })

  describe('toShortVersion (lenient, used by the version fetcher)', () => {
    it('derives major.minor from two- and three-part versions', () => {
      expect(toShortVersion('26.2.1')).toBe('26.2')
      expect(toShortVersion('26.2')).toBe('26.2')
      expect(toShortVersion('26.2.1-rc1')).toBe('26.2')
      expect(toShortVersion('26.2.1+build.5')).toBe('26.2')
      expect(toShortVersion('0.0')).toBe('0.0')
    })

    it('normalizes a zero-padded minor', () => {
      expect(toShortVersion('26.02.1')).toBe('26.2')
      expect(toShortVersion('06.02')).toBe('6.2')
    })

    it('returns null for values that have no major.minor pair', () => {
      expect(toShortVersion('nightly')).toBeNull()
      expect(toShortVersion('latest')).toBeNull()
      expect(toShortVersion('26')).toBeNull()
      expect(toShortVersion('v26')).toBeNull()
      // The v prefix is the caller's job to strip, so it is not accepted here.
      expect(toShortVersion('v26.2.1')).toBeNull()
      expect(toShortVersion('  26.2.1')).toBeNull()
    })

    it('never throws on empty or non-string input', () => {
      expect(toShortVersion('')).toBeNull()
      expect(toShortVersion(null)).toBeNull()
      expect(toShortVersion(undefined)).toBeNull()
      expect(toShortVersion(123)).toBeNull()
    })
  })
})
