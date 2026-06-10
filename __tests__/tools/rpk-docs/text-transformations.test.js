const { describe, it, expect, beforeEach } = require('@jest/globals')
const path = require('path')
const fs = require('fs')

// Import the generation function
const { generateRpkDocs } = require('../../../tools/rpk-docs/generate-rpk-docs')

describe('Text Transformations', () => {
  describe('Schema Validation', () => {
    it('should have textTransformations in schema', () => {
      const schemaPath = path.join(__dirname, '../../../docs-data/rpk-overrides.schema.json')
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))

      expect(schema.properties).toHaveProperty('textTransformations')
      expect(schema.properties.textTransformations.type).toBe('object')
      expect(schema.properties.textTransformations.properties).toHaveProperty('replacements')
      expect(schema.properties.textTransformations.properties).toHaveProperty('inlineCode')
    })

    it('should validate replacement pattern structure', () => {
      const schemaPath = path.join(__dirname, '../../../docs-data/rpk-overrides.schema.json')
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))

      const replacementsSchema = schema.properties.textTransformations.properties.replacements
      expect(replacementsSchema.type).toBe('array')
      expect(replacementsSchema.items.properties).toHaveProperty('pattern')
      expect(replacementsSchema.items.properties).toHaveProperty('replacement')
      expect(replacementsSchema.items.required).toContain('pattern')
      expect(replacementsSchema.items.required).toContain('replacement')
    })

    it('should validate inlineCode pattern structure', () => {
      const schemaPath = path.join(__dirname, '../../../docs-data/rpk-overrides.schema.json')
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))

      const inlineCodeSchema = schema.properties.textTransformations.properties.inlineCode
      expect(inlineCodeSchema.type).toBe('array')
      // inlineCode supports both string and object formats
      expect(inlineCodeSchema.items.oneOf).toBeDefined()
    })
  })

  describe('Default Transformations', () => {
    it('should have default transformations in rpk-overrides.json', () => {
      const overridesPath = path.join(__dirname, '../../../docs-data/rpk-overrides.json')
      const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))

      expect(overrides).toHaveProperty('textTransformations')
      expect(overrides.textTransformations).toHaveProperty('inlineCode')
      expect(Array.isArray(overrides.textTransformations.inlineCode)).toBe(true)
      expect(overrides.textTransformations.inlineCode.length).toBeGreaterThan(0)
    })

    it('should include STDOUT/STDERR transformation', () => {
      const overridesPath = path.join(__dirname, '../../../docs-data/rpk-overrides.json')
      const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))

      const stdoutPattern = overrides.textTransformations.inlineCode.find(
        rule => (typeof rule === 'string' ? rule : rule.pattern).includes('STDOUT')
      )
      expect(stdoutPattern).toBeDefined()

      const stderrPattern = overrides.textTransformations.inlineCode.find(
        rule => (typeof rule === 'string' ? rule : rule.pattern).includes('STDERR')
      )
      expect(stderrPattern).toBeDefined()
    })

    it('should include underscore topic transformation', () => {
      const overridesPath = path.join(__dirname, '../../../docs-data/rpk-overrides.json')
      const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))

      const underscorePattern = overrides.textTransformations.inlineCode.find(
        rule => {
          const pattern = typeof rule === 'string' ? rule : rule.pattern
          return pattern.includes('_[a-z]') || (rule.description && rule.description.includes('underscore'))
        }
      )
      expect(underscorePattern).toBeDefined()
    })
  })

  describe('Integration Test', () => {
    it('should apply transformations during generation', async () => {
      // Create a minimal test tree
      const testTree = {
        name: 'rpk',
        commands: [
          {
            name: 'test-cmd',
            description: 'Output to STDOUT and STDERR using _redpanda.test_topic',
            usage: 'rpk test-cmd [flags]',
            flags: []
          }
        ],
        global_flags: []
      }

      // Create test transformations
      const testOverrides = {
        textTransformations: {
          inlineCode: [
            {
              pattern: '(?<!`)\\b(STDOUT)\\b(?!`)',
              replacement: '`stdout`'
            },
            {
              pattern: '(?<!`)\\b(STDERR)\\b(?!`)',
              replacement: '`stderr`'
            },
            {
              pattern: '(?<!`)(_[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]+)(?![`a-z0-9_])',
              description: 'Underscore topics'
            }
          ]
        }
      }

      const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rpk-test-'))

      try {
        const result = await generateRpkDocs({
          tree: testTree,
          overrides: testOverrides,
          outputDir: tempDir,
          rpkVersion: 'test',
          pluginVersions: {}
        })

        expect(result.commandCount).toBe(2) // rpk + test-cmd
        expect(result.filesGenerated).toBeGreaterThan(0)

        // Read generated file
        const generatedFile = path.join(tempDir, 'rpk-test-cmd.adoc')
        expect(fs.existsSync(generatedFile)).toBe(true)

        const content = fs.readFileSync(generatedFile, 'utf8')

        // Verify transformations were applied
        expect(content).toContain('`stdout`')
        expect(content).toContain('`stderr`')
        expect(content).toContain('`_redpanda.test_topic`')

        // Verify original text is NOT present (was transformed)
        expect(content).not.toContain('STDOUT')
        expect(content).not.toContain('STDERR')
        expect(content).not.toMatch(/_redpanda\.test_topic(?!`)/) // without backticks
      } finally {
        // Cleanup
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    }, 30000)
  })
})
