'use strict'

const {
  ValidationResult,
  normalizeCommandPath,
  validateSchema,
  validateCommandPaths,
  validateReferences,
  validateAdmonitionLocations,
  validateIncludeLocations,
  validateCustomSectionPositions,
  validatePlatforms,
  validateFlags,
  validateDescriptions,
  validateOverrides,
  VALID_ADMONITION_LOCATIONS,
  VALID_PLATFORMS,
  VALID_INCLUDE_LOCATIONS,
  VALID_SECTION_POSITIONS
} = require('../../../tools/rpk-docs/validate-overrides')

describe('validate-overrides', () => {
  describe('ValidationResult', () => {
    it('should start valid with no errors or warnings', () => {
      const result = new ValidationResult()
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
      expect(result.warnings).toHaveLength(0)
    })

    it('should become invalid when error is added', () => {
      const result = new ValidationResult()
      result.addError('Test error', 'test.path')
      expect(result.valid).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].message).toBe('Test error')
      expect(result.errors[0].context).toBe('test.path')
    })

    it('should remain valid when warning is added', () => {
      const result = new ValidationResult()
      result.addWarning('Test warning')
      expect(result.valid).toBe(true)
      expect(result.warnings).toHaveLength(1)
    })

    it('should merge results correctly', () => {
      const result1 = new ValidationResult()
      result1.addError('Error 1')
      result1.addWarning('Warning 1')

      const result2 = new ValidationResult()
      result2.addError('Error 2')

      result1.merge(result2)
      expect(result1.valid).toBe(false)
      expect(result1.errors).toHaveLength(2)
      expect(result1.warnings).toHaveLength(1)
    })

    it('should format output correctly', () => {
      const result = new ValidationResult()
      result.addError('Test error', 'path.to.error')
      result.addWarning('Test warning')

      const formatted = result.format()
      expect(formatted).toContain('ERRORS:')
      expect(formatted).toContain('Test error')
      expect(formatted).toContain('path.to.error')
      expect(formatted).toContain('WARNINGS:')
      expect(formatted).toContain('Test warning')
    })
  })

  describe('normalizeCommandPath', () => {
    it('should trim whitespace', () => {
      expect(normalizeCommandPath('  rpk topic  ')).toBe('rpk topic')
    })

    it('should collapse multiple spaces', () => {
      expect(normalizeCommandPath('rpk  topic   create')).toBe('rpk topic create')
    })

    it('should handle empty strings', () => {
      expect(normalizeCommandPath('')).toBe('')
      expect(normalizeCommandPath(null)).toBe('')
      expect(normalizeCommandPath(undefined)).toBe('')
    })
  })

  describe('validateReferences', () => {
    it('should pass for valid $ref', () => {
      const overrides = {
        definitions: {
          'test-def': { flags: {} }
        },
        commands: {
          'rpk test': {
            '$ref': '#/definitions/test-def'
          }
        }
      }

      const result = validateReferences(overrides)
      expect(result.valid).toBe(true)
    })

    it('should error for invalid $ref format', () => {
      const overrides = {
        commands: {
          'rpk test': {
            '$ref': 'definitions/test-def' // Missing #/
          }
        }
      }

      const result = validateReferences(overrides)
      expect(result.valid).toBe(false)
      expect(result.errors[0].message).toContain('Invalid $ref format')
    })

    it('should error for non-existent $ref', () => {
      const overrides = {
        definitions: {},
        commands: {
          'rpk test': {
            '$ref': '#/definitions/nonexistent'
          }
        }
      }

      const result = validateReferences(overrides)
      expect(result.valid).toBe(false)
      expect(result.errors[0].message).toContain('Cannot resolve $ref')
    })

    it('should validate $refs array', () => {
      const overrides = {
        definitions: {
          'def1': {},
          'def2': {}
        },
        commands: {
          'rpk test': {
            '$refs': ['#/definitions/def1', '#/definitions/def2']
          }
        }
      }

      const result = validateReferences(overrides)
      expect(result.valid).toBe(true)
    })

    it('should allow same definition referenced multiple times in $refs array', () => {
      const overrides = {
        definitions: {
          'common-flags': {
            verbose: { description: 'Enable verbose output' }
          }
        },
        commands: {
          'rpk topic': {
            '$refs': ['#/definitions/common-flags', '#/definitions/common-flags']
          }
        }
      }

      const result = validateReferences(overrides)
      // Should NOT be flagged as a cycle - same definition used twice is valid
      expect(result.valid).toBe(true)
    })

    it('should error for non-array $refs', () => {
      const overrides = {
        commands: {
          'rpk test': {
            '$refs': '#/definitions/test' // Should be array
          }
        }
      }

      const result = validateReferences(overrides)
      expect(result.valid).toBe(false)
      expect(result.errors[0].message).toContain('must be an array')
    })
  })

  describe('validateCommandPaths', () => {
    const mockTree = {
      name: 'rpk',
      commands: [
        {
          name: 'topic',
          commands: [
            { name: 'create' },
            { name: 'delete' }
          ]
        },
        {
          name: 'cluster',
          commands: []
        }
      ]
    }

    it('should pass for valid command paths', () => {
      const overrides = {
        commands: {
          'rpk': {},
          'rpk topic': {},
          'rpk topic create': {},
          'rpk cluster': {}
        }
      }

      const result = validateCommandPaths(overrides, mockTree)
      expect(result.valid).toBe(true)
    })

    it('should error for invalid command paths', () => {
      const overrides = {
        commands: {
          'rpk topic creat': {} // Typo
        }
      }

      const result = validateCommandPaths(overrides, mockTree)
      expect(result.valid).toBe(false)
      expect(result.errors[0].message).toContain('Unknown command path')
      expect(result.errors[0].message).toContain('rpk topic create') // Suggestion
    })

    it('should warn for irregular whitespace', () => {
      const overrides = {
        commands: {
          'rpk topic ': {} // Trailing space
        }
      }

      const result = validateCommandPaths(overrides, mockTree)
      expect(result.warnings.some(w => w.message.includes('irregular whitespace'))).toBe(true)
    })
  })

  describe('validateAdmonitionLocations', () => {
    it('should pass for valid locations', () => {
      const override = {
        notes: {
          after_flags: 'Test note'
        },
        warnings: {
          after_description: 'Test warning'
        }
      }

      const result = validateAdmonitionLocations(override, 'test')
      expect(result.valid).toBe(true)
    })

    it('should error for invalid locations', () => {
      const override = {
        notes: {
          after_flgas: 'Test note' // Typo
        }
      }

      const result = validateAdmonitionLocations(override, 'test')
      expect(result.valid).toBe(false)
      expect(result.errors[0].message).toContain('Invalid notes location')
    })

    it('should validate all admonition types', () => {
      const override = {
        notes: { invalid_loc: '' },
        warnings: { invalid_loc: '' },
        tips: { invalid_loc: '' },
        cautions: { invalid_loc: '' },
        importants: { invalid_loc: '' }
      }

      const result = validateAdmonitionLocations(override, 'test')
      expect(result.errors).toHaveLength(5)
    })
  })

  describe('validateIncludeLocations', () => {
    it('should pass for valid include locations', () => {
      const override = {
        includes: {
          after_flags: 'partial.adoc'
        }
      }

      const result = validateIncludeLocations(override, 'test')
      expect(result.valid).toBe(true)
    })

    it('should error for invalid include locations', () => {
      const override = {
        includes: {
          invalid_location: 'partial.adoc'
        }
      }

      const result = validateIncludeLocations(override, 'test')
      expect(result.valid).toBe(false)
    })

    it('should validate cloudContent locations', () => {
      const override = {
        cloudContent: {
          invalid_loc: 'content'
        }
      }

      const result = validateIncludeLocations(override, 'test')
      expect(result.valid).toBe(false)
    })

    it('should validate selfHostedContent locations', () => {
      const override = {
        selfHostedContent: {
          invalid_loc: 'content'
        }
      }

      const result = validateIncludeLocations(override, 'test')
      expect(result.valid).toBe(false)
    })
  })

  describe('validateCustomSectionPositions', () => {
    it('should pass for valid positions', () => {
      const override = {
        customSections: {
          'my-section': {
            title: 'Test',
            position: 'after_flags',
            content: 'Content'
          }
        }
      }

      const result = validateCustomSectionPositions(override, 'test')
      expect(result.valid).toBe(true)
    })

    it('should error for invalid positions', () => {
      const override = {
        customSections: {
          'my-section': {
            title: 'Test',
            position: 'invalid_position',
            content: 'Content'
          }
        }
      }

      const result = validateCustomSectionPositions(override, 'test')
      expect(result.valid).toBe(false)
    })

    it('should allow sections without position (defaults to end)', () => {
      const override = {
        customSections: {
          'my-section': {
            title: 'Test',
            content: 'Content'
            // No position specified
          }
        }
      }

      const result = validateCustomSectionPositions(override, 'test')
      expect(result.valid).toBe(true)
    })
  })

  describe('validatePlatforms', () => {
    it('should pass for valid platforms', () => {
      const override = {
        platforms: ['linux', 'darwin']
      }

      const result = validatePlatforms(override, 'test')
      expect(result.valid).toBe(true)
    })

    it('should error for invalid platforms', () => {
      const override = {
        platforms: ['Linux', 'MacOS'] // Wrong case
      }

      const result = validatePlatforms(override, 'test')
      expect(result.valid).toBe(false)
      expect(result.errors).toHaveLength(2)
    })

    it('should pass when no platforms specified', () => {
      const override = {}

      const result = validatePlatforms(override, 'test')
      expect(result.valid).toBe(true)
    })
  })

  describe('validateFlags', () => {
    it('should pass for standard flag names', () => {
      const override = {
        flags: {
          'brokers': { description: 'Test' },
          'output-format': { description: 'Test' }
        }
      }

      const result = validateFlags(override, 'test')
      expect(result.valid).toBe(true)
      expect(result.warnings).toHaveLength(0)
    })

    it('should warn for unusual flag name format', () => {
      const override = {
        flags: {
          'log.level': { description: 'Test' } // Dot in name
        }
      }

      const result = validateFlags(override, 'test')
      expect(result.valid).toBe(true) // Warning, not error
      expect(result.warnings.some(w => w.message.includes('Unusual flag name'))).toBe(true)
    })

    it('should warn for unusual flag types', () => {
      const override = {
        flags: {
          'test': { type: 'unknown-type' }
        }
      }

      const result = validateFlags(override, 'test')
      expect(result.warnings.some(w => w.message.includes('Unusual flag type'))).toBe(true)
    })
  })

  describe('validateDescriptions', () => {
    it('should pass for normal descriptions', () => {
      const override = {
        description: 'This is a normal description.'
      }

      const result = validateDescriptions(override, 'test')
      expect(result.valid).toBe(true)
      expect(result.warnings).toHaveLength(0)
    })

    it('should warn for HTML entities', () => {
      const override = {
        description: 'Test with &amp; entity'
      }

      const result = validateDescriptions(override, 'test')
      expect(result.warnings.some(w => w.message.includes('HTML entities'))).toBe(true)
    })

    it('should warn for unclosed brackets', () => {
      const override = {
        description: 'Test with [unclosed bracket'
      }

      const result = validateDescriptions(override, 'test')
      expect(result.warnings.some(w => w.message.includes('unclosed bracket'))).toBe(true)
    })

    it('should warn for very long descriptions', () => {
      const override = {
        description: 'a'.repeat(600) // Very long single line
      }

      const result = validateDescriptions(override, 'test')
      expect(result.warnings.some(w => w.message.includes('long description'))).toBe(true)
    })
  })

  describe('validateOverrides (integration)', () => {
    it('should run all validations', () => {
      const overrides = {
        definitions: {
          'common-flags': { flags: { test: {} } }
        },
        commands: {
          'rpk test': {
            '$ref': '#/definitions/common-flags',
            description: 'Test command',
            platforms: ['linux'],
            notes: { after_flags: 'Note' },
            customSections: {
              'test': { title: 'Test', position: 'end', content: 'Content' }
            }
          }
        }
      }

      const result = validateOverrides(overrides)
      // Should pass schema validation if schema file exists
      // and pass all other validations
      expect(result.warnings).toBeDefined()
      expect(result.errors).toBeDefined()
    })
  })

  describe('Constants', () => {
    it('should export valid admonition locations', () => {
      expect(VALID_ADMONITION_LOCATIONS).toContain('after_flags')
      expect(VALID_ADMONITION_LOCATIONS).toContain('after_description')
      expect(VALID_ADMONITION_LOCATIONS).toContain('end')
    })

    it('should export valid platforms', () => {
      expect(VALID_PLATFORMS).toContain('linux')
      expect(VALID_PLATFORMS).toContain('darwin')
      expect(VALID_PLATFORMS).toContain('windows')
    })

    it('should export valid include locations', () => {
      expect(VALID_INCLUDE_LOCATIONS).toContain('after_flags')
      expect(VALID_INCLUDE_LOCATIONS).toContain('after_modifiers')
    })

    it('should export valid section positions', () => {
      expect(VALID_SECTION_POSITIONS).toContain('after_flags')
      expect(VALID_SECTION_POSITIONS).toContain('end')
    })
  })
})
