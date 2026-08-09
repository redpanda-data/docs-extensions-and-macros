'use strict'

const {
  dashify,
  ensurePeriod,
  shortDescription,
  flagType,
  eq,
  ne,
  or,
  and,
  not,
  join,
  length,
  gt,
  lt,
  includes,
  uppercase,
  lowercase,
  capitalize,
  toSentenceCase,
  formatFlagName,
  formatDefault,
  hasDefaultValue,
  parentPath,
  isPluginCommand
} = require('../../../tools/rpk-docs/helpers/index.js')

describe('rpk Docs Helpers', () => {
  describe('dashify', () => {
    test('converts spaces to dashes', () => {
      expect(dashify('rpk topic create')).toBe('rpk-topic-create')
    })

    test('handles multiple spaces', () => {
      expect(dashify('rpk  topic   create')).toBe('rpk-topic-create')
    })

    test('handles empty string', () => {
      expect(dashify('')).toBe('')
    })

    test('handles null/undefined', () => {
      expect(dashify(null)).toBe('')
      expect(dashify(undefined)).toBe('')
    })
  })

  describe('ensurePeriod', () => {
    test('adds period if missing', () => {
      expect(ensurePeriod('Hello')).toBe('Hello.')
    })

    test('does not add period if already present', () => {
      expect(ensurePeriod('Hello.')).toBe('Hello.')
    })

    test('handles question marks', () => {
      expect(ensurePeriod('Hello?')).toBe('Hello?')
    })

    test('handles exclamation marks', () => {
      expect(ensurePeriod('Hello!')).toBe('Hello!')
    })

    test('handles empty string', () => {
      expect(ensurePeriod('')).toBe('')
    })

    test('handles null/undefined', () => {
      expect(ensurePeriod(null)).toBe('')
      expect(ensurePeriod(undefined)).toBe('')
    })

    test('trims whitespace', () => {
      expect(ensurePeriod('  Hello  ')).toBe('Hello.')
    })
  })

  describe('shortDescription', () => {
    test('returns full string for short description', () => {
      expect(shortDescription('Short description.')).toBe('Short description.')
    })

    test('truncates to two sentences', () => {
      const input = 'First sentence. Second sentence. Third sentence. Fourth sentence.'
      const expected = 'First sentence. Second sentence.'
      expect(shortDescription(input)).toBe(expected)
    })

    test('preserves abbreviations like e.g.', () => {
      const input = 'Use e.g. this option. It works well. Third sentence.'
      const result = shortDescription(input)
      expect(result).toContain('e.g.')
      expect(result.split('. ').length).toBeLessThanOrEqual(3)
    })

    test('handles empty string', () => {
      expect(shortDescription('')).toBe('')
    })

    test('handles null/undefined', () => {
      expect(shortDescription(null)).toBe('')
      expect(shortDescription(undefined)).toBe('')
    })
  })

  describe('flagType', () => {
    test('returns flag type', () => {
      expect(flagType({ type: 'string' })).toBe('string')
    })

    test('returns dash for missing type', () => {
      expect(flagType({})).toBe('-')
    })

    test('returns dash for null flag', () => {
      expect(flagType(null)).toBe('-')
    })
  })

  describe('equality helpers', () => {
    test('eq returns true for equal values', () => {
      expect(eq(1, 1)).toBe(true)
      expect(eq('foo', 'foo')).toBe(true)
      expect(eq(true, true)).toBe(true)
    })

    test('eq returns false for unequal values', () => {
      expect(eq(1, 2)).toBe(false)
      expect(eq('foo', 'bar')).toBe(false)
      expect(eq(1, '1')).toBe(false) // strict equality
    })

    test('ne returns true for unequal values', () => {
      expect(ne(1, 2)).toBe(true)
      expect(ne('foo', 'bar')).toBe(true)
    })

    test('ne returns false for equal values', () => {
      expect(ne(1, 1)).toBe(false)
    })
  })

  describe('logical helpers', () => {
    // Note: or/and take Handlebars options as last arg, so we pass a dummy object
    const options = {}

    test('or returns true if any value is truthy', () => {
      expect(or(false, true, options)).toBe(true)
      expect(or(true, false, options)).toBe(true)
    })

    test('or returns false if all values are falsy', () => {
      expect(or(false, null, options)).toBe(false)
    })

    test('and returns true if all values are truthy', () => {
      expect(and(true, true, options)).toBe(true)
      expect(and(1, 'foo', options)).toBe(true)
    })

    test('and returns false if any value is falsy', () => {
      expect(and(true, false, options)).toBe(false)
    })

    test('not negates value', () => {
      expect(not(true)).toBe(false)
      expect(not(false)).toBe(true)
      expect(not('')).toBe(true)
      expect(not('foo')).toBe(false)
    })
  })

  describe('array helpers', () => {
    test('join joins array elements', () => {
      expect(join(['a', 'b', 'c'], ', ')).toBe('a, b, c')
    })

    test('join returns non-arrays as-is', () => {
      expect(join('foo', ', ')).toBe('foo')
    })

    test('length returns array length', () => {
      expect(length([1, 2, 3])).toBe(3)
      expect(length([])).toBe(0)
    })

    test('length returns string length', () => {
      expect(length('hello')).toBe(5)
    })

    test('length returns 0 for null/undefined', () => {
      expect(length(null)).toBe(0)
      expect(length(undefined)).toBe(0)
    })

    test('includes checks if value is in array', () => {
      expect(includes('b', ['a', 'b', 'c'])).toBe(true)
      expect(includes('d', ['a', 'b', 'c'])).toBe(false)
    })

    test('includes returns false for non-arrays', () => {
      expect(includes('a', 'abc')).toBe(false)
    })
  })

  describe('comparison helpers', () => {
    test('gt compares numbers', () => {
      expect(gt(5, 3)).toBe(true)
      expect(gt(3, 5)).toBe(false)
      expect(gt(3, 3)).toBe(false)
    })

    test('lt compares numbers', () => {
      expect(lt(3, 5)).toBe(true)
      expect(lt(5, 3)).toBe(false)
      expect(lt(3, 3)).toBe(false)
    })
  })

  describe('string case helpers', () => {
    test('uppercase converts to uppercase', () => {
      expect(uppercase('hello')).toBe('HELLO')
    })

    test('lowercase converts to lowercase', () => {
      expect(lowercase('HELLO')).toBe('hello')
    })

    test('capitalize capitalizes first letter', () => {
      expect(capitalize('hello')).toBe('Hello')
      expect(capitalize('HELLO')).toBe('HELLO')
    })

    test('toSentenceCase capitalizes first letter of sentences', () => {
      expect(toSentenceCase('hello world. goodbye world')).toBe('Hello world. Goodbye world')
    })

    test('string helpers handle empty/null', () => {
      expect(uppercase('')).toBe('')
      expect(uppercase(null)).toBe('')
      expect(lowercase('')).toBe('')
      expect(lowercase(null)).toBe('')
      expect(capitalize('')).toBe('')
      expect(capitalize(null)).toBe('')
    })
  })

  describe('formatFlagName', () => {
    test('formats flag without shorthand', () => {
      expect(formatFlagName({ name: 'verbose' })).toBe('--verbose')
    })

    test('formats flag with shorthand', () => {
      expect(formatFlagName({ name: 'verbose', shorthand: 'v' })).toBe('-v, --verbose')
    })

    test('handles null flag', () => {
      expect(formatFlagName(null)).toBe('')
    })
  })

  describe('formatDefault', () => {
    test('formats string values', () => {
      expect(formatDefault('hello', 'string')).toBe('hello')
    })

    test('formats empty string', () => {
      expect(formatDefault('', 'string')).toBe('""')
    })

    test('formats boolean values', () => {
      expect(formatDefault(true, 'bool')).toBe('true')
      expect(formatDefault(false, 'bool')).toBe('false')
    })

    test('formats array values', () => {
      expect(formatDefault(['a', 'b'], 'array')).toBe('[a, b]')
      expect(formatDefault([], 'array')).toBe('[]')
    })

    test('formats undefined/null', () => {
      expect(formatDefault(undefined, 'string')).toBe('')
      expect(formatDefault(null, 'string')).toBe('')
    })
  })

  describe('hasDefaultValue', () => {
    test('returns true for meaningful defaults', () => {
      expect(hasDefaultValue({ default: 'hello' })).toBe(true)
      expect(hasDefaultValue({ default: 42 })).toBe(true)
      expect(hasDefaultValue({ default: true })).toBe(true)
    })

    test('returns false for empty/false defaults', () => {
      expect(hasDefaultValue({ default: '' })).toBe(false)
      expect(hasDefaultValue({ default: false })).toBe(false)
      expect(hasDefaultValue({ default: [] })).toBe(false)
      expect(hasDefaultValue({ default: null })).toBe(false)
      expect(hasDefaultValue({ default: undefined })).toBe(false)
    })

    test('returns false for null flag', () => {
      expect(hasDefaultValue(null)).toBe(false)
    })
  })

  describe('parentPath', () => {
    test('returns parent command path', () => {
      expect(parentPath('rpk topic create')).toBe('rpk topic')
      expect(parentPath('rpk cluster config set')).toBe('rpk cluster config')
    })

    test('returns empty string for single command', () => {
      expect(parentPath('rpk')).toBe('')
    })

    test('handles empty/null', () => {
      expect(parentPath('')).toBe('')
      expect(parentPath(null)).toBe('')
    })
  })

  describe('isPluginCommand', () => {
    const pluginVersions = {
      connect: '4.94.0',
      ai: '1.0.0'
    }

    test('returns true for plugin commands', () => {
      expect(isPluginCommand('rpk connect run', pluginVersions)).toBe(true)
      expect(isPluginCommand('rpk ai chat', pluginVersions)).toBe(true)
    })

    test('returns false for non-plugin commands', () => {
      expect(isPluginCommand('rpk topic create', pluginVersions)).toBe(false)
      expect(isPluginCommand('rpk cluster config', pluginVersions)).toBe(false)
    })

    test('returns false for single command', () => {
      expect(isPluginCommand('rpk', pluginVersions)).toBe(false)
    })

    test('handles null inputs', () => {
      expect(isPluginCommand(null, pluginVersions)).toBe(false)
      expect(isPluginCommand('rpk connect', null)).toBe(false)
    })
  })
})
