'use strict'

jest.mock('@antora/logger', () => {
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const getLogger = () => logger
  getLogger.configure = () => getLogger
  return getLogger
})

// rpk link findings: hand-written xrefs to rpk reference pages, checked as
// the scanned component renders them. The repos are built from the real rpk
// page paths and page-aliases of docs 19384b39, cloud-docs 089d5cf and
// adp-docs f7d7daf (rpk-pages-sample.json), and each prose line is quoted
// from those repos at those commits.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { scanAll, failsAt } = require('../../../tools/reference-values')

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures', 'rpkval')
// --data-file takes the kind from the file name.
const RPK = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-links-data-')), 'rpk-v26.2.2.json')
fs.copyFileSync(path.join(FIXTURES, 'rpk-v26.2.2-sample.json'), RPK)
const PAGES = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'rpk-pages-sample.json'), 'utf8'))
const ATTRIBUTES = { 'cloud-data-platform': { 'env-cloud': true }, 'agentic-data-plane': { 'env-adp': true } }

const temps = [path.dirname(RPK)]
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
})
const put = (dir, file, content) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), content)
}

// One checkout of a component: its real rpk page paths, with the
// page-aliases they declare, and the given prose files.
function checkout (name, files = {}, { nav } = {}) {
  const c = PAGES.components.find((x) => x.name === name)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-links-'))
  temps.push(dir)
  const attrs = Object.entries(ATTRIBUTES[name] || {}).map(([k, v]) => `    ${k}: ${v}`).join('\n')
  put(dir, 'antora.yml', `name: ${name}\nversion: ${c.version ? `'${c.version}'` : '~'}\n${nav ? `nav:\n${nav.map((n) => `- ${n}`).join('\n')}\n` : ''}${attrs ? `asciidoc:\n  attributes:\n${attrs}\n` : ''}`)
  for (const relative of c.pages) {
    const aliases = c.aliases[relative]
    put(dir, `modules/reference/pages/${relative}`, `= ${relative}\n${aliases ? `:page-aliases: ${aliases.join(', ')}\n` : ''}\nGenerated.\n`)
  }
  for (const [file, content] of Object.entries(files)) put(dir, file, content)
  return dir
}

const page = (...lines) => ['= Page', '', ...lines, ''].join('\n')

// Scan one component, with the other two as lenders unless told otherwise.
function scan (name, files, { lenders = ['streaming', 'cloud-data-platform', 'agentic-data-plane'].filter((n) => n !== name), nav, write = false, failOn = 'mismatch' } = {}) {
  const docsDir = checkout(name, files, { nav })
  const lenderDirs = lenders.map((n) => checkout(n))
  const result = scanAll({ docsDir, lenderDirs, dataFiles: [RPK], kinds: ['rpk'], kindsExplicit: true, write, failOn })
  return { result, docsDir, links: result.kinds.rpk.findings.filter((f) => f.check === 'link') }
}

