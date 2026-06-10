'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const {
  PreservedBlock,
  extractPreservedContent,
  groupByLocation,
  renderPreservedBlocks,
  loadPreservationsFromDirectory,
  mergeWithOverrides,
  parseOverridePreservations,
  isDeprecatedInclude,
  DEPRECATED_INCLUDES
} = require('../../../tools/rpk-docs/file-preservations.js')

describe('File Preservations', () => {
  let tempDir

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('PreservedBlock', () => {
    test('creates block with all properties', () => {
      const block = new PreservedBlock(
        'cloud-conditional',
        'test content',
        'after-header',
        { startLine: 10 }
      )
      expect(block.type).toBe('cloud-conditional')
      expect(block.content).toBe('test content')
      expect(block.location).toBe('after-header')
      expect(block.context.startLine).toBe(10)
    })

    test('creates block with default context', () => {
      const block = new PreservedBlock('include', 'include::foo[]', 'after-flags')
      expect(block.context).toEqual({})
    })
  })

  describe('isDeprecatedInclude', () => {
    test('identifies deprecated topic-format.adoc include', () => {
      expect(isDeprecatedInclude('shared:partial$topic-format.adoc')).toBe(true)
      expect(isDeprecatedInclude('topic-format.adoc')).toBe(true)
    })

    test('identifies deprecated unsupported-os-rpk.adoc include', () => {
      expect(isDeprecatedInclude('shared:partial$unsupported-os-rpk.adoc')).toBe(true)
      expect(isDeprecatedInclude('unsupported-os-rpk.adoc')).toBe(true)
    })

    test('does not flag non-deprecated includes', () => {
      expect(isDeprecatedInclude('shared:partial$rpk-acl-tip.adoc')).toBe(false)
      expect(isDeprecatedInclude('warning-delete-records.adoc')).toBe(false)
    })

    test('DEPRECATED_INCLUDES contains expected entries', () => {
      expect(DEPRECATED_INCLUDES).toContain('topic-format.adoc')
      expect(DEPRECATED_INCLUDES).toContain('unsupported-os-rpk.adoc')
    })
  })

  describe('extractPreservedContent', () => {
    test('returns empty array for non-existent file', () => {
      const result = extractPreservedContent('/nonexistent/path.adoc')
      expect(result).toEqual([])
    })

    test('extracts cloud conditional block', () => {
      const content = `= rpk topic create
:description: Create a topic

ifdef::env-cloud[]
NOTE: This is cloud-only content.
endif::[]

== Usage

[,bash]
----
rpk topic create [flags]
----
`
      const filePath = path.join(tempDir, 'test.adoc')
      fs.writeFileSync(filePath, content)

      const result = extractPreservedContent(filePath)
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('cloud-conditional')
      expect(result[0].content).toContain('NOTE: This is cloud-only content.')
      expect(result[0].location).toBe('after-header')
    })

    test('extracts self-hosted conditional block', () => {
      const content = `= rpk cluster config
:description: Configure cluster

ifndef::env-cloud[]
This command is only available for self-hosted clusters.
endif::[]

== Usage
`
      const filePath = path.join(tempDir, 'test.adoc')
      fs.writeFileSync(filePath, content)

      const result = extractPreservedContent(filePath)
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('self-hosted-conditional')
      expect(result[0].content).toContain('self-hosted clusters')
    })

    test('extracts include directive', () => {
      const content = `= rpk topic create
:description: Create topic

== Flags

[cols="1m,1a,2a"]
|===
|Value |Type |Description
|===

include::shared:partial$rpk-acl-tip.adoc[]

== See also
`
      const filePath = path.join(tempDir, 'test.adoc')
      fs.writeFileSync(filePath, content)

      const result = extractPreservedContent(filePath)
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('include')
      expect(result[0].context.includePath).toBe('shared:partial$rpk-acl-tip.adoc')
      expect(result[0].location).toBe('after-flags')
    })

    test('skips deprecated includes', () => {
      const content = `= rpk topic consume
:description: Consume messages

include::shared:partial$topic-format.adoc[]
include::shared:partial$unsupported-os-rpk.adoc[]
include::shared:partial$valid-include.adoc[]

== Usage
`
      const filePath = path.join(tempDir, 'test.adoc')
      fs.writeFileSync(filePath, content)

      const result = extractPreservedContent(filePath)
      // Only valid-include.adoc should be preserved
      expect(result).toHaveLength(1)
      expect(result[0].context.includePath).toBe('shared:partial$valid-include.adoc')
    })

    test('extracts multiple blocks from different sections', () => {
      const content = `= rpk topic create
:description: Create topic

ifdef::env-cloud[]
Cloud note at header.
endif::[]

== Usage

[,bash]
----
rpk topic create [flags]
----

ifndef::env-cloud[]
Self-hosted note after usage.
endif::[]

== Flags

include::shared:partial$some-flag-note.adoc[]
`
      const filePath = path.join(tempDir, 'test.adoc')
      fs.writeFileSync(filePath, content)

      const result = extractPreservedContent(filePath)
      expect(result).toHaveLength(3)
      expect(result[0].type).toBe('cloud-conditional')
      expect(result[0].location).toBe('after-header')
      expect(result[1].type).toBe('self-hosted-conditional')
      expect(result[1].location).toBe('after-usage')
      expect(result[2].type).toBe('include')
      expect(result[2].location).toBe('after-flags')
    })

    test('handles nested conditionals', () => {
      const content = `= rpk test
:description: Test

ifdef::env-cloud[]
Cloud content start.

ifdef::env-feature[]
Nested conditional content.
endif::[]

Cloud content end.
endif::[]

== Usage
`
      const filePath = path.join(tempDir, 'test.adoc')
      fs.writeFileSync(filePath, content)

      const result = extractPreservedContent(filePath)
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('cloud-conditional')
      expect(result[0].content).toContain('Cloud content start')
      expect(result[0].content).toContain('Nested conditional content')
      expect(result[0].content).toContain('Cloud content end')
    })

    test('handles unclosed conditional block gracefully', () => {
      const content = `= rpk test
:description: Test

ifdef::env-cloud[]
This block is never closed
Some more content
`
      const filePath = path.join(tempDir, 'test.adoc')
      fs.writeFileSync(filePath, content)

      // Should not throw
      const result = extractPreservedContent(filePath)
      expect(result).toHaveLength(1)
      expect(result[0].content).toContain('This block is never closed')
    })

    test('tracks section changes correctly', () => {
      const content = `= rpk command
:description: Test

== Aliases

[,bash]
----
alias
----

include::shared:partial$alias-note.adoc[]

== Examples

Example content.
`
      const filePath = path.join(tempDir, 'test.adoc')
      fs.writeFileSync(filePath, content)

      const result = extractPreservedContent(filePath)
      expect(result[0].location).toBe('after-aliases')
    })
  })

  describe('groupByLocation', () => {
    test('groups blocks by location', () => {
      const blocks = [
        new PreservedBlock('cloud-conditional', 'cloud1', 'after-header'),
        new PreservedBlock('include', 'include1', 'after-flags'),
        new PreservedBlock('cloud-conditional', 'cloud2', 'after-flags'),
        new PreservedBlock('self-hosted-conditional', 'sh1', 'after-header')
      ]

      const grouped = groupByLocation(blocks)
      expect(grouped['after-header']).toHaveLength(2)
      expect(grouped['after-flags']).toHaveLength(2)
      expect(grouped['after-usage']).toHaveLength(0)
    })

    test('puts unknown locations in end', () => {
      const blocks = [
        new PreservedBlock('custom', 'content', 'after-unknown-section')
      ]

      const grouped = groupByLocation(blocks)
      expect(grouped['end']).toHaveLength(1)
    })

    test('handles empty input', () => {
      const grouped = groupByLocation([])
      expect(grouped['after-header']).toEqual([])
      expect(grouped['after-flags']).toEqual([])
    })
  })

  describe('renderPreservedBlocks', () => {
    test('renders blocks with double newlines between', () => {
      const blocks = [
        new PreservedBlock('cloud-conditional', 'ifdef::env-cloud[]\nCloud content\nendif::[]', 'after-header'),
        new PreservedBlock('include', 'include::foo[]', 'after-header')
      ]

      const rendered = renderPreservedBlocks(blocks)
      expect(rendered).toBe('ifdef::env-cloud[]\nCloud content\nendif::[]\n\ninclude::foo[]')
    })

    test('returns empty string for empty array', () => {
      expect(renderPreservedBlocks([])).toBe('')
    })

    test('returns empty string for null/undefined', () => {
      expect(renderPreservedBlocks(null)).toBe('')
      expect(renderPreservedBlocks(undefined)).toBe('')
    })
  })

  describe('loadPreservationsFromDirectory', () => {
    test('returns empty map for non-existent directory', () => {
      const result = loadPreservationsFromDirectory('/nonexistent/dir')
      expect(result.size).toBe(0)
    })

    test('loads preservations from directory structure', () => {
      // Create test directory structure
      const rpkDir = path.join(tempDir, 'rpk')
      const topicDir = path.join(rpkDir, 'rpk-topic')
      fs.mkdirSync(topicDir, { recursive: true })

      fs.writeFileSync(path.join(rpkDir, 'rpk.adoc'), `= rpk
:description: Root command
`)

      fs.writeFileSync(path.join(topicDir, 'rpk-topic-create.adoc'), `= rpk topic create
:description: Create topic

ifdef::env-cloud[]
Cloud-only note.
endif::[]

== Usage
`)

      const result = loadPreservationsFromDirectory(rpkDir)
      expect(result.size).toBe(1)
      expect(result.has('rpk topic create')).toBe(true)
      expect(result.get('rpk topic create')).toHaveLength(1)
    })

    test('converts filename to command path correctly', () => {
      fs.writeFileSync(path.join(tempDir, 'rpk-cluster-storage-mount.adoc'), `= rpk cluster storage mount
:description: Mount topic

ifdef::env-cloud[]
Test content
endif::[]
`)

      const result = loadPreservationsFromDirectory(tempDir)
      expect(result.has('rpk cluster storage mount')).toBe(true)
    })

    test('normalizes double dashes to single space', () => {
      // Hypothetical filename with double dash (unlikely but possible)
      fs.writeFileSync(path.join(tempDir, 'rpk--test.adoc'), `= rpk test
:description: Test command

ifdef::env-cloud[]
Test content
endif::[]
`)

      const result = loadPreservationsFromDirectory(tempDir)
      // Should be "rpk test" not "rpk  test" (double space)
      expect(result.has('rpk test')).toBe(true)
      expect(result.has('rpk  test')).toBe(false)
    })

    test('skips files with no preserved content', () => {
      fs.writeFileSync(path.join(tempDir, 'rpk-topic.adoc'), `= rpk topic
:description: Topic commands

No conditionals or includes here.
`)

      const result = loadPreservationsFromDirectory(tempDir)
      expect(result.size).toBe(0)
    })
  })

  describe('parseOverridePreservations', () => {
    test('parses includes from overrides', () => {
      const override = {
        includes: {
          after_flags: ['shared:partial$warning.adoc'],
          after_description: 'shared:partial$note.adoc'
        }
      }

      const blocks = parseOverridePreservations(override)
      expect(blocks).toHaveLength(2)
      expect(blocks[0].type).toBe('include')
      expect(blocks[0].location).toBe('after-flags')
      expect(blocks[0].context.includePath).toBe('shared:partial$warning.adoc')
      expect(blocks[1].type).toBe('include')
      expect(blocks[1].location).toBe('after-description')
    })

    test('parses cloudContent from overrides', () => {
      const override = {
        cloudContent: {
          after_header: 'NOTE: This is cloud-only.'
        }
      }

      const blocks = parseOverridePreservations(override)
      expect(blocks).toHaveLength(1)
      expect(blocks[0].type).toBe('cloud-conditional')
      expect(blocks[0].content).toBe('ifdef::env-cloud[]\nNOTE: This is cloud-only.\nendif::[]')
      expect(blocks[0].location).toBe('after-header')
    })

    test('parses selfHostedContent from overrides', () => {
      const override = {
        selfHostedContent: {
          after_description: 'Self-hosted specific info.'
        }
      }

      const blocks = parseOverridePreservations(override)
      expect(blocks).toHaveLength(1)
      expect(blocks[0].type).toBe('self-hosted-conditional')
      expect(blocks[0].content).toBe('ifndef::env-cloud[]\nSelf-hosted specific info.\nendif::[]')
    })

    test('parses multiple override types', () => {
      const override = {
        includes: {
          after_flags: ['include1.adoc']
        },
        cloudContent: {
          after_header: 'Cloud note'
        },
        selfHostedContent: {
          after_header: 'Self-hosted note'
        }
      }

      const blocks = parseOverridePreservations(override)
      expect(blocks).toHaveLength(3)
    })

    test('handles empty override', () => {
      const blocks = parseOverridePreservations({})
      expect(blocks).toEqual([])
    })

    test('marks blocks as fromOverride', () => {
      const override = {
        includes: { after_flags: ['test.adoc'] }
      }

      const blocks = parseOverridePreservations(override)
      expect(blocks[0].context.fromOverride).toBe(true)
    })
  })

  describe('mergeWithOverrides', () => {
    test('override includes take precedence over file includes at same path', () => {
      const filePreservations = [
        new PreservedBlock('include', 'include::shared:partial$test.adoc[]', 'after-flags', { includePath: 'shared:partial$test.adoc' })
      ]
      const overridePreservations = [
        new PreservedBlock('include', 'include::shared:partial$test.adoc[]', 'after-description', { includePath: 'shared:partial$test.adoc', fromOverride: true })
      ]

      const merged = mergeWithOverrides(filePreservations, overridePreservations)
      // File preservation should be removed (override handles same include path)
      expect(merged).toHaveLength(1)
      expect(merged[0].context.fromOverride).toBe(true)
    })

    test('keeps unique file preservations', () => {
      const filePreservations = [
        new PreservedBlock('include', 'include::unique.adoc[]', 'after-flags', { includePath: 'unique.adoc' })
      ]
      const overridePreservations = [
        new PreservedBlock('include', 'include::different.adoc[]', 'after-header', { includePath: 'different.adoc', fromOverride: true })
      ]

      const merged = mergeWithOverrides(filePreservations, overridePreservations)
      expect(merged).toHaveLength(2)
    })

    test('removes duplicate conditionals by content', () => {
      const filePreservations = [
        new PreservedBlock('cloud-conditional', 'ifdef::env-cloud[]\nSame content\nendif::[]', 'after-header')
      ]
      const overridePreservations = [
        new PreservedBlock('cloud-conditional', 'ifdef::env-cloud[]\nSame content\nendif::[]', 'after-description', { fromOverride: true })
      ]

      const merged = mergeWithOverrides(filePreservations, overridePreservations)
      // File preservation should be removed since override has same content
      expect(merged).toHaveLength(1)
      expect(merged[0].context.fromOverride).toBe(true)
    })

    test('removes file preservation when override has same type+location', () => {
      const filePreservations = [
        new PreservedBlock('cloud-conditional', 'ifdef::env-cloud[]\nOld content\nendif::[]', 'after-header')
      ]
      const overridePreservations = [
        new PreservedBlock('cloud-conditional', 'ifdef::env-cloud[]\nNew content\nendif::[]', 'after-header', { fromOverride: true })
      ]

      const merged = mergeWithOverrides(filePreservations, overridePreservations)
      expect(merged).toHaveLength(1)
      expect(merged[0].content).toContain('New content')
    })

    test('handles empty inputs', () => {
      expect(mergeWithOverrides([], [])).toEqual([])
      expect(mergeWithOverrides([], [new PreservedBlock('include', 'test', 'after-header')])).toHaveLength(1)
      expect(mergeWithOverrides([new PreservedBlock('include', 'test', 'after-header')], [])).toHaveLength(1)
    })
  })
})
