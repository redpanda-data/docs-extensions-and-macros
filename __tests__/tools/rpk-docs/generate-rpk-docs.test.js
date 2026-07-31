'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  resolveReferences,
  mergeCommandOverrides,
  applyOverridesToTree,
  formatDescription,
  parseDescriptionSections,
  flattenCommands,
  deepMerge,
  ensurePeriod,
  convertIndentedCodeBlocksToAsciiDoc,
  shouldExcludeCommand,
  shouldUsePartialDir,
  updateNavFile,
  getOutputPath,
  findTopLevelWithSubcommands,
  generateRpkDocs
} = require('../../../tools/rpk-docs/generate-rpk-docs.js')

describe('rpk Docs Generation', () => {
  describe('resolveReferences', () => {
    test('resolves $ref to definitions', () => {
      const overrides = {
        definitions: {
          'common-flags': {
            verbose: { description: 'Enable verbose output' }
          }
        },
        commands: {
          'rpk topic': {
            flags: {},
            $refs: ['#/definitions/common-flags']
          }
        }
      }

      // Pass overrides twice - second arg is the root for resolving refs
      const resolved = resolveReferences(overrides, overrides)
      expect(resolved.commands['rpk topic'].verbose.description)
        .toBe('Enable verbose output')
    })

    test('merges multiple $refs', () => {
      const overrides = {
        definitions: {
          'tls-flags': {
            'tls-enabled': { description: 'Enable TLS' }
          },
          'kafka-flags': {
            brokers: { description: 'Broker list' }
          }
        },
        commands: {
          'rpk topic': {
            flags: {},
            $refs: ['#/definitions/tls-flags', '#/definitions/kafka-flags']
          }
        }
      }

      const resolved = resolveReferences(overrides, overrides)
      expect(resolved.commands['rpk topic']['tls-enabled'].description)
        .toBe('Enable TLS')
      expect(resolved.commands['rpk topic'].brokers.description)
        .toBe('Broker list')
    })

    test('preserves existing flags when merging refs', () => {
      const overrides = {
        definitions: {
          'common-flags': {
            verbose: { description: 'From definition' }
          }
        },
        commands: {
          'rpk topic': {
            flags: {
              partitions: { description: 'Number of partitions' }
            },
            $refs: ['#/definitions/common-flags']
          }
        }
      }

      const resolved = resolveReferences(overrides, overrides)
      expect(resolved.commands['rpk topic'].flags.partitions.description)
        .toBe('Number of partitions')
      expect(resolved.commands['rpk topic'].verbose.description)
        .toBe('From definition')
    })

    test('handles missing definitions gracefully', () => {
      const overrides = {
        definitions: {},
        commands: {
          'rpk topic': {
            flags: {},
            $refs: ['#/definitions/nonexistent']
          }
        }
      }

      // Should not throw
      const resolved = resolveReferences(overrides, overrides)
      expect(resolved.commands['rpk topic'].flags).toEqual({})
    })

    test('handles empty overrides', () => {
      const resolved = resolveReferences({}, {})
      expect(resolved).toEqual({})
    })
  })

  describe('deepMerge', () => {
    test('merges nested objects', () => {
      const target = { a: { b: 1 }, c: 2 }
      const source = { a: { d: 3 }, e: 4 }
      const result = deepMerge(target, source)
      expect(result).toEqual({ a: { b: 1, d: 3 }, c: 2, e: 4 })
    })

    test('merges arrays by name', () => {
      const target = { items: [{ name: 'foo', value: 1 }] }
      const source = { items: [{ name: 'foo', value: 2 }] }
      const result = deepMerge(target, source)
      expect(result.items[0].value).toBe(2)
    })

    test('handles null source', () => {
      const target = { a: 1 }
      expect(deepMerge(target, null)).toEqual({ a: 1 })
    })
  })

  describe('mergeCommandOverrides', () => {
    test('overrides command description', () => {
      const command = {
        name: 'create',
        description: 'Original description',
        flags: []
      }
      const overrides = {
        commands: {
          'rpk topic create': {
            description: 'New description'
          }
        }
      }

      const merged = mergeCommandOverrides(command, overrides, 'rpk topic create')
      expect(merged.description).toBe('New description')
    })

    test('overrides flag descriptions by name', () => {
      const command = {
        name: 'create',
        description: 'Create topic',
        flags: [
          { name: 'partitions', description: 'Original' },
          { name: 'replication', description: 'Original too' }
        ]
      }
      const overrides = {
        commands: {
          'rpk topic create': {
            flags: {
              partitions: { description: 'Improved description' }
            }
          }
        }
      }

      const merged = mergeCommandOverrides(command, overrides, 'rpk topic create')
      expect(merged.flags[0].description).toBe('Improved description')
      expect(merged.flags[1].description).toBe('Original too')
    })

    test('preserves original when no override provided', () => {
      const command = {
        name: 'create',
        description: 'Original',
        flags: [{ name: 'foo', description: 'bar' }]
      }

      const merged = mergeCommandOverrides(command, null, 'rpk topic create')
      expect(merged.description).toBe('Original')
      expect(merged.flags[0].description).toBe('bar')
    })

    test('handles command not in overrides', () => {
      const command = {
        name: 'create',
        description: 'Original',
        flags: []
      }
      const overrides = {
        commands: {
          'rpk other command': { description: 'Different' }
        }
      }

      const merged = mergeCommandOverrides(command, overrides, 'rpk topic create')
      expect(merged.description).toBe('Original')
    })
  })

  describe('formatDescription', () => {
    test('adds backticks around --flags', () => {
      const input = 'Use --verbose to enable verbose output'
      const expected = 'Use `--verbose` to enable verbose output'
      expect(formatDescription(input)).toBe(expected)
    })

    test('adds backticks around short flags', () => {
      const input = 'Use -v for verbose'
      const expected = 'Use `-v` for verbose'
      expect(formatDescription(input)).toBe(expected)
    })

    test('adds backticks around environment variables', () => {
      const input = 'Set $REDPANDA_BROKERS to configure'
      expect(formatDescription(input)).toContain('`$REDPANDA_BROKERS`')
    })

    test('does not double-backtick already formatted flags', () => {
      const input = 'Use `--verbose` for output'
      // After the regex, we clean up double backticks, result should be same
      expect(formatDescription(input)).toBe('Use `--verbose` for output')
    })

    test('handles empty/null input', () => {
      expect(formatDescription('')).toBe('')
      expect(formatDescription(null)).toBe('')
      expect(formatDescription(undefined)).toBe('')
    })

    test('strips a dangling e.g. with nothing after it', () => {
      // Upstream rpai help ends some flag descriptions mid-example; the
      // e.g. transform would otherwise render "for example,."
      const input = 'fields optionally suffixed with " desc" (default ascending), e.g.'
      expect(formatDescription(input)).toBe('fields optionally suffixed with " desc" (default ascending)')
    })

    test('keeps e.g. transform when an example follows', () => {
      expect(formatDescription('durations, e.g. 30s or 1.5m')).toBe('durations, for example, 30s or 1.5m')
    })

    test('removes stray space before a closing parenthesis', () => {
      const input = 'topic:partition_id (repeatable; e.g. -t foo:0,1,2 )'
      expect(formatDescription(input)).toBe('topic:partition_id (repeatable; for example, `-t` foo:0,1,2)')
    })

    test('converts markdown-style dash lists to AsciiDoc asterisk lists', () => {
      const input = 'States:\n  - Active: The item is active.\n  - Inactive: The item is inactive.'
      const result = formatDescription(input)
      // Definition terms get backticks in the conversion
      expect(result).toContain('* `Active`:')
      expect(result).toContain('* `Inactive`:')
      expect(result).not.toContain('  - ')
    })

    test('adds blank line before list when missing', () => {
      const input = 'The STATE column shows:\n  - Ready: Item is ready.\n  - Pending: Item is pending.'
      const result = formatDescription(input)
      // Should have blank line before list and format definition terms with backticks
      expect(result).toContain('shows:\n\n* `Ready`:')
    })

    test('handles real rpk group list description format', () => {
      const input = `List all groups.

The STATE columns shows which state the group is in:
  - PreparingRebalance: The group is preparing to rebalance.
  - Stable: The group is stable.
  - Empty: The group has no members.`

      const result = formatDescription(input)
      // Should convert to proper AsciiDoc list with backticked terms
      expect(result).toContain('* `PreparingRebalance`:')
      expect(result).toContain('* `Stable`:')
      expect(result).toContain('* `Empty`:')
      // Should have blank line before list
      expect(result).toContain('in:\n\n* `PreparingRebalance`')
    })

    test('preserves lists that already have blank line', () => {
      const input = 'Options:\n\n* First option\n* Second option'
      const result = formatDescription(input)
      // Should not add extra blank lines
      expect(result).toBe('Options:\n\n* First option\n* Second option')
    })
  })

  describe('parseDescriptionSections', () => {
    test('parses ALL CAPS sections', () => {
      const input = `Create topics.

EXAMPLES

This is an example.

NOTES

This is a note.`

      const result = parseDescriptionSections(input)
      expect(result.mainDescription).toBe('Create topics.')
      expect(result.sections.EXAMPLES).toBe('This is an example.')
      expect(result.sections.NOTES).toBe('This is a note.')
    })

    test('handles description without sections', () => {
      const input = 'Simple description without sections.'
      const result = parseDescriptionSections(input)
      expect(result.mainDescription).toBe('Simple description without sections.')
      expect(result.sections).toEqual({})
    })

    test('handles empty input', () => {
      const result = parseDescriptionSections('')
      expect(result.mainDescription).toBe('')
      expect(result.sections).toEqual({})
    })

    test('handles multi-word section headers', () => {
      const input = `Description.

TIME RANGE

Specify a time range.`

      const result = parseDescriptionSections(input)
      expect(result.mainDescription).toBe('Description.')
      expect(result.sections['TIME RANGE']).toBe('Specify a time range.')
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

    test('preserves colon at end (indicates list follows)', () => {
      expect(ensurePeriod('Available options:')).toBe('Available options:')
    })

    test('preserves semicolon at end (indicates list continues)', () => {
      expect(ensurePeriod('First item;')).toBe('First item;')
    })

    test('adds period when text ends without punctuation after semicolon', () => {
      expect(ensurePeriod('First item; second item')).toBe('First item; second item.')
    })

    test('handles multi-paragraph descriptions', () => {
      const input = 'First paragraph\n\nSecond paragraph'
      const result = ensurePeriod(input)
      expect(result).toBe('First paragraph.\n\nSecond paragraph.')
    })

    test('handles multi-paragraph with mixed punctuation', () => {
      const input = 'First paragraph.\n\nSecond paragraph:\n\nThird paragraph'
      const result = ensurePeriod(input)
      // Colon is preserved (indicates list follows), period added to last paragraph
      expect(result).toBe('First paragraph.\n\nSecond paragraph:\n\nThird paragraph.')
    })

    test('handles empty string', () => {
      expect(ensurePeriod('')).toBe('')
    })

    test('handles null/undefined', () => {
      expect(ensurePeriod(null)).toBe('')
      expect(ensurePeriod(undefined)).toBe('')
    })
  })

  describe('flattenCommands', () => {
    test('flattens nested command tree', () => {
      const tree = {
        name: 'rpk',
        description: 'Root',
        commands: [
          {
            name: 'topic',
            description: 'Topic commands',
            commands: [
              {
                name: 'create',
                description: 'Create topic',
                commands: []
              }
            ]
          }
        ]
      }

      const flat = flattenCommands(tree)
      expect(flat).toHaveLength(3)
      expect(flat[0].path).toBe('rpk')
      expect(flat[1].path).toBe('rpk topic')
      expect(flat[2].path).toBe('rpk topic create')
    })

    test('includes command object in result', () => {
      const tree = {
        name: 'rpk',
        description: 'Root',
        flags: [{ name: 'verbose' }],
        commands: []
      }

      const flat = flattenCommands(tree)
      expect(flat[0].command.flags).toEqual([{ name: 'verbose' }])
    })

    test('handles empty command tree', () => {
      const tree = {
        name: 'rpk',
        description: 'Root'
      }

      const flat = flattenCommands(tree)
      expect(flat).toHaveLength(1)
    })
  })

  describe('applyOverridesToTree', () => {
    test('applies overrides to root command', () => {
      const tree = {
        name: 'rpk',
        description: 'Original',
        commands: []
      }
      const overrides = {
        commands: {
          'rpk': {
            description: 'Enhanced description'
          }
        }
      }

      const enhanced = applyOverridesToTree(tree, overrides, '')
      expect(enhanced.description).toBe('Enhanced description')
    })

    test('applies overrides recursively to subcommands', () => {
      const tree = {
        name: 'rpk',
        description: 'Root',
        commands: [
          {
            name: 'topic',
            description: 'Topic commands',
            commands: [
              {
                name: 'create',
                description: 'Original create desc',
                commands: []
              }
            ]
          }
        ]
      }
      const overrides = {
        commands: {
          'rpk topic create': {
            description: 'Enhanced create description',
            introducedInVersion: 'v26.2.0'
          }
        }
      }

      const enhanced = applyOverridesToTree(tree, overrides, '')
      const topicCmd = enhanced.commands[0]
      const createCmd = topicCmd.commands[0]

      expect(createCmd.description).toBe('Enhanced create description')
      expect(createCmd.introducedInVersion).toBe('v26.2.0')
    })

    test('applies flag overrides including introducedInVersion', () => {
      const tree = {
        name: 'rpk',
        description: 'Root',
        commands: [
          {
            name: 'topic',
            description: 'Topic',
            commands: [
              {
                name: 'create',
                description: 'Create',
                flags: [
                  { name: 'partitions', description: 'Original' }
                ],
                commands: []
              }
            ]
          }
        ]
      }
      const overrides = {
        commands: {
          'rpk topic create': {
            flags: {
              'partitions': {
                description: 'Enhanced partitions desc',
                introducedInVersion: 'v26.2.0'
              }
            }
          }
        }
      }

      const enhanced = applyOverridesToTree(tree, overrides, '')
      const createCmd = enhanced.commands[0].commands[0]
      const partitionsFlag = createCmd.flags[0]

      expect(partitionsFlag.description).toBe('Enhanced partitions desc')
      expect(partitionsFlag.introducedInVersion).toBe('v26.2.0')
    })

    test('returns tree unchanged if no overrides', () => {
      const tree = {
        name: 'rpk',
        description: 'Original',
        commands: []
      }

      const enhanced = applyOverridesToTree(tree, null, '')
      expect(enhanced).toEqual(tree)
    })

    test('returns tree unchanged if empty overrides', () => {
      const tree = {
        name: 'rpk',
        description: 'Original',
        commands: []
      }
      const overrides = { commands: {} }

      const enhanced = applyOverridesToTree(tree, overrides, '')
      expect(enhanced.description).toBe('Original')
    })

    test('preserves unoverridden commands in tree', () => {
      const tree = {
        name: 'rpk',
        description: 'Root',
        commands: [
          { name: 'topic', description: 'Topic desc', commands: [] },
          { name: 'cluster', description: 'Cluster desc', commands: [] }
        ]
      }
      const overrides = {
        commands: {
          'rpk topic': {
            description: 'Enhanced topic'
          }
        }
      }

      const enhanced = applyOverridesToTree(tree, overrides, '')
      expect(enhanced.commands[0].description).toBe('Enhanced topic')
      expect(enhanced.commands[1].description).toBe('Cluster desc')
    })
  })

  describe('convertIndentedCodeBlocksToAsciiDoc', () => {
    test('detects indented command starting with rpk', () => {
      const input = 'To deploy:\n\n  rpk transform deploy --file test.wasm'
      const store = []
      const result = convertIndentedCodeBlocksToAsciiDoc(input, store)

      expect(store).toHaveLength(1)
      expect(store[0]).toContain('[,bash]')
      expect(store[0]).toContain('rpk transform deploy --file test.wasm')
      expect(result).toContain('__EARLY_CODE_BLOCK_0__')
    })

    test('detects indented command starting with --flags', () => {
      const input = 'For example:\n\n  --job-name test --labels "group=one"'
      const store = []
      const result = convertIndentedCodeBlocksToAsciiDoc(input, store)

      expect(store).toHaveLength(1)
      expect(store[0]).toContain('[,bash]')
      expect(store[0]).toContain('--job-name test --labels "group=one"')
    })

    test('handles multi-line command with backslash continuation', () => {
      const input = `Example:\n\n  rpk transform deploy --file test.wasm \\\n    --input-topic topic-1 \\\n    --output-topic topic-2`
      const store = []
      const result = convertIndentedCodeBlocksToAsciiDoc(input, store)

      expect(store).toHaveLength(1)
      // Backslashes should be normalized (stripped and re-added)
      expect(store[0]).toContain('rpk transform deploy --file test.wasm')
      expect(store[0]).toContain('--input-topic topic-1')
      expect(store[0]).toContain('--output-topic topic-2')
      // Should not have double backslashes
      expect(store[0]).not.toContain('\\ \\')
    })

    test('detects indented YAML block', () => {
      const input = `Result:\n\n  - job_name: test\n    static_configs:\n      - targets: [localhost]\n        labels:\n          group: one`
      const store = []
      const result = convertIndentedCodeBlocksToAsciiDoc(input, store)

      expect(store).toHaveLength(1)
      expect(store[0]).toContain('[,yaml]')
      expect(store[0]).toContain('job_name: test')
      expect(store[0]).toContain('static_configs:')
    })

    test('does not convert prose list items starting with dash', () => {
      const input = 'Options:\n\n - If you provide --flag, the command will work.\n - If you omit it, defaults are used.'
      const store = []
      const result = convertIndentedCodeBlocksToAsciiDoc(input, store)

      // These are prose list items, not YAML
      expect(store).toHaveLength(0)
      expect(result).toContain('If you provide --flag')
    })

    test('handles empty input', () => {
      const store = []
      const result = convertIndentedCodeBlocksToAsciiDoc('', store)
      expect(result).toBe('')
      expect(store).toHaveLength(0)
    })

    test('handles null input', () => {
      const store = []
      const result = convertIndentedCodeBlocksToAsciiDoc(null, store)
      expect(result).toBe(null)
    })

    test('single-line command does not get backslash continuation', () => {
      const input = 'Example:\n\n  rpk cluster status'
      const store = []
      convertIndentedCodeBlocksToAsciiDoc(input, store)

      expect(store).toHaveLength(1)
      // Single line should not have trailing backslash
      expect(store[0]).not.toContain('\\')
    })
  })

  describe('formatDescription edge cases', () => {
    test('flag=value is wrapped as single unit', () => {
      const input = 'Use --format=json to output JSON'
      const result = formatDescription(input)
      expect(result).toContain('`--format=json`')
      expect(result).not.toContain('`--format`=json')
    })

    test('handles complex flag=value patterns', () => {
      const input = 'Example: --var=KEY=VALUE for environment'
      const result = formatDescription(input)
      expect(result).toContain('`--var=KEY=VALUE`')
    })

    test('converts multi-line YAML to code block preserving content', () => {
      // This tests that YAML blocks are detected and converted
      const input = `Example:\n\n  - job_name: test\n    static_configs:\n      - targets: [localhost]`
      const result = formatDescription(input)

      // Should be converted to a code block
      expect(result).toContain('[,yaml]')
      expect(result).toContain('----')
      expect(result).toContain('job_name: test')
    })

    test('preserves file paths with standard prefixes', () => {
      const input = 'Config is at /etc/redpanda/redpanda.yaml'
      const result = formatDescription(input)
      expect(result).toContain('`/etc/redpanda/redpanda.yaml`')
    })

    test('wraps environment variables in backticks', () => {
      const input = 'Set $REDPANDA_HOME to configure the path'
      const result = formatDescription(input)
      expect(result).toContain('`$REDPANDA_HOME`')
    })

    test('multi-line command preserves all flags', () => {
      const input = `Deploy:\n\n  rpk transform deploy --file test.wasm \\\n    --input-topic input \\\n    --output-topic output`
      const result = formatDescription(input)

      // All flags should be in the result
      expect(result).toContain('--file test.wasm')
      expect(result).toContain('--input-topic input')
      expect(result).toContain('--output-topic output')
    })
  })

  describe('shouldUsePartialDir', () => {
    test('returns false when overrides is null', () => {
      expect(shouldUsePartialDir(null, 'rpk ai')).toBe(false)
    })

    test('returns false when command has no asPartial flag', () => {
      const overrides = { commands: { 'rpk ai': { description: 'AI commands' } } }
      expect(shouldUsePartialDir(overrides, 'rpk ai')).toBe(false)
    })

    test('returns true when command itself has asPartial: true', () => {
      const overrides = { commands: { 'rpk ai': { asPartial: true } } }
      expect(shouldUsePartialDir(overrides, 'rpk ai')).toBe(true)
    })

    test('inherits from parent: child command returns true when parent has asPartial', () => {
      const overrides = { commands: { 'rpk ai': { asPartial: true } } }
      expect(shouldUsePartialDir(overrides, 'rpk ai agent list')).toBe(true)
    })

    test('inherits from grandparent', () => {
      const overrides = { commands: { 'rpk ai': { asPartial: true } } }
      expect(shouldUsePartialDir(overrides, 'rpk ai agent a2a send')).toBe(true)
    })

    test('does not inherit from sibling', () => {
      const overrides = { commands: { 'rpk ai': { asPartial: true } } }
      expect(shouldUsePartialDir(overrides, 'rpk topic create')).toBe(false)
    })

    test('returns false when asPartial is false', () => {
      const overrides = { commands: { 'rpk ai': { asPartial: false } } }
      expect(shouldUsePartialDir(overrides, 'rpk ai agent')).toBe(false)
    })
  })

  describe('updateNavFile', () => {
    let tmpDir

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-nav-test-'))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    const makeNav = (content) => {
      const navPath = path.join(tmpDir, 'nav.adoc')
      fs.writeFileSync(navPath, content, 'utf8')
      return navPath
    }

    const makeTree = (commands) => {
      // commands is array of space-separated paths like ['rpk cluster', 'rpk cluster create']
      // Build a minimal tree
      const root = { name: 'rpk', commands: [] }
      for (const p of commands) {
        const parts = p.split(' ').slice(1) // remove 'rpk'
        let node = root
        for (const part of parts) {
          let child = node.commands.find(c => c.name === part)
          if (!child) {
            child = { name: part, commands: [] }
            node.commands.push(child)
          }
          node = child
        }
      }
      return root
    }

    test('returns navUpdated: false when file does not exist', () => {
      const result = updateNavFile(
        path.join(tmpDir, 'nonexistent.adoc'),
        [], {}, new Set()
      )
      expect(result.navUpdated).toBe(false)
    })

    test('returns navUpdated: false when rpk section not found', () => {
      const navPath = makeNav('* xref:other:index.adoc[]\n** xref:other:page.adoc[]\n')
      const result = updateNavFile(navPath, [], {}, new Set())
      expect(result.navUpdated).toBe(false)
    })

    test('preserves section header and static entries', () => {
      const nav = [
        '* xref:get-started:index.adoc[]',
        '** xref:reference:rpk/index.adoc[rpk Commands]',
        '*** xref:reference:rpk/rpk.adoc[]',
        '*** xref:reference:rpk/rpk-commands.adoc[]',
        '*** xref:reference:rpk/rpk-x-options.adoc[rpk -X]',
        '*** xref:reference:rpk/rpk-topic/rpk-topic.adoc[]',
        '** xref:reference:glossary.adoc[]',
      ].join('\n')

      const navPath = makeNav(nav)
      const tree = makeTree(['rpk topic', 'rpk topic create'])
      const commands = flattenCommands(tree)
      const topLevel = findTopLevelWithSubcommands(tree)
      const result = updateNavFile(navPath, commands, {}, topLevel)

      const written = fs.readFileSync(navPath, 'utf8')
      expect(result.navUpdated).toBe(true)
      expect(written).toContain('** xref:reference:rpk/index.adoc[rpk Commands]')
      expect(written).toContain('*** xref:reference:rpk/rpk-commands.adoc[]')
      expect(written).toContain('*** xref:reference:rpk/rpk-x-options.adoc[rpk -X]')
      // The generated root rpk.adoc page is listed ahead of the hand-written
      // entries; without it Antora reports the page as unlisted.
      const lines = written.split('\n')
      const rootIdx = lines.indexOf('*** xref:reference:rpk/rpk.adoc[]')
      expect(rootIdx).toBeGreaterThan(-1)
      expect(rootIdx).toBeLessThan(lines.indexOf('*** xref:reference:rpk/rpk-commands.adoc[]'))
    })

    test('generates entries at correct nesting depths', () => {
      const nav = [
        '** xref:reference:rpk/index.adoc[rpk Commands]',
        '** xref:reference:glossary.adoc[]',
      ].join('\n')

      const navPath = makeNav(nav)
      const tree = makeTree(['rpk topic', 'rpk topic create', 'rpk topic delete'])
      const commands = flattenCommands(tree)
      const topLevel = findTopLevelWithSubcommands(tree)
      updateNavFile(navPath, commands, {}, topLevel)

      const written = fs.readFileSync(navPath, 'utf8')
      // rpk topic → 2 parts → *** (3 stars)
      expect(written).toContain('*** xref:reference:rpk/rpk-topic/rpk-topic.adoc[]')
      // rpk topic create → 3 parts → **** (4 stars)
      expect(written).toContain('**** xref:reference:rpk/rpk-topic/rpk-topic-create.adoc[]')
      expect(written).toContain('**** xref:reference:rpk/rpk-topic/rpk-topic-delete.adoc[]')
    })

    test('omits excluded commands', () => {
      const nav = [
        '** xref:reference:rpk/index.adoc[rpk Commands]',
        '** xref:reference:glossary.adoc[]',
      ].join('\n')

      const navPath = makeNav(nav)
      const tree = makeTree(['rpk topic', 'rpk topic create', 'rpk topic internal'])
      const commands = flattenCommands(tree)
      const topLevel = findTopLevelWithSubcommands(tree)
      const overrides = { commands: { 'rpk topic internal': { exclude: true } } }
      updateNavFile(navPath, commands, overrides, topLevel)

      const written = fs.readFileSync(navPath, 'utf8')
      expect(written).toContain('rpk-topic-create')
      expect(written).not.toContain('rpk-topic-internal')
    })

    test('omits asPartial commands and their descendants', () => {
      const nav = [
        '** xref:reference:rpk/index.adoc[rpk Commands]',
        '** xref:reference:glossary.adoc[]',
      ].join('\n')

      const navPath = makeNav(nav)
      const tree = makeTree(['rpk ai', 'rpk ai agent', 'rpk ai agent list', 'rpk topic', 'rpk topic create'])
      const commands = flattenCommands(tree)
      const topLevel = findTopLevelWithSubcommands(tree)
      const overrides = { commands: { 'rpk ai': { asPartial: true } } }
      updateNavFile(navPath, commands, overrides, topLevel)

      const written = fs.readFileSync(navPath, 'utf8')
      expect(written).not.toContain('rpk-ai')
      expect(written).toContain('*** xref:reference:rpk/rpk-topic/rpk-topic.adoc[]')
    })

    test('omits rpk cloud and rpk security secret commands', () => {
      const nav = [
        '** xref:reference:rpk/index.adoc[rpk Commands]',
        '** xref:reference:glossary.adoc[]',
      ].join('\n')

      const navPath = makeNav(nav)
      const tree = makeTree([
        'rpk cloud', 'rpk cloud login',
        'rpk security', 'rpk security secret', 'rpk security secret list',
        'rpk topic', 'rpk topic create'
      ])
      const commands = flattenCommands(tree)
      const topLevel = findTopLevelWithSubcommands(tree)
      updateNavFile(navPath, commands, {}, topLevel)

      const written = fs.readFileSync(navPath, 'utf8')
      expect(written).not.toContain('rpk-cloud')
      expect(written).not.toContain('rpk-security-secret')
      // rpk security itself (not secret) should appear
      expect(written).toContain('rpk-security/rpk-security.adoc')
      expect(written).toContain('rpk-topic/rpk-topic.adoc')
    })

    test('preserves content outside the rpk section', () => {
      const nav = [
        '* xref:home:index.adoc[]',
        '** xref:get-started:intro.adoc[]',
        '** xref:reference:rpk/index.adoc[rpk Commands]',
        '*** xref:reference:rpk/rpk-topic/rpk-topic.adoc[]',
        '** xref:reference:glossary.adoc[]',
        '* xref:other:index.adoc[]',
      ].join('\n')

      const navPath = makeNav(nav)
      const tree = makeTree(['rpk topic'])
      const commands = flattenCommands(tree)
      const topLevel = findTopLevelWithSubcommands(tree)
      updateNavFile(navPath, commands, {}, topLevel)

      const written = fs.readFileSync(navPath, 'utf8')
      expect(written).toContain('* xref:home:index.adoc[]')
      expect(written).toContain('** xref:get-started:intro.adoc[]')
      expect(written).toContain('** xref:reference:glossary.adoc[]')
      expect(written).toContain('* xref:other:index.adoc[]')
    })

    test('is idempotent — running twice produces the same output', () => {
      const nav = [
        '** xref:reference:rpk/index.adoc[rpk Commands]',
        '** xref:reference:glossary.adoc[]',
      ].join('\n')

      const navPath = makeNav(nav)
      const tree = makeTree(['rpk topic', 'rpk topic create', 'rpk cluster', 'rpk cluster health'])
      const commands = flattenCommands(tree)
      const topLevel = findTopLevelWithSubcommands(tree)

      updateNavFile(navPath, commands, {}, topLevel)
      const firstRun = fs.readFileSync(navPath, 'utf8')

      updateNavFile(navPath, commands, {}, topLevel)
      const secondRun = fs.readFileSync(navPath, 'utf8')

      expect(firstRun).toBe(secondRun)
    })

    test('returns correct entry count', () => {
      const nav = [
        '** xref:reference:rpk/index.adoc[rpk Commands]',
        '** xref:reference:glossary.adoc[]',
      ].join('\n')

      const navPath = makeNav(nav)
      const tree = makeTree(['rpk topic', 'rpk topic create', 'rpk topic delete'])
      const commands = flattenCommands(tree)
      const topLevel = findTopLevelWithSubcommands(tree)
      const result = updateNavFile(navPath, commands, {}, topLevel)

      // rpk (skipped) + rpk topic + rpk topic create + rpk topic delete = 3 entries
      expect(result.navUpdated).toBe(true)
      expect(result.navEntriesGenerated).toBe(3)
    })

    test('preserves nav entries for protected plugins absent from the tree', () => {
      const nav = [
        '** xref:reference:rpk/index.adoc[rpk Commands]',
        '*** xref:reference:rpk/rpk-connect/rpk-connect.adoc[]',
        '**** xref:reference:rpk/rpk-connect/rpk-connect-run.adoc[]',
        '*** xref:reference:rpk/rpk-topic/rpk-topic.adoc[]',
        '** xref:reference:glossary.adoc[]',
      ].join('\n')

      const navPath = makeNav(nav)
      // connect is entirely absent from this run's tree
      const tree = makeTree(['rpk topic', 'rpk topic create'])
      const commands = flattenCommands(tree)
      const topLevel = findTopLevelWithSubcommands(tree)
      updateNavFile(navPath, commands, {}, topLevel, ['connect'])

      const written = fs.readFileSync(navPath, 'utf8')
      expect(written).toContain('*** xref:reference:rpk/rpk-connect/rpk-connect.adoc[]')
      expect(written).toContain('**** xref:reference:rpk/rpk-connect/rpk-connect-run.adoc[]')
      expect(written).toContain('*** xref:reference:rpk/rpk-topic/rpk-topic.adoc[]')
    })

    test('does not duplicate preserved entries that also exist in regenerated output', () => {
      const nav = [
        '** xref:reference:rpk/index.adoc[rpk Commands]',
        '*** xref:reference:rpk/rpk-connect/rpk-connect.adoc[]',
        '**** xref:reference:rpk/rpk-connect/rpk-connect-run.adoc[]',
        '** xref:reference:glossary.adoc[]',
      ].join('\n')

      const navPath = makeNav(nav)
      // connect IS in this run's tree, but protection wins: no connect
      // entries are generated, and the previous nav block is preserved in
      // place exactly once — never regenerated AND preserved.
      const tree = makeTree(['rpk connect', 'rpk connect run', 'rpk topic', 'rpk topic create'])
      const commands = flattenCommands(tree)
      const topLevel = findTopLevelWithSubcommands(tree)
      updateNavFile(navPath, commands, {}, topLevel, ['connect'])

      const written = fs.readFileSync(navPath, 'utf8')
      const count = (needle) => written.split('\n').filter(l => l.includes(needle)).length
      expect(count('rpk-connect/rpk-connect.adoc')).toBe(1)
      expect(count('rpk-connect/rpk-connect-run.adoc')).toBe(1)
      expect(count('rpk-topic/rpk-topic.adoc')).toBe(1)
    })

    test('protected-plugin preservation is idempotent across runs', () => {
      const nav = [
        '** xref:reference:rpk/index.adoc[rpk Commands]',
        '*** xref:reference:rpk/rpk-connect/rpk-connect.adoc[]',
        '** xref:reference:glossary.adoc[]',
      ].join('\n')

      const navPath = makeNav(nav)
      const tree = makeTree(['rpk topic', 'rpk topic create'])
      const commands = flattenCommands(tree)
      const topLevel = findTopLevelWithSubcommands(tree)

      updateNavFile(navPath, commands, {}, topLevel, ['connect'])
      const firstRun = fs.readFileSync(navPath, 'utf8')
      updateNavFile(navPath, commands, {}, topLevel, ['connect'])
      const secondRun = fs.readFileSync(navPath, 'utf8')

      expect(firstRun).toBe(secondRun)
      expect(firstRun.split('\n').filter(l => l.includes('rpk-connect/rpk-connect.adoc')).length).toBe(1)
    })

    test('splices preserved plugin entries in place under the plugin parent, not at the end', () => {
      // Realistic pre-GA shim scenario: the previous nav has the full k8s
      // block; this run's tree has only the k8s shim.
      const nav = [
        '** xref:reference:rpk/index.adoc[rpk Commands]',
        '*** xref:reference:rpk/rpk.adoc[]',
        '*** xref:reference:rpk/rpk-commands.adoc[]',
        '*** xref:reference:rpk/rpk-x-options.adoc[rpk -X]',
        '*** xref:reference:rpk/rpk-iotune.adoc[]',
        '*** xref:reference:rpk/rpk-k8s/rpk-k8s.adoc[]',
        '**** xref:reference:rpk/rpk-k8s/rpk-k8s-install.adoc[]',
        '**** xref:reference:rpk/rpk-k8s/rpk-k8s-multicluster.adoc[]',
        '***** xref:reference:rpk/rpk-k8s/rpk-k8s-multicluster-bootstrap.adoc[]',
        '**** xref:reference:rpk/rpk-k8s/rpk-k8s-uninstall.adoc[]',
        '*** xref:reference:rpk/rpk-version.adoc[]',
        '** xref:reference:glossary.adoc[]',
      ].join('\n')

      const navPath = makeNav(nav)
      const tree = makeTree([
        'rpk iotune',
        'rpk k8s', 'rpk k8s install', 'rpk k8s uninstall', 'rpk k8s upgrade',
        'rpk version'
      ])
      const commands = flattenCommands(tree)
      const topLevel = findTopLevelWithSubcommands(tree)
      updateNavFile(navPath, commands, {}, topLevel, ['k8s'])

      const written = fs.readFileSync(navPath, 'utf8')
      const outLines = written.split('\n')
      const idx = (needle) => outLines.findIndex(l => l.includes(needle))

      // The whole k8s block stays together, in its original position:
      // directly after rpk-iotune, parent first, children nested under it,
      // and rpk-version still follows the block — nothing lands at the end.
      const parentIdx = idx('rpk-k8s/rpk-k8s.adoc')
      expect(parentIdx).toBe(idx('rpk-iotune.adoc') + 1)
      expect(idx('rpk-k8s-install.adoc')).toBe(parentIdx + 1)
      expect(idx('rpk-k8s-multicluster.adoc')).toBe(parentIdx + 2)
      expect(idx('rpk-k8s-multicluster-bootstrap.adoc')).toBe(parentIdx + 3)
      expect(idx('rpk-k8s-uninstall.adoc')).toBe(parentIdx + 4)
      expect(idx('rpk-version.adoc')).toBe(parentIdx + 5)

      // In this scenario the rebuilt nav is byte-identical to the input.
      expect(written).toBe(nav)
    })

    test('keeps a fully absent plugin block in its original position', () => {
      const nav = [
        '** xref:reference:rpk/index.adoc[rpk Commands]',
        '*** xref:reference:rpk/rpk.adoc[]',
        '*** xref:reference:rpk/rpk-commands.adoc[]',
        '*** xref:reference:rpk/rpk-x-options.adoc[rpk -X]',
        '*** xref:reference:rpk/rpk-connect/rpk-connect.adoc[]',
        '**** xref:reference:rpk/rpk-connect/rpk-connect-run.adoc[]',
        '*** xref:reference:rpk/rpk-topic/rpk-topic.adoc[]',
        '**** xref:reference:rpk/rpk-topic/rpk-topic-create.adoc[]',
        '** xref:reference:glossary.adoc[]',
      ].join('\n')

      const navPath = makeNav(nav)
      // connect is entirely absent from this run's tree
      const tree = makeTree(['rpk topic', 'rpk topic create'])
      const commands = flattenCommands(tree)
      const topLevel = findTopLevelWithSubcommands(tree)
      updateNavFile(navPath, commands, {}, topLevel, ['connect'])

      const written = fs.readFileSync(navPath, 'utf8')
      expect(written).toBe(nav)
    })
  })

  describe('stale file cleanup with protected plugins', () => {
    let tmpDir

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-cleanup-test-'))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    const writePage = (...segments) => {
      const filePath = path.join(tmpDir, ...segments)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, '= Existing page\n', 'utf8')
      return filePath
    }

    const cmd = (name, extra = {}) => ({
      name,
      description: `${name} command.`,
      usage: `rpk ${name} [flags]`,
      flags: [],
      ...extra
    })

    test('pages under a protected plugin dir survive the sweep while a stale non-plugin page is deleted', async () => {
      // Pre-existing pages from an earlier run where the connect plugin
      // installed successfully and rpk topic had a "describe" subcommand.
      const connectRoot = writePage('rpk-connect', 'rpk-connect.adoc')
      const connectRun = writePage('rpk-connect', 'rpk-connect-run.adoc')
      const staleTopic = writePage('rpk-topic', 'rpk-topic-describe.adoc')

      // This run's tree: connect is entirely absent (failed plugin install),
      // and rpk topic no longer has "describe".
      const tree = {
        name: 'rpk',
        description: 'Root command',
        commands: [
          cmd('topic', { commands: [cmd('create')] })
        ],
        global_flags: []
      }

      const result = await generateRpkDocs({
        tree,
        outputDir: tmpDir,
        rpkVersion: 'test',
        pluginVersions: {}
      })

      // Protected plugin pages must survive: connect is a known plugin whose
      // subtree is absent from this run's tree.
      expect(fs.existsSync(connectRoot)).toBe(true)
      expect(fs.existsSync(connectRun)).toBe(true)

      // The genuinely stale non-plugin page must be swept.
      expect(fs.existsSync(staleTopic)).toBe(false)
      expect(result.filesDeleted).toBe(1)

      // Regenerated pages exist as usual.
      expect(fs.existsSync(path.join(tmpDir, 'rpk-topic', 'rpk-topic.adoc'))).toBe(true)
      expect(fs.existsSync(path.join(tmpDir, 'rpk-topic', 'rpk-topic-create.adoc'))).toBe(true)
    }, 30000)

    test('shim-only plugin subtree still protects the plugin dir', async () => {
      // Page from an earlier run where the plugin binary was installed.
      const connectRun = writePage('rpk-connect', 'rpk-connect-run.adoc')

      // This run's tree has the connect shim (install/uninstall/upgrade)
      // but none of the real plugin commands: the plugin failed to install.
      const tree = {
        name: 'rpk',
        description: 'Root command',
        commands: [
          cmd('connect', { commands: [cmd('install'), cmd('uninstall'), cmd('upgrade')] }),
          cmd('topic', { commands: [cmd('create')] })
        ],
        global_flags: []
      }

      const result = await generateRpkDocs({
        tree,
        outputDir: tmpDir,
        rpkVersion: 'test',
        pluginVersions: {}
      })

      // The shim-only subtree marks connect as auto-protected, so the page
      // written by the earlier (successful) run is not treated as stale.
      expect(fs.existsSync(connectRun)).toBe(true)
      expect(result.filesDeleted).toBe(0)
    }, 30000)

    test('explicitly protected plugins are honored alongside auto-protection', async () => {
      const aiPage = writePage('rpk-ai', 'rpk-ai-agent.adoc')
      const stale = writePage('rpk-cluster', 'rpk-cluster-old.adoc')

      const tree = {
        name: 'rpk',
        description: 'Root command',
        commands: [
          cmd('cluster', { commands: [cmd('health')] })
        ],
        global_flags: []
      }

      const result = await generateRpkDocs({
        tree,
        outputDir: tmpDir,
        rpkVersion: 'test',
        pluginVersions: {},
        protectedPlugins: ['ai']
      })

      expect(fs.existsSync(aiPage)).toBe(true)
      expect(fs.existsSync(stale)).toBe(false)
      expect(result.filesDeleted).toBe(1)
    }, 30000)

    test('shim-only plugin pages are not rewritten — parent page content stays untouched', async () => {
      // Pages from an earlier run where the connect plugin was installed:
      // the parent page documents the full plugin (including `run` in its
      // Subcommands table) and a child page exists for the real command.
      const parentContent = '= rpk connect\n\nFull plugin page with run subcommand.\n'
      const parent = path.join(tmpDir, 'rpk-connect', 'rpk-connect.adoc')
      fs.mkdirSync(path.dirname(parent), { recursive: true })
      fs.writeFileSync(parent, parentContent, 'utf8')
      const childRun = writePage('rpk-connect', 'rpk-connect-run.adoc')
      const childContent = fs.readFileSync(childRun, 'utf8')

      // This run's tree has only the connect shim.
      const tree = {
        name: 'rpk',
        description: 'Root command',
        commands: [
          cmd('connect', { commands: [cmd('install'), cmd('uninstall'), cmd('upgrade')] }),
          cmd('topic', { commands: [cmd('create')] })
        ],
        global_flags: []
      }

      await generateRpkDocs({
        tree,
        outputDir: tmpDir,
        rpkVersion: 'test',
        pluginVersions: {}
      })

      // The parent page must not be regenerated with shim-only content, and
      // the child page must not become an orphan or change.
      expect(fs.readFileSync(parent, 'utf8')).toBe(parentContent)
      expect(fs.readFileSync(childRun, 'utf8')).toBe(childContent)

      // No shim pages are written under the protected subtree.
      expect(fs.existsSync(path.join(tmpDir, 'rpk-connect', 'rpk-connect-install.adoc'))).toBe(false)
      expect(fs.existsSync(path.join(tmpDir, 'rpk-connect', 'rpk-connect-uninstall.adoc'))).toBe(false)
      expect(fs.existsSync(path.join(tmpDir, 'rpk-connect', 'rpk-connect-upgrade.adoc'))).toBe(false)

      // Non-plugin pages regenerate as usual.
      expect(fs.existsSync(path.join(tmpDir, 'rpk-topic', 'rpk-topic.adoc'))).toBe(true)
      expect(fs.existsSync(path.join(tmpDir, 'rpk-topic', 'rpk-topic-create.adoc'))).toBe(true)
    }, 30000)

    test('fully installed plugin regenerates pages and sweeps its stale files as usual', async () => {
      // Previous run left a page for a subcommand that no longer exists.
      const stale = writePage('rpk-connect', 'rpk-connect-removed.adoc')
      const parent = path.join(tmpDir, 'rpk-connect', 'rpk-connect.adoc')
      fs.writeFileSync(parent, '= Old parent page\n', 'utf8')

      // This run's tree has the real plugin commands (beyond the shim), so
      // connect is NOT protected and generation proceeds normally.
      const tree = {
        name: 'rpk',
        description: 'Root command',
        commands: [
          cmd('connect', {
            commands: [cmd('install'), cmd('uninstall'), cmd('upgrade'), cmd('run')]
          })
        ],
        global_flags: []
      }

      const result = await generateRpkDocs({
        tree,
        outputDir: tmpDir,
        rpkVersion: 'test',
        pluginVersions: {}
      })

      // Parent page is regenerated (content replaced) and the real
      // subcommand page is written.
      expect(fs.readFileSync(parent, 'utf8')).not.toBe('= Old parent page\n')
      expect(fs.readFileSync(parent, 'utf8')).toContain('rpk connect')
      expect(fs.existsSync(path.join(tmpDir, 'rpk-connect', 'rpk-connect-run.adoc'))).toBe(true)

      // The genuinely stale page is swept.
      expect(fs.existsSync(stale)).toBe(false)
      expect(result.filesDeleted).toBe(1)
    }, 30000)
  })
})