describe('broken links', () => {
  test('docs shadowing/setup.adoc:350: rpk security secret has no streaming page, and rpkcmd: would link Cloud\'s', () => {
    const line = 'For details, see xref:reference:rpk/rpk-security/rpk-security-secret-create.adoc[`rpk security secret create`].'
    const data = JSON.parse(fs.readFileSync(RPK, 'utf8'))
    data.tree.commands.find((c) => c.name === 'security').commands.push({ name: 'secret', commands: [{ name: 'create', usage: 'rpk security secret create [flags]', flags: [] }] })
    const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-links-data-')), 'rpk-v26.2.2.json')
    temps.push(path.dirname(dataFile))
    fs.writeFileSync(dataFile, JSON.stringify(data))
    const docsDir = checkout('streaming', { 'modules/manage/pages/setup.adoc': page(line) })
    const cloud = checkout('cloud-data-platform', { 'modules/reference/pages/rpk/rpk-security/rpk-security-secret-create.adoc': '= rpk security secret create\n\nCloud only.\n' })
    const result = scanAll({ docsDir, lenderDirs: [cloud], dataFiles: [dataFile], kinds: ['rpk'], kindsExplicit: true })
    const [f] = result.kinds.rpk.findings.filter((x) => x.check === 'link')
    expect(f).toMatchObject({ status: 'reference', reason: 'broken-link', severity: 'error', command: 'rpk security secret create', line: 3, failing: true })
    expect(f.note).toBe('streaming@26.2 has no page reference:rpk/rpk-security/rpk-security-secret-create.adoc; rpkcmd:[rpk security secret create] links cloud-data-platform:reference:rpk/rpk-security/rpk-security-secret-create.adoc')
    expect(result.kinds.rpk.counts).toMatchObject({ linksBroken: 1, linksMislabeled: 0, linksReplaceable: 0 })
  })

  test('docs shadowing/setup.adoc:350 sits in ifdef::env-cloud[], so it is checked as the Cloud lender renders it, and is not broken', () => {
    const line = 'Use xref:reference:rpk/rpk-security/rpk-security-secret-create.adoc[`rpk security secret create`] to create the secret from the command line.'
    const data = JSON.parse(fs.readFileSync(RPK, 'utf8'))
    data.tree.commands.find((c) => c.name === 'security').commands.push({ name: 'secret', commands: [{ name: 'create', usage: 'rpk security secret create [flags]', flags: [] }] })
    const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-links-data-')), 'rpk-v26.2.2.json')
    temps.push(path.dirname(dataFile))
    fs.writeFileSync(dataFile, JSON.stringify(data))
    const files = { 'modules/manage/pages/setup.adoc': page('ifdef::env-cloud[]', line, 'endif::[]') }
    const cloud = checkout('cloud-data-platform', { 'modules/reference/pages/rpk/rpk-security/rpk-security-secret-create.adoc': '= rpk security secret create\n\nCloud only.\n' })
    const withCloud = scanAll({ docsDir: checkout('streaming', files), lenderDirs: [cloud], dataFiles: [dataFile], kinds: ['rpk'], kindsExplicit: true })
    expect(withCloud.kinds.rpk.findings.filter((f) => f.check === 'link')).toEqual([expect.objectContaining({ status: 'exact', autoSafe: true, proposed: 'rpkcmd:[rpk security secret create]', dataValue: 'cloud-data-platform:reference:rpk/rpk-security/rpk-security-secret-create.adoc' })])
    // With no Cloud lender, the line is not checked at all.
    const without = scanAll({ docsDir: checkout('streaming', files), lenderDirs: [], dataFiles: [dataFile], kinds: ['rpk'], kindsExplicit: true })
    expect(without.kinds.rpk.findings.filter((f) => f.check === 'link')).toEqual([])
  })

  test('a Cloud page linking a page Cloud does not have is broken, and the note says rpkcmd: renders plain code there', () => {
    // docs move-cancel line, as a cloud-docs page would hold it.
    const { links } = scan('cloud-data-platform', { 'modules/manage/pages/balance.adoc': page('Use xref:reference:rpk/rpk-cluster/rpk-cluster-partitions-move-cancel.adoc[`rpk cluster partitions move-cancel`] to cancel a move.') })
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ reason: 'broken-link', severity: 'error' })
    expect(links[0].note).toContain('cloud-data-platform is Cloud and has no page for rpk cluster partitions move-cancel, so rpkcmd:[rpk cluster partitions move-cancel] renders it as plain code')
  })

  test('a path that names no command and no page is broken', () => {
    const { links } = scan('streaming', { 'modules/manage/pages/x.adoc': page('See xref:reference:rpk/rpk-acl/rpk-acl-frobnicate.adoc[`rpk security acl frobnicate`].') })
    expect(links[0]).toMatchObject({ reason: 'broken-link' })
    expect(links[0].note).toBe('streaming@26.2 has no page reference:rpk/rpk-acl/rpk-acl-frobnicate.adoc, and the path names no command in rpk v26.2.2')
  })

  test('docs manage/partials/authentication.adoc:630: a page alias resolves, as Antora resolves it', () => {
    const { links } = scan('streaming', { 'modules/manage/partials/authentication.adoc': page('For information about ACLs, see xref:reference:rpk/rpk-acl/rpk-acl.adoc[rpk security acl].') })
    expect(links.filter((f) => f.reason === 'broken-link')).toEqual([])
  })

  test('docs acl.adoc:442: an exact label through a page alias is replaceable, with a note', () => {
    const { links } = scan('streaming', { 'modules/manage/pages/acl.adoc': page('For the full list of options, see xref:reference:rpk/rpk-acl.adoc[`rpk security acl`].') })
    expect(links[0]).toMatchObject({ status: 'exact', autoSafe: true, proposed: 'rpkcmd:[rpk security acl]', dataValue: '26.2@streaming:reference:rpk/rpk-security/rpk-security-acl.adoc', note: 'links through the page alias reference:rpk/rpk-acl.adoc' })
  })

  test('a link to a component the scan did not read is unverifiable, never broken', () => {
    const { links, result } = scan('streaming', { 'modules/manage/pages/x.adoc': page('See xref:cloud-data-platform:reference:rpk/rpk-cloud/rpk-cloud.adoc[`rpk cloud`].') }, { lenders: [] })
    expect(links[0]).toMatchObject({ status: 'unverifiable', reason: 'link-target-not-loaded', failing: false })
    expect(links[0].note).toBe('cloud-data-platform is not in this scan; pass its checkout with --lender to check the link')
    expect(result.kinds.rpk.counts.linksNotLoaded).toBe(1)
  })

  test('with the lender, a link to another component\'s page is checked there', () => {
    const { links } = scan('streaming', { 'modules/manage/pages/x.adoc': page('See xref:cloud-data-platform:reference:rpk/rpk-cloud/rpk-cloud.adoc[`rpk cloud`].') })
    expect(links[0]).toMatchObject({ status: 'exact', proposed: 'rpkcmd:[rpk cloud]', dataValue: 'cloud-data-platform:reference:rpk/rpk-cloud/rpk-cloud.adoc' })
  })
})

