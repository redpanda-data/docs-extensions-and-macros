'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const {
  filterExamples,
  formatExamples,
  mergeCommandOverrides,
  processContentArray,
  generateRpkDocs
} = require('../../../tools/rpk-docs/generate-rpk-docs.js')

describe('Override Features', () => {
  describe('filterExamples', () => {
    const sampleExamples = `Trim records in 'foo' topic to offset 120 in partition 1
    rpk topic trim-prefix foo --offset 120 --partitions 1

Trim records in all partitions of topic foo previous to an specific timestamp
    rpk topic trim-prefix foo -o "@1622505600"

Trim records from a JSON file
    rpk topic trim-prefix --from-file /tmp/to_trim.json`

    test('returns text unchanged when no patterns provided', () => {
      expect(filterExamples(sampleExamples, [])).toBe(sampleExamples)
      expect(filterExamples(sampleExamples, null)).toBe(sampleExamples)
      expect(filterExamples(sampleExamples, undefined)).toBe(sampleExamples)
    })

    test('returns text unchanged when text is empty', () => {
      expect(filterExamples('', ['pattern'])).toBe('')
      expect(filterExamples(null, ['pattern'])).toBe(null)
      expect(filterExamples(undefined, ['pattern'])).toBe(undefined)
    })

    test('filters out example matching description pattern', () => {
      const result = filterExamples(sampleExamples, ['JSON file'])

      expect(result).toContain("Trim records in 'foo' topic")
      expect(result).toContain('rpk topic trim-prefix foo --offset 120')
      expect(result).toContain('Trim records in all partitions')
      expect(result).toContain('rpk topic trim-prefix foo -o')
      expect(result).not.toContain('Trim records from a JSON file')
      expect(result).not.toContain('--from-file /tmp/to_trim.json')
    })

    test('filters out example matching command pattern', () => {
      const result = filterExamples(sampleExamples, ['--from-file'])

      expect(result).toContain("Trim records in 'foo' topic")
      expect(result).not.toContain('Trim records from a JSON file')
      expect(result).not.toContain('--from-file')
    })

    test('filters with case-insensitive matching', () => {
      const result = filterExamples(sampleExamples, ['json FILE'])

      expect(result).not.toContain('Trim records from a JSON file')
    })

    test('filters multiple patterns', () => {
      const result = filterExamples(sampleExamples, ['JSON file', 'timestamp'])

      expect(result).toContain("Trim records in 'foo' topic")
      expect(result).not.toContain('Trim records from a JSON file')
      expect(result).not.toContain('previous to an specific timestamp')
    })

    test('filters using regex patterns', () => {
      const result = filterExamples(sampleExamples, ['offset \\d+'])

      expect(result).not.toContain("Trim records in 'foo' topic to offset 120")
      expect(result).toContain('Trim records in all partitions')
      expect(result).toContain('Trim records from a JSON file')
    })

    test('handles examples with 4-space indentation', () => {
      const fourSpaceExamples = `First example description
    rpk command --flag value

Second example to exclude
    rpk other-command --exclude

Third example description
    rpk third-command`

      const result = filterExamples(fourSpaceExamples, ['exclude'])

      expect(result).toContain('First example description')
      expect(result).toContain('rpk command --flag value')
      expect(result).toContain('Third example description')
      expect(result).not.toContain('Second example to exclude')
      expect(result).not.toContain('rpk other-command --exclude')
    })

    test('cleans up multiple consecutive blank lines', () => {
      const withBlanks = `Example 1
    rpk cmd1


Example 2 to remove
    rpk cmd2


Example 3
    rpk cmd3`

      const result = filterExamples(withBlanks, ['remove'])

      // Should not have more than 2 consecutive newlines
      expect(result).not.toMatch(/\n{3,}/)
    })
  })

  describe('formatExamples', () => {
    test('converts 4-space indented commands to code blocks', () => {
      const input = `Example description
    rpk topic create my-topic`

      const result = formatExamples(input)

      expect(result).toContain('Example description')
      expect(result).toContain('[,bash]')
      expect(result).toContain('----')
      expect(result).toContain('rpk topic create my-topic')
    })

    test('converts 2-space indented commands to code blocks', () => {
      const input = `Example description
  rpk topic create my-topic`

      const result = formatExamples(input)

      expect(result).toContain('[,bash]')
      expect(result).toContain('rpk topic create my-topic')
    })

    test('handles multiple examples', () => {
      const input = `First example
    rpk cmd1 --flag

Second example
    rpk cmd2 --other`

      const result = formatExamples(input)

      expect(result).toContain('First example')
      expect(result).toContain('rpk cmd1 --flag')
      expect(result).toContain('Second example')
      expect(result).toContain('rpk cmd2 --other')
      // Should have multiple code blocks
      expect((result.match(/\[,bash\]/g) || []).length).toBe(2)
    })

    test('handles empty/null input', () => {
      expect(formatExamples('')).toBe('')
      // formatExamples returns null for null input
      expect(formatExamples(null)).toBe(null)
    })

    test('preserves non-indented text', () => {
      const input = `This is a description paragraph.

It continues here.`

      const result = formatExamples(input)

      expect(result).toContain('This is a description paragraph.')
      expect(result).toContain('It continues here.')
      expect(result).not.toContain('[,bash]')
    })
  })

  describe('mergeCommandOverrides with excludeExamples', () => {
    test('copies excludeExamples from override to result', () => {
      const command = {
        name: 'trim-prefix',
        description: 'Trim records',
        flags: []
      }
      const overrides = {
        commands: {
          'rpk topic trim-prefix': {
            excludeExamples: ['JSON file', 'timestamp']
          }
        }
      }

      const merged = mergeCommandOverrides(command, overrides, 'rpk topic trim-prefix')

      expect(merged.excludeExamples).toEqual(['JSON file', 'timestamp'])
    })

    test('preserves other properties when excludeExamples is set', () => {
      const command = {
        name: 'trim-prefix',
        description: 'Original description',
        flags: [{ name: 'offset', description: 'Original offset desc' }]
      }
      const overrides = {
        commands: {
          'rpk topic trim-prefix': {
            description: 'New description',
            excludeExamples: ['pattern']
          }
        }
      }

      const merged = mergeCommandOverrides(command, overrides, 'rpk topic trim-prefix')

      expect(merged.description).toBe('New description')
      expect(merged.excludeExamples).toEqual(['pattern'])
    })

    test('returns command unchanged if no excludeExamples in override', () => {
      const command = {
        name: 'create',
        description: 'Create topic'
      }
      const overrides = {
        commands: {
          'rpk topic create': {
            description: 'New desc'
          }
        }
      }

      const merged = mergeCommandOverrides(command, overrides, 'rpk topic create')

      expect(merged.excludeExamples).toBeUndefined()
    })
  })

  describe('Section Content Replacement', () => {
    test('section with id and content replaces source section', () => {
      const command = {
        name: 'balancer-status',
        description: `Check status.

FIELDS

Original fields content here.

NOTES

Some notes.`,
        flags: []
      }
      const overrides = {
        commands: {
          'rpk cluster partitions balancer-status': {
            content: [
              {
                type: 'section',
                id: 'FIELDS',
                content: 'Replacement content for fields.'
              }
            ]
          }
        }
      }

      const merged = mergeCommandOverrides(command, overrides, 'rpk cluster partitions balancer-status')

      // The content array should be merged
      expect(merged.content).toBeDefined()
      expect(merged.content.length).toBe(1)
      expect(merged.content[0].id).toBe('FIELDS')
      expect(merged.content[0].content).toBe('Replacement content for fields.')
    })

    test('section with id and exclude removes source section', () => {
      const command = {
        name: 'test',
        description: `Description.

EXAMPLES

Some examples.`,
        flags: []
      }
      const overrides = {
        commands: {
          'rpk test': {
            content: [
              {
                type: 'section',
                id: 'EXAMPLES',
                exclude: true
              }
            ]
          }
        }
      }

      const merged = mergeCommandOverrides(command, overrides, 'rpk test')

      expect(merged.content).toBeDefined()
      expect(merged.content[0].exclude).toBe(true)
    })
  })

  describe('processContentArray', () => {
    test('handles empty content array', () => {
      const result = processContentArray([], 'rpk test')

      // Returns initialized structure with empty arrays for each position
      expect(result.sections).toBeDefined()
      expect(result.admonitions).toBeDefined()
      expect(result.includes).toBeDefined()
    })

    test('handles null/undefined content', () => {
      const nullResult = processContentArray(null, 'rpk test')
      const undefinedResult = processContentArray(undefined, 'rpk test')

      // Returns structure with empty objects
      expect(nullResult.sections).toEqual({})
      expect(undefinedResult.sections).toEqual({})
    })

    test('groups admonitions by position', () => {
      const content = [
        { type: 'note', position: 'after_flags', content: 'Note 1' },
        { type: 'warning', position: 'after_flags', content: 'Warning 1' },
        { type: 'note', position: 'after_description', content: 'Note 2' }
      ]

      const result = processContentArray(content, 'rpk test')

      // Admonitions are joined into a single string per position
      expect(result.admonitions.after_flags).toBeDefined()
      expect(typeof result.admonitions.after_flags).toBe('string')
      // Both admonitions are in the joined string
      expect(result.admonitions.after_flags).toContain('NOTE:')
      expect(result.admonitions.after_flags).toContain('Note 1')
      expect(result.admonitions.after_flags).toContain('WARNING:')
      expect(result.admonitions.after_flags).toContain('Warning 1')
      expect(result.admonitions.after_description).toBeDefined()
      expect(result.admonitions.after_description).toContain('NOTE:')
      expect(result.admonitions.after_description).toContain('Note 2')
    })

    test('handles include type', () => {
      const content = [
        { type: 'include', position: 'after_header', path: 'shared:partial$test.adoc' }
      ]

      const result = processContentArray(content, 'rpk test')

      // Includes go to includes object
      expect(result.includes.after_header).toBeDefined()
      expect(result.includes.after_header.length).toBe(1)
      expect(result.includes.after_header[0]).toBe('shared:partial$test.adoc')
    })

    test('handles examples type with items', () => {
      const content = [
        {
          type: 'examples',
          position: 'after_aliases',
          items: [
            { description: 'Example 1', code: 'rpk cmd1' },
            { description: 'Example 2', code: 'rpk cmd2' }
          ]
        }
      ]

      const result = processContentArray(content, 'rpk test')

      expect(result.sections.after_aliases).toBeDefined()
      expect(result.sections.after_aliases[0].type).toBe('examples')
      expect(result.sections.after_aliases[0].items.length).toBe(2)
    })

    test('handles examples with output blocks', () => {
      const content = [
        {
          type: 'examples',
          position: 'after_aliases',
          items: [
            {
              description: 'Example with output',
              code: 'rpk cluster status',
              output: 'CLUSTER\n=======\nredpanda.123',
              outputLanguage: 'bash'
            }
          ]
        }
      ]

      const result = processContentArray(content, 'rpk test')

      const example = result.sections.after_aliases[0].items[0]
      expect(example.output).toBe('CLUSTER\n=======\nredpanda.123')
      expect(example.outputLanguage).toBe('bash')
    })

    test('handles section type with position', () => {
      const content = [
        {
          type: 'section',
          id: 'custom-section',
          title: 'Custom Section',
          content: 'Custom content',
          position: 'after_flags'
        }
      ]

      const result = processContentArray(content, 'rpk test')

      expect(result.sections.after_flags).toBeDefined()
      expect(result.sections.after_flags[0].id).toBe('custom-section')
      expect(result.sections.after_flags[0].content).toBe('Custom content')
    })

    test('handles all valid positions for sections', () => {
      const positions = [
        'after_header',
        'after_description',
        'after_usage',
        'after_aliases',
        'after_flags',
        'end'
      ]

      const content = positions.map(pos => ({
        type: 'section',
        id: `section-${pos}`,
        title: `Section at ${pos}`,
        content: `Content at ${pos}`,
        position: pos
      }))

      const result = processContentArray(content, 'rpk test')

      positions.forEach(pos => {
        expect(result.sections[pos]).toBeDefined()
        expect(result.sections[pos].length).toBe(1)
        expect(result.sections[pos][0].id).toBe(`section-${pos}`)
      })
    })

    test('skips items with invalid position and logs warning', () => {
      // Mock console.warn to capture warnings
      const originalWarn = console.warn
      const warnings = []
      console.warn = (...args) => warnings.push(args.join(' '))

      const content = [
        { type: 'section', id: 'test', content: 'Content', position: 'invalid_position' }
      ]

      const result = processContentArray(content, 'rpk test')

      // Restore console.warn
      console.warn = originalWarn

      // Item should be skipped
      expect(result.sections.end.length).toBe(0)

      // Warning should have been logged
      expect(warnings.some(w => w.includes('Invalid content position'))).toBe(true)
    })

    test('skips items with exclude: true', () => {
      const content = [
        { type: 'section', id: 'excluded', content: 'Content', position: 'end', exclude: true },
        { type: 'section', id: 'included', content: 'Content', position: 'end' }
      ]

      const result = processContentArray(content, 'rpk test')

      // Only the non-excluded item should be present
      expect(result.sections.end.length).toBe(1)
      expect(result.sections.end[0].id).toBe('included')
    })
  })

  describe('Integration Tests', () => {
    let tempDir

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-override-test-'))
    })

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true })
    })

    test('excludeExamples filters examples in generated output', async () => {
      const testTree = {
        name: 'rpk',
        description: 'Root command',
        commands: [
          {
            name: 'test-cmd',
            description: `Test command.

EXAMPLES

First example
    rpk test-cmd --flag1

Second example to exclude
    rpk test-cmd --exclude-me

Third example
    rpk test-cmd --flag3`,
            usage: 'rpk test-cmd [flags]',
            flags: []
          }
        ],
        global_flags: []
      }

      const testOverrides = {
        commands: {
          'rpk test-cmd': {
            excludeExamples: ['exclude-me', 'Second example']
          }
        }
      }

      await generateRpkDocs({
        tree: testTree,
        overrides: testOverrides,
        outputDir: tempDir,
        rpkVersion: 'test',
        pluginVersions: {}
      })

      const generatedFile = path.join(tempDir, 'rpk-test-cmd.adoc')
      expect(fs.existsSync(generatedFile)).toBe(true)

      const content = fs.readFileSync(generatedFile, 'utf8')

      // First and third examples should be present
      expect(content).toContain('First example')
      expect(content).toContain('--flag1')
      expect(content).toContain('Third example')
      expect(content).toContain('--flag3')

      // Second example should be filtered out
      expect(content).not.toContain('Second example to exclude')
      expect(content).not.toContain('--exclude-me')
    }, 30000)

    test('section content replacement works in generated output', async () => {
      const testTree = {
        name: 'rpk',
        description: 'Root command',
        commands: [
          {
            name: 'test-cmd',
            description: `Test command.

FIELDS

Original fields content that should be replaced.`,
            usage: 'rpk test-cmd [flags]',
            flags: []
          }
        ],
        global_flags: []
      }

      const testOverrides = {
        commands: {
          'rpk test-cmd': {
            content: [
              {
                type: 'section',
                id: 'FIELDS',
                content: 'This is the replacement content for fields.'
              }
            ]
          }
        }
      }

      await generateRpkDocs({
        tree: testTree,
        overrides: testOverrides,
        outputDir: tempDir,
        rpkVersion: 'test',
        pluginVersions: {}
      })

      const generatedFile = path.join(tempDir, 'rpk-test-cmd.adoc')
      const content = fs.readFileSync(generatedFile, 'utf8')

      // Replacement content should be present
      expect(content).toContain('This is the replacement content for fields.')

      // Original content should NOT be present
      expect(content).not.toContain('Original fields content that should be replaced.')
    }, 30000)

    test('structured examples with output blocks render correctly', async () => {
      const testTree = {
        name: 'rpk',
        description: 'Root command',
        commands: [
          {
            name: 'test-cmd',
            description: 'Test command.',
            usage: 'rpk test-cmd [flags]',
            flags: []
          }
        ],
        global_flags: []
      }

      const testOverrides = {
        commands: {
          'rpk test-cmd': {
            content: [
              {
                type: 'examples',
                position: 'after_aliases',
                items: [
                  {
                    description: 'Example with output',
                    code: 'rpk test-cmd --status',
                    output: 'STATUS: OK\nCOUNT: 42',
                    outputLanguage: 'bash'
                  }
                ]
              }
            ]
          }
        }
      }

      await generateRpkDocs({
        tree: testTree,
        overrides: testOverrides,
        outputDir: tempDir,
        rpkVersion: 'test',
        pluginVersions: {}
      })

      const generatedFile = path.join(tempDir, 'rpk-test-cmd.adoc')
      const content = fs.readFileSync(generatedFile, 'utf8')

      // Example should be present
      expect(content).toContain('Example with output')
      expect(content).toContain('rpk test-cmd --status')

      // Output block should be present with .no-wrap class
      expect(content).toContain('Output:')
      expect(content).toContain('.no-wrap')
      expect(content).toContain('STATUS: OK')
      expect(content).toContain('COUNT: 42')
    }, 30000)
  })
})
