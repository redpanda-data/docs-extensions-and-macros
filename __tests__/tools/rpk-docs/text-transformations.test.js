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

describe('applyToCode rules in early code blocks', () => {
  const { formatDescription } = require('../../../tools/rpk-docs/generate-rpk-docs.js')

  const transforms = {
    replacements: [
      { pattern: '\\brpai\\b', replacement: 'rpk ai', flags: 'g', applyToCode: true },
      { pattern: '(^|\\n\\s*)Note:\\s', replacement: '$1NOTE: ', flags: 'g' }
    ]
  }

  test('applies only code-safe rules inside captured code blocks', () => {
    const input = 'Run the agent, e.g.:\n\n  rpai run claude -L anthropic\n  Note: output follows\n\nDone.'
    const out = formatDescription(input, transforms)
    expect(out).toContain('rpk ai run claude -L anthropic')
    // The admonition rule must NOT rewrite text inside the code block
    expect(out).toContain('Note: output follows')
    expect(out).not.toContain('NOTE: output follows')
  })
})

describe('applyToCode rules in inline code spans', () => {
  const { formatDescription } = require('../../../tools/rpk-docs/generate-rpk-docs.js')

  const transforms = {
    replacements: [
      { pattern: '\\brpai\\b', replacement: 'rpk ai', flags: 'g', applyToCode: true },
      { pattern: '(^|\\n\\s*)Note:\\s', replacement: '$1NOTE: ', flags: 'g' }
    ]
  }

  test('rewrites the binary name inside protected inline code spans', () => {
    const out = formatDescription('Run `rpai auth token` to authenticate first.', transforms)
    expect(out).toContain('`rpk ai auth token`')
    expect(out).not.toContain('rpai')
  })

  test('rules without applyToCode never touch inline code spans', () => {
    const out = formatDescription('The literal `Note: keep this` stays verbatim.', transforms)
    expect(out).toContain('`Note: keep this`')
    expect(out).not.toContain('NOTE: keep this')
  })
})

describe('known command path formatting', () => {
  const { formatDescription, registerKnownCommandPaths } = require('../../../tools/rpk-docs/generate-rpk-docs.js')

  afterEach(() => registerKnownCommandPaths([]))

  test('wraps a full multi-word command path as a unit', () => {
    registerKnownCommandPaths(['rpk', 'rpk ai', 'rpk ai run', 'rpk ai run codex'])
    const out = formatDescription('Use rpk ai run codex to start a session.', null)
    expect(out).toContain('`rpk ai run codex` to start a session.')
    expect(out).not.toContain('`rpk` ai')
  })

  test('prefers the longest registered path over a shorter prefix', () => {
    registerKnownCommandPaths(['rpk', 'rpk ai', 'rpk ai run', 'rpk ai run claude'])
    const out = formatDescription('Then rpk ai run claude resumes the session.', null)
    expect(out).toContain('`rpk ai run claude` resumes')
  })

  test('leaves prose that resembles a command alone when not in the tree', () => {
    registerKnownCommandPaths(['rpk', 'rpk cloud'])
    const out = formatDescription('Manage rpk cloud authentications for details.', null)
    expect(out).not.toContain('`rpk cloud authentications`')
  })

  test('is inert when no paths are registered', () => {
    const out = formatDescription('Use rpk ai run codex to start.', null)
    expect(out).not.toContain('`rpk ai run codex`')
  })
})

describe('applyTextTransformationsToExamples', () => {
  const { applyTextTransformationsToExamples } = require('../../../tools/rpk-docs/generate-rpk-docs.js')

  const transforms = {
    replacements: [
      { pattern: '"([a-z]{1,20})"', replacement: '`$1`', flags: 'g' },
      { pattern: '\\brpai\\b', replacement: 'rpk ai', flags: 'g', applyToCode: true }
    ]
  }

  test('caption rules never rewrite quoted strings inside command lines', () => {
    const input = 'Import client "quotas" from a string:\n  rpk cluster quotas import --from \'{"quotas":...}\''
    const out = applyTextTransformationsToExamples(input, transforms)
    expect(out).toContain('`quotas` from a string')
    expect(out).toContain(String.raw`'{"quotas":...}'`)
  })

  test('code-safe rules still apply to command lines', () => {
    const input = 'Send a task:\n  rpai agent a2a send hello'
    const out = applyTextTransformationsToExamples(input, transforms)
    expect(out).toContain('  rpk ai agent a2a send hello')
  })
})