describe('labels', () => {
  test.each([
    ['docs admin-addresses.adoc:16', 'xref:reference:rpk/rpk-cluster/rpk-cluster-partitions.adoc[`rpk cluster partitions move-cancel <node_id>`]', 'the label names rpk cluster partitions move-cancel, but the link goes to the page for rpk cluster partitions'],
    ['docs authentication.adoc:1463', 'xref:reference:rpk/rpk-topic/rpk-topic-create.adoc[`rpk topic`]', 'the label names rpk topic, but the link goes to the page for rpk topic create'],
    ['docs deprecated/index.adoc:255', 'xref:reference:rpk/rpk-generate/rpk-generate-grafana-dashboard.adoc[`rpk generate grafana dashboard`]', 'the label names rpk generate, but the link goes to the page for rpk generate grafana-dashboard'],
  ])('%s shape: a label naming another command is a warning', (_where, xref, note) => {
    const { links } = scan('streaming', { 'modules/get-started/pages/x.adoc': page(`Run ${xref} to continue.`) })
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ status: 'reference', reason: 'link-label-mismatch', severity: 'warning', failing: false, note })
  })

  test('an alias in the label names the same command', () => {
    const { links } = scan('streaming', { 'modules/x/pages/x.adoc': page('Run xref:reference:rpk/rpk-cluster/rpk-cluster-info.adoc[`rpk cluster status`].') })
    expect(links[0]).toMatchObject({ status: 'exact', proposed: 'rpkcmd:[rpk cluster status]' })
  })

  test('cloud-docs cloud-authentication.adoc:796 and adp-docs cli/index.adoc:14: a label of just rpk names the tool, not a command', () => {
    const { links } = scan('agentic-data-plane', { 'modules/cli/pages/index.adoc': page('Agentic Data Plane commands are a plugin for xref:reference:rpk/rpk-ai/rpk-ai.adoc[`rpk`], the Redpanda command-line tool.') })
    expect(links).toEqual([])
  })

  test('a label that is not a command (an empty label, prose) gets no finding', () => {
    const { links } = scan('streaming', { 'modules/x/pages/x.adoc': page('See xref:reference:rpk/rpk-topic/rpk-topic-create.adoc[] and xref:reference:rpk/rpk-topic/rpk-topic-create.adoc[create a topic].') })
    expect(links).toEqual([])
  })
})

