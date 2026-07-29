'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const { updateWhatsNewFile } = require('../../../tools/rpk-docs/rpk-docs-handler.js')

describe('updateWhatsNewFile merge semantics', () => {
  let tempDir
  let whatsNewPath

  const diffWith = (details) => ({
    comparison: { oldVersion: 'v1', newVersion: 'v2' },
    summary: {},
    details: {
      newCommands: [],
      newlyDeprecatedCommands: [],
      removedCommands: [],
      newFlags: [],
      removedFlags: [],
      changedDefaults: [],
      changedFlagTypes: [],
      descriptionChanges: [],
      ...details
    }
  })

  const rcDiff = (cmdPath) => diffWith({
    newCommands: [{ path: cmdPath, description: 'Does things' }]
  })

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whats-new-test-'))
    whatsNewPath = path.join(tempDir, 'redpanda.adoc')
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('creates a marked Redpanda CLI section when none exists', () => {
    fs.writeFileSync(whatsNewPath, '= What\'s New\n\n== Bug fixes\n\nStuff.\n')
    updateWhatsNewFile(rcDiff('rpk topic new'), whatsNewPath, 'v2.0.1-rc1')

    const content = fs.readFileSync(whatsNewPath, 'utf8')
    expect(content).toContain('== Redpanda CLI')
    expect(content).toContain('// AUTOGEN-RPK-CHANGES v2.0.1-rc1 START')
    expect(content).toContain('`rpk topic new`')
    // Inserted before Bug fixes
    expect(content.indexOf('== Redpanda CLI')).toBeLessThan(content.indexOf('== Bug fixes'))
  })

  test('appends a second version block into the existing section', () => {
    fs.writeFileSync(whatsNewPath, '= What\'s New\n\n== Bug fixes\n\nStuff.\n')
    updateWhatsNewFile(rcDiff('rpk topic new'), whatsNewPath, 'v2.0.1-rc1')
    updateWhatsNewFile(rcDiff('rpk cluster newer'), whatsNewPath, 'v2.0.1-rc2')

    const content = fs.readFileSync(whatsNewPath, 'utf8')
    expect(content.match(/== Redpanda CLI/g)).toHaveLength(1)
    expect(content).toContain('AUTOGEN-RPK-CHANGES v2.0.1-rc1 START')
    expect(content).toContain('AUTOGEN-RPK-CHANGES v2.0.1-rc2 START')
    expect(content).toContain('`rpk topic new`')
    expect(content).toContain('`rpk cluster newer`')
    // Both blocks stay inside the CLI section, before Bug fixes
    expect(content.indexOf('rc2 START')).toBeLessThan(content.indexOf('== Bug fixes'))
  })

  test('re-running the same version replaces its block instead of duplicating', () => {
    fs.writeFileSync(whatsNewPath, '= What\'s New\n')
    updateWhatsNewFile(rcDiff('rpk topic old-name'), whatsNewPath, 'v2.0.1-rc1')
    updateWhatsNewFile(rcDiff('rpk topic renamed'), whatsNewPath, 'v2.0.1-rc1')

    const content = fs.readFileSync(whatsNewPath, 'utf8')
    expect(content.match(/AUTOGEN-RPK-CHANGES v2\.0\.1-rc1 START/g)).toHaveLength(1)
    expect(content).toContain('`rpk topic renamed`')
    expect(content).not.toContain('`rpk topic old-name`')
  })

  test('preserves a hand-written CLI section and appends after it', () => {
    fs.writeFileSync(whatsNewPath, [
      '= What\'s New',
      '',
      '== Redpanda CLI (rpk)',
      '',
      '* *Hand-curated entry*: writers wrote this.',
      '',
      '== Bug fixes',
      '',
      'Stuff.',
      ''
    ].join('\n'))

    updateWhatsNewFile(rcDiff('rpk topic new'), whatsNewPath, 'v2.0.1-rc3')

    const content = fs.readFileSync(whatsNewPath, 'utf8')
    expect(content).toContain('* *Hand-curated entry*: writers wrote this.')
    expect(content).toContain('AUTOGEN-RPK-CHANGES v2.0.1-rc3 START')
    // Appended inside the CLI section (before Bug fixes), after manual prose
    expect(content.indexOf('Hand-curated entry')).toBeLessThan(content.indexOf('AUTOGEN-RPK-CHANGES'))
    expect(content.indexOf('AUTOGEN-RPK-CHANGES v2.0.1-rc3 END')).toBeLessThan(content.indexOf('== Bug fixes'))
  })

  test('plugin runs write to a separate rpk plugins section without xrefs', () => {
    fs.writeFileSync(whatsNewPath, '= What\'s New\n\n== Redpanda CLI\n\n* Core entry.\n')
    updateWhatsNewFile(rcDiff('rpk ai gateway'), whatsNewPath, 'ai plugin 0.3.0', {
      xrefs: false,
      sectionHeading: '== rpk plugins'
    })

    const content = fs.readFileSync(whatsNewPath, 'utf8')
    expect(content).toContain('== rpk plugins')
    expect(content).toContain('AUTOGEN-RPK-CHANGES ai plugin 0.3.0 START')
    expect(content).toContain('=== ai plugin 0.3.0')
    expect(content).toContain('`rpk ai gateway`')
    expect(content).not.toContain('xref:')
    // Core section untouched
    expect(content).toContain('* Core entry.')
    const cliIdx = content.indexOf('== Redpanda CLI')
    expect(content.indexOf('AUTOGEN-RPK-CHANGES')).toBeGreaterThan(cliIdx)
  })

  test('block headings carry the version so accumulated blocks never collide', () => {
    fs.writeFileSync(whatsNewPath, '= What\'s New\n')
    updateWhatsNewFile(rcDiff('rpk topic a'), whatsNewPath, 'v2.0.1-rc1')
    updateWhatsNewFile(rcDiff('rpk topic b'), whatsNewPath, 'v2.0.1-rc2')

    const content = fs.readFileSync(whatsNewPath, 'utf8')
    expect(content).toContain('=== v2.0.1-rc1')
    expect(content).toContain('=== v2.0.1-rc2')
    // Category headings nest under the version heading
    expect(content).toContain('==== New commands')
    expect(content).not.toMatch(/^=== New commands$/m)
  })

  test('writes deprecations from the diff', () => {
    fs.writeFileSync(whatsNewPath, '= What\'s New\n')
    updateWhatsNewFile(diffWith({
      newlyDeprecatedCommands: [{
        path: 'rpk redpanda admin',
        message: 'use `rpk cluster` subcommands',
        replacement: 'Use xref:reference:rpk/rpk-cluster/rpk-cluster.adoc[`rpk cluster`] instead.',
        hidden: true
      }]
    }), whatsNewPath, 'v2.0.0')

    const content = fs.readFileSync(whatsNewPath, 'utf8')
    expect(content).toContain('==== Deprecated commands')
    expect(content).toContain('rpk-cluster.adoc')
  })
})
