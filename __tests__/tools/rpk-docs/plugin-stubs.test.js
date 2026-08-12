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

  test('copies the partial description into created stub headers', () => {
    fs.writeFileSync(path.join(partialsDir, 'rpk-ai-agent-create.adoc'),
      '= rpk ai agent create\n:description: Create an agent.\n:page-platforms: linux,darwin\n\n// tag::single-source[]\n:description: Create an agent.\nBody.\n// end::single-source[]\n')

    const result = run()

    expect(result.created).toEqual(['rpk-ai-agent-create.adoc'])
    const stub = fs.readFileSync(path.join(stubDir, 'rpk-ai-agent-create.adoc'), 'utf8').split('\n')
    expect(stub[0]).toBe('= rpk ai agent create')
    expect(stub[1]).toBe(':description: Create an agent.')
    expect(stub[2]).toBe(':page-preview: true')
  })

  test('creates stubs without a description line when the partial has none', () => {
    fs.writeFileSync(path.join(partialsDir, 'rpk-ai-bare.adoc'),
      '= rpk ai bare\n\n// tag::single-source[]\nBody.\n// end::single-source[]\n')

    const result = run()

    expect(result.created).toEqual(['rpk-ai-bare.adoc'])
    const stub = fs.readFileSync(path.join(stubDir, 'rpk-ai-bare.adoc'), 'utf8')
    expect(stub).not.toContain(':description:')
    expect(stub).toContain(':page-preview: true')
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

describe('dynamic description inheritance via the meta tag region', () => {
  const fs = require('fs')
  const path = require('path')
  const os = require('os')
  const { readPartialTitles, renderStub } = require('../../../tools/rpk-docs/generate-plugin-stubs.js')

  // Antora resolves page metadata with a header-only parse that stops at the
  // stub's first blank line, so a description can only reach the rendered
  // page's <meta> tag as a header attribute: either a literal line or an
  // include placed above the first blank line. Verified empirically against
  // an Antora build with the production UI bundle (2026-08-05): the naive
  // no-blank-line body include inherits the description but destroys the
  // page body, and the two-include shape delivers both.

  test('stubs for partials with a meta tag region get the header include', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-meta-'))
    fs.writeFileSync(path.join(dir, 'rpk-ai-run.adoc'), [
      '= rpk ai run',
      ':description: Run things.',
      '',
      '// tag::single-source[]',
      '// tag::meta[]',
      ':description: Run things.',
      '// end::meta[]',
      'Body.',
      '// end::single-source[]',
    ].join('\n'))
    const [partial] = readPartialTitles(dir)
    expect(partial.hasMetaTag).toBe(true)

    const stub = renderStub({ ...partial, includePrefix: 'streaming:reference:partial$rpk-ai/', attributes: [] })
    const lines = stub.split('\n')
    // The meta include sits in the header: directly under the title with no
    // blank line before it, and the body include after the blank line.
    expect(lines[0]).toBe('= rpk ai run')
    expect(lines[1]).toBe('include::streaming:reference:partial$rpk-ai/rpk-ai-run.adoc[tag=meta]')
    expect(lines[2]).toBe('')
    expect(lines[3]).toBe('include::streaming:reference:partial$rpk-ai/rpk-ai-run.adoc[tag=single-source]')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('stubs for older partials without the region keep the plain shape', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-nometa-'))
    fs.writeFileSync(path.join(dir, 'rpk-ai-old.adoc'), [
      '= rpk ai old',
      '',
      '// tag::single-source[]',
      'Body.',
      '// end::single-source[]',
    ].join('\n'))
    const [partial] = readPartialTitles(dir)
    expect(partial.hasMetaTag).toBe(false)

    const stub = renderStub({ ...partial, includePrefix: 'p$/', attributes: [] })
    // No tag=meta include, so the build never warns about a missing tag.
    expect(stub).not.toContain('[tag=meta]')
    expect(stub.split('\n')[1]).toBe('')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('existing-stub upgrade to the meta include', () => {
  const fs = require('fs')
  const path = require('path')
  const os = require('os')
  const { reconcileStubs, readPartialTitles } = require('../../../tools/rpk-docs/generate-plugin-stubs.js')

  test('adds the header include to an existing stub when the partial gains the region', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-upgrade-'))
    const partialsDir = path.join(dir, 'partials')
    const stubDir = path.join(dir, 'stubs')
    const navFile = path.join(dir, 'nav.adoc')
    fs.mkdirSync(partialsDir); fs.mkdirSync(stubDir)
    fs.writeFileSync(navFile, '* xref:reference:rpk/index.adoc[rpk]\n')
    const prefix = 'streaming:reference:partial$rpk-ai/'
    fs.writeFileSync(path.join(partialsDir, 'rpk-ai-run.adoc'),
      '= rpk ai run\n// tag::single-source[]\n// tag::meta[]\n:description: D.\n// end::meta[]\nBody.\n// end::single-source[]\n')
    fs.writeFileSync(path.join(stubDir, 'rpk-ai-run.adoc'),
      `= rpk ai run\n\ninclude::${prefix}rpk-ai-run.adoc[tag=single-source]\n`)

    const run = () => reconcileStubs({
      partials: readPartialTitles(partialsDir),
      stubDir,
      navFile,
      plugin: 'ai',
      includePrefix: prefix,
      attributes: [],
      dryRun: false
    })
    const result = run()
    expect(result.upgraded).toEqual(['rpk-ai-run.adoc'])
    const lines = fs.readFileSync(path.join(stubDir, 'rpk-ai-run.adoc'), 'utf8').split('\n')
    expect(lines[0]).toBe('= rpk ai run')
    expect(lines[1]).toBe(`include::${prefix}rpk-ai-run.adoc[tag=meta]`)
    expect(lines[2]).toBe('')

    // Idempotent: a second run changes nothing
    expect(run().upgraded).toEqual([])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('the upgrade strips a backfilled literal description, which would otherwise win', () => {
    // Later attribute entries override earlier ones, so a literal below
    // the inserted include would take precedence and freshness would
    // never materialize (micheleRP's precedence finding, verified).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-strip-'))
    const partialsDir = path.join(dir, 'partials')
    const stubDir = path.join(dir, 'stubs')
    const navFile = path.join(dir, 'nav.adoc')
    fs.mkdirSync(partialsDir); fs.mkdirSync(stubDir)
    fs.writeFileSync(navFile, '* xref:reference:rpk/index.adoc[rpk]\n')
    const prefix = 'streaming:reference:partial$rpk-ai/'
    fs.writeFileSync(path.join(partialsDir, 'rpk-ai-run.adoc'),
      '= rpk ai run\n// tag::single-source[]\n// tag::meta[]\n:description: Fresh.\n// end::meta[]\nBody.\n// end::single-source[]\n')
    fs.writeFileSync(path.join(stubDir, 'rpk-ai-run.adoc'),
      `= rpk ai run\n:description: Stale backfilled copy.\n\ninclude::${prefix}rpk-ai-run.adoc[tag=single-source]\n`)

    const result = reconcileStubs({
      partials: readPartialTitles(partialsDir),
      stubDir,
      navFile,
      plugin: 'ai',
      includePrefix: prefix,
      attributes: [],
      dryRun: false
    })
    expect(result.upgraded).toEqual(['rpk-ai-run.adoc'])
    const content = fs.readFileSync(path.join(stubDir, 'rpk-ai-run.adoc'), 'utf8')
    expect(content).not.toContain(':description: Stale backfilled copy.')
    expect(content.split('\n')[1]).toBe(`include::${prefix}rpk-ai-run.adoc[tag=meta]`)
  })
})