describe('replaceable links', () => {
  test('adp-docs cli/pages/index.adoc:34: two exact links on one line are both replaced by --write', () => {
    const line = 'Update the plugin later with xref:reference:rpk/rpk-ai/rpk-ai-auditlog.adoc[`rpk ai auditlog`], and remove it with xref:reference:rpk/rpk-ai/rpk-ai-docs.adoc[`rpk ai docs`].'
    const { links, docsDir } = scan('agentic-data-plane', { 'modules/cli/pages/index.adoc': page(line) }, { write: true })
    expect(links.map((f) => [f.status, f.autoSafe, f.applied, f.proposed, f.dataValue])).toEqual([
      ['exact', true, true, 'rpkcmd:[rpk ai auditlog]', 'agentic-data-plane:reference:rpk/rpk-ai/rpk-ai-auditlog.adoc'],
      ['exact', true, true, 'rpkcmd:[rpk ai docs]', 'agentic-data-plane:reference:rpk/rpk-ai/rpk-ai-docs.adoc'],
    ])
    expect(fs.readFileSync(path.join(docsDir, 'modules/cli/pages/index.adoc'), 'utf8')).toContain('Update the plugin later with rpkcmd:[rpk ai auditlog], and remove it with rpkcmd:[rpk ai docs].')
  })

  test('an ADP link to a page ADP lacks but streaming has is broken there, and rpkcmd: would link streaming', () => {
    const { links } = scan('agentic-data-plane', { 'modules/x/pages/x.adoc': page('Create one with xref:reference:rpk/rpk-topic/rpk-topic-create.adoc[`rpk topic create`].') })
    expect(links[0]).toMatchObject({ reason: 'broken-link' })
    expect(links[0].note).toContain('rpkcmd:[rpk topic create] links 26.2@streaming:reference:rpk/rpk-topic/rpk-topic-create.adoc')
  })

  test('a label with a flag is replaceable, and the replacement keeps the flag', () => {
    const { links } = scan('streaming', { 'modules/x/pages/x.adoc': page('Pass xref:reference:rpk/rpk-topic/rpk-topic-create.adoc[`rpk topic create -p`].') })
    expect(links[0]).toMatchObject({ status: 'exact', autoSafe: true, proposed: 'rpkcmd:[rpk topic create -p]', flag: 'partitions' })
  })

  test.each([
    ['a fragment', 'xref:reference:rpk/rpk-topic/rpk-topic-create.adoc#examples[`rpk topic create`]'],
    ['text around the command', 'xref:reference:rpk/rpk-topic/rpk-topic-create.adoc[`rpk topic create` command]'],
    ['an argument in the label', 'xref:reference:rpk/rpk-topic/rpk-topic-create.adoc[`rpk topic create orders`]'],
    ['an unknown flag in the label', 'xref:reference:rpk/rpk-topic/rpk-topic-create.adoc[`rpk topic create --partition`]'],
    ['a pinned version', 'xref:26.2@streaming:reference:rpk/rpk-topic/rpk-topic-consume.adoc[`rpk topic consume`]'],
  ])('%s is not replaceable', (_what, xref) => {
    const { links } = scan('streaming', { 'modules/x/pages/x.adoc': page(`Run ${xref}.`) })
    expect(links.filter((f) => f.status === 'exact')).toEqual([])
  })

  test('a link rpkcmd: would send elsewhere is not replaceable: an explicit streaming link from Cloud', () => {
    const { links } = scan('cloud-data-platform', { 'modules/x/pages/x.adoc': page('Run xref:streaming:reference:rpk/rpk-topic/rpk-topic-consume.adoc[`rpk topic consume`].') })
    expect(links).toEqual([])
  })

  test('release notes are proposed only, and never fail', () => {
    const { links } = scan('streaming', { 'modules/get-started/pages/release-notes/redpanda.adoc': page('New: xref:reference:rpk/rpk-topic/rpk-topic-create.adoc[`rpk topic create`] and xref:reference:rpk/rpk-topic/rpk-topic-frob.adoc[`rpk topic frob`].') }, { failOn: 'any' })
    expect(links.map((f) => [f.status, f.autoSafe, f.failing, f.note])).toEqual([
      ['exact', false, false, 'release or upgrade notes: proposed only'],
      ['reference', false, false, 'streaming@26.2 has no page reference:rpk/rpk-topic/rpk-topic-frob.adoc, and the path names no command in rpk v26.2.2'],
    ])
  })
})