describe('capToTwoSentences with code blocks', () => {
  const { capToTwoSentences } = require('../../../tools/rpk-docs/generate-rpk-docs.js')

  test('ends the summary at a colon that introduces a code block', () => {
    const input = 'Prints a config according to an expression. The expression takes three lists, divided by slashes:\n\n[,text]\n----\nredpanda-connect create stdin/bloblang,awk/nats\n----\n\nIf omitted a default config is created.'
    // The block and its dangling colon introducer are both dropped
    expect(capToTwoSentences(input)).toBe('Prints a config according to an expression.')
  })

  test('drops a mid-prose block and keeps surrounding sentences', () => {
    const input = 'Reports progress.\n\n[,bash]\n----\nrpk thing status 4\n----\n\nUse --detailed for more.'
    expect(capToTwoSentences(input)).toBe('Reports progress. Use --detailed for more.')
  })
})

describe('placeholder brace escaping', () => {
  const { formatDescription } = require('../../../tools/rpk-docs/generate-rpk-docs.js')

  test('escapes template placeholders so Asciidoctor keeps them', () => {
    const input = 'Enable code mode: adds {name}_search and {name}_execute tools.'
    const out = formatDescription(input)
    expect(out).toContain('\\{name}_search')
    expect(out).toContain('\\{name}_execute')
  })

  test('leaves a bare vbar attribute in prose alone', () => {
    // {vbar} in prose is a real attribute (pipe escaping); placeholders in
    // backtick spans were already escaped by the span-protection step
    const input = 'Format: `table{vbar}json` uses {vbar} in prose.'
    const out = formatDescription(input)
    expect(out).toContain('uses {vbar} in prose')
    expect(out).toContain('`table\\{vbar}json`')
  })
})
