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

  // The overrides file itself lives in the docs repo (this repo ships only
  // the schema), so there is no repo-local default-transformations content
  // to assert on — the schema and integration tests below cover the code.

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
    // A registered single-token prefix ("rpk cloud") never matches: the
    // known-path pass requires two tokens after rpk, so the phrase falls
    // through to the context-aware heuristic, which wraps rpk alone.
    expect(out).toBe('Manage `rpk` cloud authentications for details.')
  })

  test('is inert when no paths are registered', () => {
    const out = formatDescription('Use rpk ai run codex to start.', null)
    expect(out).not.toContain('`rpk ai run codex`')
  })
})

describe('mid-token periods in summaries', () => {
  const { formatDescription, capToTwoSentences } = require('../../../tools/rpk-docs/generate-rpk-docs.js')

  test('dotted topic names never split or drop a sentence', () => {
    const src = "View logs for a transform.\n\nData transform's STDOUT and STDERR are captured during runtime and written to \nan internally managed topic _redpanda.transform_logs.\nThis command outputs logs for a single transform."
    const out = capToTwoSentences(formatDescription(src, null, { skipTableConversion: true, skipListConversion: true }))
    expect(out).not.toBe('View logs for a transform. transform_logs.')
    expect(out).toContain('`_redpanda.transform_logs`')
    expect(out).toContain('STDOUT and STDERR are captured')
  })

  test('URLs never split or drop a sentence', () => {
    const out = capToTwoSentences('Generate a license. To get one, contact us at redpanda.com/contact for details. The license is saved locally.')
    expect(out).toBe('Generate a license. To get one, contact us at redpanda.com/contact for details.')
  })

  test('an unterminated paragraph is a sentence boundary', () => {
    const out = capToTwoSentences('Generate a trial license\n\nThis command generates a license for a 30-day trial. The license is saved locally.')
    expect(out).toBe('Generate a trial license. This command generates a license for a 30-day trial.')
  })
})

describe('internal topic name backticking', () => {
  const { formatDescription } = require('../../../tools/rpk-docs/generate-rpk-docs.js')

  test('wraps _redpanda.* topic names in inline code', () => {
    const out = formatDescription('Logs are written to an internally managed topic _redpanda.transform_logs.\nRead them with the logs command.', null)
    expect(out).toContain('`_redpanda.transform_logs`.')
  })

  test('leaves already-backticked topic names alone', () => {
    const out = formatDescription('Logs go to `_redpanda.transform_logs` always.', null)
    expect(out).toContain('`_redpanda.transform_logs`')
    expect(out).not.toContain('``')
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

describe('indented lines inside list items (rpk shadow failover)', () => {
  const { formatDescription } = require('../../../tools/rpk-docs/generate-rpk-docs.js')

  // Upstream help text from rpk shadow failover (v26.3.1-rc2)
  const src = [
    '* Without a scope flag, it fails over the whole Shadow Link. Besides failing',
    "  over its topics, the link stops after it reaches the 'FAILED_OVER' state. A",
    "  phase that misses it leaves the link in the 'FAILOVER_FAULTED' state, and running the",
    "  command again resumes from that phase. 'rpk shadow status' reports the link",
    '  state.',
    '',
    "Use --wait to block until the failover reaches 'FAILED_OVER'."
  ].join('\n')
  const quotedRpk = { replacements: [{ pattern: "'(rpk\\s+[^']+)'", replacement: '`$1`', flags: 'g' }] }

  test('a continuation line that starts with a shell word stays prose', () => {
    const out = formatDescription(src, quotedRpk)
    expect(out).not.toContain('`command again')
    expect(out).toContain('  command again resumes from that phase. `rpk shadow status` reports the link')
  })

  test('single-quoted constants become code', () => {
    const out = formatDescription(src, null)
    expect(out).toContain('the `FAILED_OVER` state')
    expect(out).toContain('the `FAILOVER_FAULTED` state')
    expect(out).toContain('reaches `FAILED_OVER`.')
    expect(out).not.toContain("'FAILED_OVER'")
  })

  test('quoted lowercase prose and single capitals keep their quotes', () => {
    const out = formatDescription("Answer 'yes' or 'Y' to the prompt.", null)
    expect(out).toBe("Answer 'yes' or 'Y' to the prompt.")
  })

  test('a continuation line that starts with rpk stays prose, not a code block', () => {
    const out = formatDescription('* With --all, it fails over every topic. Afterwards\n  rpk shadow status reports the link state.', null)
    expect(out).not.toContain('----')
    expect(out).toContain('  `rpk` shadow status reports the link state.')
  })

  test('indented commands outside list items are still code', () => {
    expect(formatDescription('Prose line\n\n  echo "hello world"', null)).toBe('Prose line\n\n`echo "hello world"`')
    expect(formatDescription('Run:\n  rpk topic list', null)).toContain('[,bash]\n----\nrpk topic list\n----')
  })

  test('an example introduced by a colon inside a list item is still code', () => {
    const out = formatDescription('* To list topics, run:\n  rpk topic list', null)
    expect(out).toContain('[,bash]\n----\nrpk topic list\n----')
  })
})

describe('known command paths wrapped across lines (rpk shadow create)', () => {
  const { formatDescription, registerKnownCommandPaths } = require('../../../tools/rpk-docs/generate-rpk-docs.js')

  beforeEach(() => registerKnownCommandPaths(['rpk', 'rpk shadow', 'rpk shadow config', 'rpk shadow config generate', 'rpk cloud', 'rpk cloud login']))
  afterEach(() => registerKnownCommandPaths([]))

  test('a path split by a line wrap becomes one span', () => {
    const out = formatDescription('Before you create a Shadow Link, generate a configuration file with rpk shadow\nconfig generate and update it with your source cluster details.', null)
    expect(out).toContain('with `rpk shadow config generate` and update it')
    expect(out).not.toContain('`rpk` shadow')
  })

  test('a wrap inside an indented list item joins too', () => {
    const out = formatDescription('* Generate one with rpk\n  shadow config generate first.', null)
    expect(out).toContain('`rpk shadow config generate` first.')
  })

  test('never crosses a blank line', () => {
    const out = formatDescription('Run rpk shadow\n\nconfig generate is a phrase here.', null)
    expect(out).not.toContain('`rpk shadow config generate`')
  })

  test('a line ending in a full path keeps the next line separate', () => {
    const out = formatDescription('See rpk cloud login\nfor details.', null)
    expect(out).toBe('See `rpk cloud login`\nfor details.')
  })
})