describe('what the link check skips and how findings fail', () => {
  test('nav files, generated rpk pages, stub pages and xrefs shown as code are not checked', () => {
    const broken = 'xref:reference:rpk/rpk-topic/rpk-topic-frob.adoc[`rpk topic frob`]'
    const { links } = scan('streaming', {
      'modules/ROOT/nav.adoc': `* ${broken}\n`,
      'modules/reference/pages/rpk/rpk-topic/rpk-topic-frob-notes.adoc': page(`See ${broken}.`),
      'modules/manage/pages/stub.adoc': '= Stub\n\ninclude::streaming:manage:page$x.adoc[]\n',
      'modules/manage/pages/code.adoc': page('Write `+xref:reference:rpk/rpk-topic/rpk-topic-frob.adoc[rpk topic frob]+` in your page.'),
    }, { nav: ['modules/ROOT/nav.adoc'] })
    expect(links).toEqual([])
  })

  test('// value-check: ignore drops the finding and --write leaves the line', () => {
    const line = 'Run xref:reference:rpk/rpk-topic/rpk-topic-create.adoc[`rpk topic create`].'
    const { links, result, docsDir } = scan('streaming', { 'modules/x/pages/x.adoc': page('// value-check: ignore', line) }, { write: true })
    expect(links).toEqual([])
    expect(result.ignored).toBe(1)
    expect(fs.readFileSync(path.join(docsDir, 'modules/x/pages/x.adoc'), 'utf8')).toContain(line)
  })

  test('fail-on levels: broken fails at mismatch, a mislabel and a replaceable link only at any', () => {
    const broken = { status: 'reference', reason: 'broken-link', severity: 'error', file: 'modules/x/pages/x.adoc' }
    const mislabel = { status: 'reference', reason: 'link-label-mismatch', severity: 'warning', file: 'modules/x/pages/x.adoc' }
    const replaceable = { status: 'exact', check: 'link', autoSafe: true, file: 'modules/x/pages/x.adoc' }
    expect([broken, mislabel, replaceable].map((f) => ['none', 'mismatch', 'any'].map((level) => failsAt('rpk', f, level)))).toEqual([
      [false, true, true],
      [false, false, true],
      [false, false, true],
    ])
  })

  test('the Markdown report counts the links', () => {
    const { renderMarkdown } = require('../../../tools/reference-values')
    const { result } = scan('streaming', { 'modules/x/pages/x.adoc': page('Run xref:reference:rpk/rpk-topic/rpk-topic-create.adoc[`rpk topic create`].') })
    expect(renderMarkdown(result)).toContain('Links to rpk reference pages: 0 broken, 0 with a label naming another command, 1 replaceable with rpkcmd:[...] (listed under Exact), 0 to a component this scan did not read.')
  })
})

describe('rpkcmd: and the bracket form of rpkval: in the value scan', () => {
  test('a value written as rpkval:[...] is the macro, not a hand-written value, in either form', () => {
    const { result } = scan('streaming', { 'modules/x/pages/x.adoc': page('The `--partitions` flag of `rpk topic create` defaults to rpkval:[rpk topic create --partitions].', '', 'The `--partitions` flag of `rpk topic create` defaults to rpkval:partitions[command=rpk topic create].') })
    expect(result.kinds.rpk.findings).toEqual([])
  })

  test('rpkcmd:[...] with a flag is a flag mention with its command', () => {
    const { result } = scan('streaming', { 'modules/x/pages/x.adoc': page('The rpkcmd:[rpk topic create --partitions] flag defaults to 3.') })
    expect(result.kinds.rpk.findings).toEqual([expect.objectContaining({ status: 'mismatch', command: 'rpk topic create', flag: 'partitions', written: '3', dataValue: '-1', commandFrom: 'macro' })])
  })

  test('rpkcmd:[...] names the command a later flag mention belongs to', () => {
    const { result } = scan('streaming', { 'modules/x/pages/x.adoc': page('== Create', '', 'Run rpkcmd:[rpk topic create].', '', 'The `--partitions` flag defaults to -1.') })
    expect(result.kinds.rpk.findings).toEqual([expect.objectContaining({ status: 'exact', command: 'rpk topic create', commandFrom: 'section' })])
  })

  test('rpkval:[...] with a flag is a flag mention with its command', () => {
    const { result } = scan('streaming', { 'modules/x/pages/x.adoc': page('The rpkval:[rpk topic create --partitions,shorthand] flag defaults to 3.') })
    expect(result.kinds.rpk.findings).toEqual([expect.objectContaining({ status: 'mismatch', command: 'rpk topic create', flag: 'partitions' })])
  })
})
