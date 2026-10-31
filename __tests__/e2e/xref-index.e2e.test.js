'use strict'

/**
 * End-to-end test: runs a real Antora build over a small fixture site with the
 * xref-index extension registered, then reads the published JSON. A real build
 * is the only way to prove the anchors are the ids Asciidoctor produced (with
 * conditionals resolved and partials expanded), that aliases are registered by
 * the time the index is built, and that unpublished pages stay out whatever
 * order the extensions are registered in.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const generateSite = require('@antora/site-generator')

const UI_BUNDLE = path.join(__dirname, '..', 'fixtures', 'e2e-site', 'ui-bundle.zip')

jest.setTimeout(120000)

function write (root, rel, contents) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

function gitInit (dir) {
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('add', '.')
  git('commit', '-q', '-m', 'fixture')
}

const SOURCES = {
  'streaming-26.2': {
    'antora.yml': 'name: streaming\ntitle: Streaming\nversion: 26.2\n',
    'modules/manage/pages/security/tls.adoc': [
      '= Configure &amp; Rotate TLS',
      ':page-aliases: security/old-tls.adoc',
      '',
      'Intro paragraph BODY_TEXT_MUST_NOT_LEAK.',
      '',
      '== Enable TLS',
      '',
      '[[rotate]]',
      '=== Rotate `certificates`',
      '',
      'ifdef::env-cloud[]',
      '== Cloud only',
      'endif::[]',
      '',
      'include::shared:ROOT:partial$tls-table.adoc[tag=table]',
      '',
      '[#cert-table]',
      '|===',
      '| a | b',
      '|===',
      '',
      'Inline anchor:inline-spot[] here.',
      '',
    ].join('\n'),
    'modules/manage/pages/plain.adoc': '= Plain Page\n\nNo sections here.\n',
    'modules/manage/pages/hidden.adoc': '= Hidden Page\n:page-unpublish: true\n\n== Hidden section\n',
    'modules/manage/pages/late.adoc': '= LateGone Page\n\n== LateGone section\n',
    'modules/manage/pages/fields.adoc': '= FieldOnly Page\n\n== FieldOnly section\n',
    'modules/manage/pages/numbered.adoc': '= Numbered Page\n:sectnums:\n\n== First Section\n\n=== Sub Section\n',
  },
  'streaming-26.3': {
    'antora.yml': 'name: streaming\ntitle: Streaming\nversion: 26.3\nprerelease: true\ndisplay_version: 26.3 Beta\n',
    'modules/manage/pages/security/tls.adoc': '= Configure TLS\n\n== Enable TLS\n',
  },
  shared: {
    'antora.yml': 'name: shared\nversion: ~\n',
    'modules/ROOT/partials/tls-table.adoc': [
      '// tag::table[]',
      '== From partial',
      '',
      'PARTIAL_BODY_MUST_NOT_LEAK',
      '// end::table[]',
      '// tag::other[]',
      'More.',
      '// end::other[]',
      '',
    ].join('\n'),
    'modules/ROOT/examples/config.yaml': '# tag::broker[]\nredpanda: {}\n# end::broker[]\n',
    'modules/ROOT/pages/glossary.adoc': '= Glossary\n:page-aliases: old-glossary.adoc\n',
  },
  secret: {
    'antora.yml': 'name: secret\ntitle: Secret\nversion: ~\n',
    'modules/ROOT/pages/index.adoc': '= Secret Page\n\n== Secret section\n',
  },
}

// Stand-ins for add-pages-to-root and convert-llms-to-txt (remove output at
// beforePublish) and generate-fields-only-pages (marks pages isFieldOnlyPage
// and removes their output at beforePublish).
const LATE_UNPUBLISH = `module.exports.register = function () {
  this.on('beforePublish', ({ contentCatalog }) => {
    const page = contentCatalog.getPages((p) => p.src.relative === 'late.adoc')[0]
    delete page.out
  })
}
`
const FIELD_ONLY = `module.exports.register = function () {
  this.on('documentsConverted', ({ contentCatalog }) => {
    for (const p of contentCatalog.getPages((p) => p.src.relative === 'fields.adoc')) p.isFieldOnlyPage = true
  })
  this.on('beforePublish', ({ contentCatalog }) => {
    for (const p of contentCatalog.getPages((p) => p.isFieldOnlyPage)) delete p.out
  })
}
`

async function build (workDir, extensionConfig) {
  const outDir = path.join(workDir, 'out')
  const playbook = [
    'site:',
    '  title: E2E Site',
    '  url: https://docs.redpanda.com',
    'urls:',
    '  html_extension_style: indexify',
    "  latest_version_segment: 'current'",
    'content:',
    '  sources:',
    ...Object.keys(SOURCES).flatMap((dir) => [`  - url: ${path.join(workDir, dir)}`, '    branches: HEAD']),
    'ui:',
    '  bundle:',
    `    url: ${UI_BUNDLE}`,
    'antora:',
    '  extensions:',
    // Removes output at beforePublish; registered before xref-index, as the
    // REFERENCE asks.
    `  - require: ${path.join(workDir, 'late-unpublish.js')}`,
    // Registered BEFORE unpublish-pages on purpose: the index must still leave
    // out the page that extension removes.
    "  - require: '@redpanda-data/docs-extensions-and-macros/extensions/xref-index'",
    ...extensionConfig.map((line) => `    ${line}`),
    "  - require: '@redpanda-data/docs-extensions-and-macros/extensions/unpublish-pages'",
    // Registered after xref-index: field-only pages are skipped in any order.
    `  - require: ${path.join(workDir, 'field-only.js')}`,
    '',
  ].join('\n')
  const playbookPath = path.join(workDir, `antora-playbook-${Date.now()}.yml`)
  fs.writeFileSync(playbookPath, playbook)
  await generateSite(['--playbook', playbookPath, '--to-dir', outDir, '--log-level', 'error'])
  return outDir
}

describe('xref-index end-to-end', () => {
  let workDir
  let outDir
  let raw
  let index

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xref-index-e2e-'))
    for (const [dir, files] of Object.entries(SOURCES)) {
      for (const [rel, contents] of Object.entries(files)) write(path.join(workDir, dir), rel, contents)
      gitInit(path.join(workDir, dir))
    }
    fs.writeFileSync(path.join(workDir, 'late-unpublish.js'), LATE_UNPUBLISH)
    fs.writeFileSync(path.join(workDir, 'field-only.js'), FIELD_ONLY)
    const repoRoot = path.join(__dirname, '..', '..')
    const packageDir = path.join(workDir, 'node_modules', '@redpanda-data')
    fs.mkdirSync(packageDir, { recursive: true })
    fs.symlinkSync(repoRoot, path.join(packageDir, 'docs-extensions-and-macros'), 'dir')

    outDir = await build(workDir, ['exclude_components: [secret]'])
    raw = fs.readFileSync(path.join(outDir, 'assets', 'data', 'xref-index.json'), 'utf8')
    index = JSON.parse(raw)
  })

  afterAll(() => {
    if (workDir && !process.env.KEEP) fs.rmSync(workDir, { recursive: true, force: true })
  })

  const version = (component, v) => index.components[component].versions.find((x) => x.version === v)

  test('records the schema, site and component versions', () => {
    expect(index.schema).toBe(1)
    expect(index.site).toBe('https://docs.redpanda.com')
    expect(index.components.streaming.latest).toBe('26.2')
    expect(version('streaming', '26.3')).toMatchObject({ prerelease: true, displayVersion: '26.3 Beta' })
    expect(version('streaming', '26.2').prerelease).toBeUndefined()
  })

  test('records each published page with its title, URL and the section ids Asciidoctor produced', () => {
    const page = version('streaming', '26.2').pages['manage:security/tls.adoc']
    expect(page.title).toBe('Configure & Rotate TLS')
    expect(page.url).toBe('/streaming/current/manage/security/tls/')
    expect(page.sections).toEqual([
      { id: '_enable_tls', title: 'Enable TLS', level: 1 },
      { id: 'rotate', title: 'Rotate certificates', level: 2 },
      { id: '_from_partial', title: 'From partial', level: 1 },
    ])
  })

  test('records non-heading anchors separately', () => {
    const page = version('streaming', '26.2').pages['manage:security/tls.adoc']
    expect(page.ids).toEqual(expect.arrayContaining(['cert-table', 'inline-spot']))
    expect(page.ids).not.toContain('_enable_tls')
  })

  test('maps an alias to the resource ID of its published target', () => {
    expect(version('streaming', '26.2').aliases).toEqual({
      'manage:security/old-tls.adoc': '26.2@streaming:manage:security/tls.adoc',
    })
  })

  test('lists partials and examples with their tag regions', () => {
    const shared = version('shared', '')
    expect(shared.partials).toEqual({ 'ROOT:tls-table.adoc': ['other', 'table'] })
    expect(shared.examples).toEqual({ 'ROOT:config.yaml': ['broker'] })
    expect(Object.keys(shared.pages)).toEqual(['ROOT:glossary.adoc'])
  })

  test('an unversioned component has no version@ prefix and no defaulted displayVersion', () => {
    const shared = version('shared', '')
    expect(shared.aliases).toEqual({ 'ROOT:old-glossary.adoc': 'shared:ROOT:glossary.adoc' })
    expect(shared.displayVersion).toBeUndefined()
  })

  test('carries no build timestamp, so the same content gives the same file', () => {
    expect(Object.keys(index).sort()).toEqual(['components', 'schema', 'site'])
  })

  // Negative controls: what must NOT be in the index.
  test('a page with no anchors carries no sections or ids', () => {
    const page = version('streaming', '26.2').pages['manage:plain.adoc']
    expect(page).toEqual({ title: 'Plain Page', url: '/streaming/current/manage/plain/' })
  })

  test('leaves out a conditional section that did not render', () => {
    expect(raw).not.toContain('Cloud only')
  })

  test('leaves out a page that unpublish-pages removed, even when registered first', () => {
    expect(version('streaming', '26.2').pages['manage:hidden.adoc']).toBeUndefined()
    expect(raw).not.toContain('Hidden')
  })

  test('leaves out pages whose output is removed at beforePublish', () => {
    const pages = version('streaming', '26.2').pages
    expect(pages['manage:late.adoc']).toBeUndefined()
    expect(pages['manage:fields.adoc']).toBeUndefined()
    expect(raw).not.toContain('LateGone')
    expect(raw).not.toContain('FieldOnly')
    // Negative control: the site really did not publish them.
    expect(fs.existsSync(path.join(outDir, 'streaming', 'current', 'manage', 'late', 'index.html'))).toBe(false)
    expect(fs.existsSync(path.join(outDir, 'streaming', 'current', 'manage', 'plain', 'index.html'))).toBe(true)
  })

  test('strips section numbers from titles on a sectnums page', () => {
    expect(version('streaming', '26.2').pages['manage:numbered.adoc'].sections).toEqual([
      { id: '_first_section', title: 'First Section', level: 1 },
      { id: '_sub_section', title: 'Sub Section', level: 2 },
    ])
  })

  test('leaves out an excluded component entirely', () => {
    expect(index.components.secret).toBeUndefined()
    expect(raw).not.toContain('Secret')
  })

  test('carries no page or partial bodies', () => {
    expect(raw).not.toContain('BODY_TEXT_MUST_NOT_LEAK')
    expect(raw).not.toContain('PARTIAL_BODY_MUST_NOT_LEAK')
  })

  test('includes: false leaves partials and examples out', async () => {
    const outDir = await build(workDir, ['includes: false', 'output_path: assets/data/no-includes.json'])
    const lean = JSON.parse(fs.readFileSync(path.join(outDir, 'assets', 'data', 'no-includes.json'), 'utf8'))
    const shared = lean.components.shared.versions[0]
    expect(shared.partials).toBeUndefined()
    expect(shared.examples).toBeUndefined()
    // Without exclude_components, the secret component is present: proves the
    // exclusion above is the option at work, not an accident of the fixture.
    expect(lean.components.secret).toBeDefined()
  })
})
