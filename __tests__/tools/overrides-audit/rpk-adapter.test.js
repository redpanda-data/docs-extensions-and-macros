'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const { runAudit, formatHumanReport } = require('../../../tools/overrides-audit')
const { CLASSES } = require('../../../tools/overrides-audit/classify')
const rpk = require('../../../tools/overrides-audit/adapters/rpk')

// The rpk surface classifies override prose against the snapshot's raw_tree
// through the generator's own formatting. Every fixture here is synthetic:
// the shapes mirror `rpk --print-tree` output and rpk-overrides.json, the
// words do not come from any rpk source file.

describe('overrides-audit rpk adapter (prose classification)', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overrides-audit-rpk-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeFixture (name, data) {
    const filePath = path.join(tmpDir, name)
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    return filePath
  }

  // A raw tree the way the binary prints it: no backticks, no trailing
  // periods, ALL-CAPS section titles, indented example lines.
  const rawTree = {
    name: 'rpk',
    description: 'rpk is the Redpanda CLI & toolbox',
    usage: 'rpk [command]',
    global_flags: [
      { name: 'config', type: 'string', description: 'rpk config file path', default: '' }
    ],
    commands: [
      {
        name: 'widget',
        description: 'Manage widgets',
        usage: 'rpk widget [command]',
        flags: [],
        commands: [
          {
            name: 'create',
            description: 'Create widgets\n\nAll widgets created with this command share the same --size value.\n\nEXAMPLES\n\nCreate a widget named foo\n  rpk widget create foo\n',
            usage: 'rpk widget create [WIDGETS...] [flags]',
            flags: [
              { name: 'size', shorthand: 's', type: 'int', description: 'Size of the widget (defaults to $WIDGET_SIZE)', default: 0 },
              { name: 'dry', type: 'bool', description: 'Dry run: validate the request; do not create widgets', default: false }
            ]
          },
          {
            name: 'delete',
            description: 'Delete widgets',
            usage: 'rpk widget delete [WIDGETS...] [flags]',
            flags: [
              { name: 'regex', type: 'bool', description: 'Treat names as regular expressions', default: false }
            ]
          }
        ]
      }
    ]
  }

  const snapshot = {
    rpk_version: 'v1.2.3',
    plugin_versions: {},
    raw_tree: rawTree,
    // The override-merged view. Deliberately different from raw_tree so a
    // test can prove the audit never reads it.
    tree: { name: 'rpk', description: 'MERGED', commands: [] }
  }

  const textTransformations = {
    replacements: [
      { description: "Convert 'Note:' to 'NOTE:' (admonition)", pattern: '(^|\\n\\s*)Note:\\s', replacement: '$1NOTE: ', flags: 'g' }
    ],
    inlineCode: []
  }

  function overridesWith (commands, extra = {}) {
    return {
      $schema: './rpk-overrides.schema.json',
      _notes: { ignored: 'yes' },
      textTransformations,
      definitions: {},
      commands,
      ...extra
    }
  }

  function auditWith (commands, extra) {
    const result = runAudit({
      overrides: writeFixture('rpk-overrides.json', overridesWith(commands, extra)),
      extracted: writeFixture('rpk-v1.2.3.json', snapshot),
      surface: 'rpk'
    })
    const byKey = Object.fromEntries(result.manifest.map((row) => [`${row.name}|${row.field}`, row]))
    return { result, byKey }
  }

  describe('REDUNDANT: equal after the generator\'s own normalization (negative controls)', () => {
    test('a description that only adds the trailing period and backticks the formatter adds anyway', () => {
      const { byKey, result } = auditWith({
        'rpk widget create': {
          // Raw: 'Create widgets' + '--size' bare. The formatter adds the
          // period and backticks `--size` itself, so this changes nothing.
          description: 'Create widgets.\n\nAll widgets created with this command share the same `--size` value.\n\nEXAMPLES\n\nCreate a widget named foo\n  rpk widget create foo\n'
        }
      })
      const row = byKey['rpk widget create|description']
      expect(row.class).toBe(CLASSES.REDUNDANT)
      expect(row.note).toMatch(/identical without this override/)
      expect(row.source_text).toBe(row.rendered_text)
      expect(row.differs_in).toBeUndefined()
      expect(row.content_hash).toMatch(/^[0-9a-f]{16}$/)
      // Retirement safety: deleting it leaves every command's output unchanged.
      expect(result.cross_check).toEqual({ redundant_fields_removed: 1, commands_compared: 4, violations: [] })
    })

    test('a flag description that only backticks a shell variable and ends with a period', () => {
      const { byKey } = auditWith({
        'rpk widget create': { flags: { size: { description: 'Size of the widget (defaults to `$WIDGET_SIZE`).' } } }
      })
      expect(byKey['rpk widget create --size|flags.description'].class).toBe(CLASSES.REDUNDANT)
    })

    test('a description that only applies a textTransformations rule by hand (Note: -> NOTE:)', () => {
      const tree = JSON.parse(JSON.stringify(snapshot))
      tree.raw_tree.commands[0].commands[1].description = 'Delete widgets\n\nNote: this cannot be undone.'
      const result = runAudit({
        overrides: writeFixture('o.json', overridesWith({ 'rpk widget delete': { description: 'Delete widgets.\n\nNOTE: this cannot be undone.' } })),
        extracted: writeFixture('s.json', tree),
        surface: 'rpk'
      })
      expect(result.manifest[0].class).toBe(CLASSES.REDUNDANT)
    })

    test('whitespace-only differences (re-wrapped lines) are redundant', () => {
      const { byKey } = auditWith({
        'rpk widget create': { flags: { dry: { description: 'Dry run:  validate the request;   do not create widgets.' } } }
      })
      expect(byKey['rpk widget create --dry|flags.description'].class).toBe(CLASSES.REDUNDANT)
    })
  })

  describe('UPSTREAMABLE: differs in substance, plain prose', () => {
    test('a reworded description is upstreamable verbatim with the raw text alongside', () => {
      const text = 'Create one or more widgets.\n\nAll widgets created with one invocation share the same `--size` value.'
      const { byKey } = auditWith({ 'rpk widget create': { description: text, upstream_ref: 'redpanda-data/streaming-enterprise#1' } })
      const row = byKey['rpk widget create|description']
      expect(row.class).toBe(CLASSES.UPSTREAMABLE)
      expect(row.upstream_candidate_text).toBe(text)
      expect(row.upstream_ref).toBe('redpanda-data/streaming-enterprise#1')
      expect(row.source_text).toBe('Create widgets.\n\nAll widgets created with this command share the same `--size` value.')
      // The generator keeps the raw sections when the override has none
      // (mergeCommandOverrides), so only the lead text differs.
      expect(row.differs_in).toEqual(['main'])
    })

    test('a one-word change (capitalization, a backtick the formatter would not add) still counts', () => {
      const { byKey } = auditWith({
        'rpk widget delete': { flags: { regex: { description: 'Treat names as regular expressions (RE2 syntax).' } } }
      })
      const row = byKey['rpk widget delete --regex|flags.description']
      expect(row.class).toBe(CLASSES.UPSTREAMABLE)
      expect(row.source_text).toBe('Treat names as regular expressions.')
    })

    test('a change confined to one section reports that section', () => {
      const { byKey } = auditWith({
        'rpk widget create': {
          description: 'Create widgets.\n\nAll widgets created with this command share the same `--size` value.\n\nEXAMPLES\n\nCreate a widget named bar\n  rpk widget create bar\n'
        }
      })
      const row = byKey['rpk widget create|description']
      expect(row.class).toBe(CLASSES.UPSTREAMABLE)
      expect(row.differs_in).toEqual(['section:EXAMPLES'])
    })

    test('help text may carry ALL-CAPS sections, so an override that adds one is upstreamable', () => {
      const { byKey } = auditWith({
        'rpk widget delete': { description: 'Delete widgets.\n\nNOTES\n\nDeleted widgets cannot be recovered.' }
      })
      const row = byKey['rpk widget delete|description']
      expect(row.class).toBe(CLASSES.UPSTREAMABLE)
      expect(row.differs_in).toEqual(['section:NOTES'])
    })
  })

  describe('KEEP: docs-only constructs', () => {
    test('an xref makes the description KEEP, never upstreamable (negative control)', () => {
      const { byKey } = auditWith({
        'rpk widget delete': { description: 'Delete widgets. See xref:manage:widgets.adoc[Manage widgets].' }
      })
      const row = byKey['rpk widget delete|description']
      expect(row.class).toBe(CLASSES.KEEP)
      expect(row.note).toMatch(/docs-only markup \(xref\)/)
      expect(row.upstream_candidate_text).toBeUndefined()
    })

    test.each([
      ['glossterm', 'Delete glossterm:widgets[].'],
      ['conditional', 'Delete widgets.\n\nifdef::env-cloud[]\nCloud only.\nendif::[]'],
      ['include', 'Delete widgets.\n\ninclude::shared:partial$warning.adoc[]'],
      ['link', 'Delete widgets. See link:https://example.com[the site].'],
      ['attribute', 'Delete widgets in {product-name}.']
    ])('%s markup is KEEP', (kind, text) => {
      const { byKey } = auditWith({ 'rpk widget delete': { description: text } })
      const row = byKey['rpk widget delete|description']
      expect(row.class).toBe(CLASSES.KEEP)
      expect(row.note).toContain(kind)
    })

    test('an audience-scoped description (descriptionScope) is KEEP even when plain', () => {
      const { byKey } = auditWith({
        'rpk widget delete': { description: 'Delete widgets on your own brokers.', descriptionScope: 'self-hosted' }
      })
      expect(byKey['rpk widget delete|description'].class).toBe(CLASSES.KEEP)
      expect(byKey['rpk widget delete|description'].note).toMatch(/descriptionScope: self-hosted/)
      expect(byKey['rpk widget delete|descriptionScope'].class).toBe(CLASSES.KEEP)
    })

    test('selfHostedOnly, content, seeAlso, pageAliases and flag metadata are KEEP', () => {
      const { byKey } = auditWith({
        'rpk widget create': {
          selfHostedOnly: true,
          content: [{ type: 'note', position: 'after_description', content: 'A note.' }],
          seeAlso: ['xref:x.adoc[Widgets]'],
          pageAliases: ['old.adoc'],
          introducedInVersion: 'v1.0.0',
          flags: { size: { introducedInVersion: 'v1.1.0' } }
        }
      })
      for (const field of ['selfHostedOnly', 'content', 'seeAlso', 'pageAliases', 'introducedInVersion']) {
        expect(byKey[`rpk widget create|${field}`].class).toBe(CLASSES.KEEP)
      }
      expect(byKey['rpk widget create --size|flags.introducedInVersion'].class).toBe(CLASSES.KEEP)
    })

    test('textTransformations and definitions are KEEP rows with counts', () => {
      const { byKey } = auditWith(
        { 'rpk widget create': { $refs: ['#/definitions/common-flags'] } },
        { definitions: { 'common-flags': { size: { description: 'Shared size text.' } } } }
      )
      expect(byKey['textTransformations|replacements']).toMatchObject({ class: CLASSES.KEEP, note: expect.stringContaining('1 global replacements rule') })
      expect(byKey['textTransformations|inlineCode'].class).toBe(CLASSES.KEEP)
      expect(byKey['rpk widget create|$refs'].class).toBe(CLASSES.KEEP)
      const def = byKey['definitions/common-flags --size|flags.description']
      expect(def.class).toBe(CLASSES.KEEP)
      expect(def.note).toMatch(/referenced by 1 command/)
      expect(def.content_hash).toMatch(/^[0-9a-f]{16}$/)
    })
  })

  describe('REVIEW: cannot be ruled on automatically', () => {
    test('AsciiDoc block syntax cannot go upstream verbatim', () => {
      const { byKey } = auditWith({
        'rpk widget delete': { description: 'Delete widgets.\n\n[,bash]\n----\nrpk widget delete foo\n----' }
      })
      const row = byKey['rpk widget delete|description']
      expect(row.class).toBe(CLASSES.REVIEW)
      expect(row.note).toMatch(/block-attribute, block-delimiter/)
    })

    test('a command missing from raw_tree is flagged, not compared', () => {
      const { byKey } = auditWith({ 'rpk gone': { description: 'Stale.', flags: { x: { description: 'Stale flag.' } } } })
      expect(byKey['rpk gone|description'].class).toBe(CLASSES.REVIEW)
      expect(byKey['rpk gone|description'].note).toMatch(/not found in the snapshot's raw_tree/)
      expect(byKey['rpk gone --x|flags.description'].class).toBe(CLASSES.REVIEW)
    })

    test('a flag the command does not have is a dead override (the generator never applies it)', () => {
      const { byKey } = auditWith({
        'rpk widget create': { flags: { 'replication-factor': { description: 'Never rendered.' } } },
        // Global flags are rendered from raw_tree.global_flags without overrides.
        rpk: { flags: { config: { description: 'Also never rendered.' } } }
      })
      expect(byKey['rpk widget create --replication-factor|flags.description'].class).toBe(CLASSES.REVIEW)
      expect(byKey['rpk widget create --replication-factor|flags.description'].note).toMatch(/not on this command in raw_tree/)
      expect(byKey['rpk --config|flags.description'].class).toBe(CLASSES.REVIEW)
    })
  })

  describe('inputs', () => {
    test('refuses a snapshot without raw_tree instead of auditing the merged tree', () => {
      expect(() => runAudit({
        overrides: writeFixture('o.json', overridesWith({ rpk: { description: 'x' } })),
        extracted: writeFixture('merged-only.json', { rpk_version: 'v1', tree: snapshot.tree }),
        surface: 'rpk'
      })).toThrow(/no "raw_tree"/)
    })

    test('accepts a bare --print-tree dump as raw', () => {
      expect(rpk.rawTreeOf(rawTree, 'dump.json')).toBe(rawTree)
    })

    test('requires --extracted for the rpk surface', () => {
      expect(() => runAudit({ overrides: writeFixture('o.json', overridesWith({})), surface: 'rpk' }))
        .toThrow(/needs --extracted/)
    })

    test('never reads the merged tree: the merged root says MERGED, the audit compares against raw', () => {
      const { byKey } = auditWith({ rpk: { description: 'rpk is the Redpanda CLI & toolbox.' } })
      expect(byKey['rpk|description'].class).toBe(CLASSES.REDUNDANT)
      expect(byKey['rpk|description'].source_text).toBe('`rpk` is the Redpanda CLI & toolbox.')
    })

    test('reports the snapshot version and renders a human report', () => {
      const { result } = auditWith({ 'rpk widget delete': { description: 'Delete one or more widgets.' } })
      expect(result.snapshot_version).toBe('v1.2.3')
      const report = formatHumanReport(result)
      expect(report).toContain('surface: rpk')
      expect(report).toContain('UPSTREAMABLE')
      expect(report).toContain('rpk widget delete [description]')
    })
  })

  describe('helpers', () => {
    test('findCommandNode walks the tree by full command name', () => {
      expect(rpk.findCommandNode(rawTree, 'rpk widget create').name).toBe('create')
      expect(rpk.findCommandNode(rawTree, 'rpk widget nope')).toBeNull()
      expect(rpk.findCommandNode(rawTree, 'other root')).toBeNull()
      expect(rpk.findCommandNode(rawTree, 'rpk')).toBe(rawTree)
    })

    test('detectBlockMarkup sees block attributes, delimiters and headings but not prose', () => {
      expect(rpk.detectBlockMarkup('Plain prose with a -- dash and a 4-item list.')).toEqual([])
      expect(rpk.detectBlockMarkup('[,yaml]\n----\na: 1\n----')).toEqual(['block-attribute', 'block-delimiter'])
      expect(rpk.detectBlockMarkup('== Heading\n\nText')).toEqual(['heading'])
      expect(rpk.detectBlockMarkup('|===\n|a|b\n|===')).toEqual(['block-delimiter'])
    })

    test('describeDifference names the differing parts in page order', () => {
      const a = { main: 'A', sections: { EXAMPLES: 'x', NOTES: 'n' } }
      const b = { main: 'B', sections: { EXAMPLES: 'x' } }
      expect(rpk.describeDifference(a, b)).toEqual(['main', 'section:NOTES'])
      expect(rpk.describeDifference(a, a)).toEqual([])
    })
  })
})
