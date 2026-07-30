'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const {
  readPartialTitles,
  inferIncludePrefix,
  renderStub,
  reconcileStubs
} = require('../../../tools/rpk-docs/generate-plugin-stubs.js')

describe('plugin stub reconciler', () => {
  let dir, partialsDir, stubDir, navFile

  const writePartial = (file, title) => {
    fs.writeFileSync(path.join(partialsDir, file), `= ${title}\n:description: x\n\n// tag::single-source[]\nBody.\n// end::single-source[]\n`)
  }

  const writeStub = (file, title, partialFile) => {
    fs.writeFileSync(path.join(stubDir, file), renderStub({
      title,
      file: partialFile || file,
      includePrefix: 'streaming:reference:partial$rpk-ai/',
      attributes: [':page-preview: true']
    }))
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-recon-'))
    partialsDir = path.join(dir, 'partials')
    stubDir = path.join(dir, 'stubs')
    navFile = path.join(dir, 'nav.adoc')
    fs.mkdirSync(partialsDir)
    fs.mkdirSync(stubDir)
    fs.writeFileSync(navFile, [
      '** xref:reference:rpk/index.adoc[rpk Command Reference]',
      '*** xref:reference:rpk/rpk-ai/rpk-ai.adoc[rpk ai]',
      '**** xref:reference:rpk/rpk-ai/rpk-ai-old.adoc[]',
      '*** xref:reference:rpk-install.adoc[Install rpk]',
      ''
    ].join('\n'))
  })

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const run = (overrides = {}) => reconcileStubs({
    partials: readPartialTitles(partialsDir),
    stubDir,
    navFile,
    plugin: 'ai',
    includePrefix: 'streaming:reference:partial$rpk-ai/',
    ...overrides
  })

  test('creates stubs for new partials and deletes orphaned managed stubs', () => {
    writePartial('rpk-ai.adoc', 'rpk ai')
    writePartial('rpk-ai-auth.adoc', 'rpk ai auth')
    writePartial('rpk-ai-auth-login.adoc', 'rpk ai auth login')
    writeStub('rpk-ai-old.adoc', 'rpk ai old') // partial gone

    const result = run()

    expect(result.created.sort()).toEqual(['rpk-ai-auth-login.adoc', 'rpk-ai-auth.adoc', 'rpk-ai.adoc'])
    expect(result.deleted).toEqual(['rpk-ai-old.adoc'])
    const stub = fs.readFileSync(path.join(stubDir, 'rpk-ai-auth-login.adoc'), 'utf8')
    expect(stub).toContain('= rpk ai auth login')
    expect(stub).toContain(':page-preview: true')
    expect(stub).toContain('include::streaming:reference:partial$rpk-ai/rpk-ai-auth-login.adoc[tag=single-source]')
  })

  test('rebuilds the nav block hierarchically and preserves surrounding nav', () => {
    writePartial('rpk-ai.adoc', 'rpk ai')
    writePartial('rpk-ai-auth.adoc', 'rpk ai auth')
    writePartial('rpk-ai-auth-login.adoc', 'rpk ai auth login')

    const result = run()

    expect(result.navUpdated).toBe(true)
    const nav = fs.readFileSync(navFile, 'utf8').split('\n')
    expect(nav[1]).toBe('*** xref:reference:rpk/rpk-ai/rpk-ai.adoc[rpk ai]')
    expect(nav[2]).toBe('**** xref:reference:rpk/rpk-ai/rpk-ai-auth.adoc[]')
    expect(nav[3]).toBe('***** xref:reference:rpk/rpk-ai/rpk-ai-auth-login.adoc[]')
    expect(nav[4]).toBe('*** xref:reference:rpk-install.adoc[Install rpk]')
    expect(nav.join('\n')).not.toContain('rpk-ai-old.adoc')
  })

  test('never deletes pages that are not managed stubs', () => {
    writePartial('rpk-ai.adoc', 'rpk ai')
    fs.writeFileSync(path.join(stubDir, 'hand-written.adoc'), '= Concepts\n\nReal prose, no include.\n')

    const result = run()

    expect(result.keptNonStub).toEqual(['hand-written.adoc'])
    expect(fs.existsSync(path.join(stubDir, 'hand-written.adoc'))).toBe(true)
  })

  test('flags likely renames for reviewer alias decisions', () => {
    writePartial('rpk-ai.adoc', 'rpk ai')
    writePartial('rpk-ai-llm-provider.adoc', 'rpk ai llm-provider')
    writeStub('rpk-ai-llm.adoc', 'rpk ai llm')

    const result = run()

    expect(result.renameCandidates).toEqual([
      { deleted: 'rpk-ai-llm.adoc', created: 'rpk-ai-llm-provider.adoc' }
    ])
  })

  test('is idempotent', () => {
    writePartial('rpk-ai.adoc', 'rpk ai')
    writePartial('rpk-ai-run.adoc', 'rpk ai run')
    run()
    const second = run()
    expect(second.created).toEqual([])
    expect(second.deleted).toEqual([])
    expect(second.navUpdated).toBe(false)
  })

  test('infers the include prefix from an existing stub', () => {
    writeStub('rpk-ai-run.adoc', 'rpk ai run')
    expect(inferIncludePrefix(stubDir, 'ai')).toBe('streaming:reference:partial$rpk-ai/')
    expect(inferIncludePrefix(path.join(dir, 'missing'), 'ai')).toBe(null)
  })

  test('dry run reports without writing', () => {
    writePartial('rpk-ai.adoc', 'rpk ai')
    const result = run({ dryRun: true })
    expect(result.created).toEqual(['rpk-ai.adoc'])
    expect(fs.existsSync(path.join(stubDir, 'rpk-ai.adoc'))).toBe(false)
  })
})
