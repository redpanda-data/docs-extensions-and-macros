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

  test('supports page-family includes (rp-connect-docs pattern)', () => {
    writePartial('rpk-connect-run.adoc', 'rpk connect run')
    const result = reconcileStubs({
      partials: readPartialTitles(partialsDir),
      stubDir,
      navFile: null,
      plugin: 'connect',
      includePrefix: 'streaming:reference:page$rpk/rpk-connect/'
    })
    expect(result.created).toEqual(['rpk-connect-run.adoc'])
    const stub = fs.readFileSync(path.join(stubDir, 'rpk-connect-run.adoc'), 'utf8')
    expect(stub).toContain('include::streaming:reference:page$rpk/rpk-connect/rpk-connect-run.adoc[tag=single-source]')
    // A second run recognizes the page-family stub as managed
    const second = reconcileStubs({
      partials: [],
      stubDir,
      navFile: null,
      plugin: 'connect',
      includePrefix: 'streaming:reference:page$rpk/rpk-connect/'
    })
    expect(second.deleted).toEqual(['rpk-connect-run.adoc'])
  })

  test('dry run reports without writing', () => {
    writePartial('rpk-ai.adoc', 'rpk ai')
    const result = run({ dryRun: true })
    expect(result.created).toEqual(['rpk-ai.adoc'])
    expect(fs.existsSync(path.join(stubDir, 'rpk-ai.adoc'))).toBe(false)
  })
})

describe('alias-collision guard', () => {
  const fs2 = require('fs')
  const path2 = require('path')
  const os2 = require('os')
  const { reconcileStubs: recon, readPartialTitles: readTitles, renderStub: render } = require('../../../tools/rpk-docs/generate-plugin-stubs.js')

  test('never creates a stub whose name is claimed as a page alias', () => {
    const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'alias-guard-'))
    const partialsDir = path2.join(dir, 'partials'); fs2.mkdirSync(partialsDir)
    const stubDir = path2.join(dir, 'stubs'); fs2.mkdirSync(stubDir)

    // Upstream still has the old-name partial; this repo's renamed page claims it as alias
    fs2.writeFileSync(path2.join(partialsDir, 'rpk-ai-llm.adoc'), '= rpk ai llm\n')
    fs2.writeFileSync(path2.join(partialsDir, 'rpk-ai-llm-provider.adoc'), '= rpk ai llm-provider\n')
    fs2.writeFileSync(path2.join(stubDir, 'rpk-ai-llm-provider.adoc'),
      '= rpk ai llm-provider\n:page-aliases: reference:rpk/rpk-ai/rpk-ai-llm.adoc\n\ninclude::streaming:reference:partial$rpk-ai/rpk-ai-llm-provider.adoc[tag=single-source]\n')

    const result = recon({
      partials: readTitles(partialsDir),
      stubDir,
      navFile: null,
      plugin: 'ai',
      includePrefix: 'streaming:reference:partial$rpk-ai/'
    })

    expect(result.skippedAliasTargets).toEqual([
      { file: 'rpk-ai-llm.adoc', claimedBy: 'rpk-ai-llm-provider.adoc' }
    ])
    expect(result.created).toEqual([])
    expect(fs2.existsSync(path2.join(stubDir, 'rpk-ai-llm.adoc'))).toBe(false)
    fs2.rmSync(dir, { recursive: true, force: true })
  })
})
