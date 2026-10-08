'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { checkHtml, checkRenderedHtml, createLinkResolver, formatMarkdown, readChangedPages } = require('../../../tools/connect-docs/check-rendered-html')

const BIN = path.join(__dirname, '..', '..', '..', 'bin', 'doc-tools.js')

// The page skeleton Antora and docs-ui write: navigation outside the
// article, content inside article.doc, sections as div.sectN.
const page = (body, chrome = '') => `<!DOCTYPE html><html><body>
<nav class="nav">${chrome}</nav>
<article class="doc">
<h1 class="page">Page</h1>
${body}
</article>
<footer>${chrome}</footer>
</body></html>`

const sect1 = (id, title, inner) => `<div class="sect1"><h2 id="${id}"><a class="anchor" href="#${id}"></a>${title}</h2>
<div class="sectionbody">${inner}</div></div>`

const findings = (html) => checkHtml(html).findings

describe('check-rendered-html: checkHtml', () => {
  test('a clean page has no findings', () => {
    const html = page(sect1('fields', 'Fields', '<div class="paragraph"><p>Set <code>addresses</code> to a list.</p></div>'))
    expect(findings(html)).toEqual({})
  })

  test('a literal backtick in prose is reported, with context', () => {
    // Real defect: an empty enum option rendered as two backticks.
    const html = page(sect1('level', 'level', '<p><strong>Options</strong>: <code>TRACE</code>, <code>DEBUG</code>, ``</p>'))
    const f = findings(html)
    expect(f['literal-backtick'].count).toBe(2)
    expect(f['literal-backtick'].samples[0]).toMatch(/``/)
  })

  test('a glued backtick that turned inline code off is reported', () => {
    const html = page('<p>the `user_nkey_seed`can contain the plain text seed</p>')
    expect(findings(html)['literal-backtick'].count).toBe(2)
  })

  test('backticks and markup inside code are not reported', () => {
    const html = page('<div class="listingblock"><pre class="highlight"><code>root = this.`field`\ninclude::partial$x.adoc[]\nxref:a.adoc[] |=== {page-foo}</code></pre></div><p>Use <code>`quoted`</code> keys and <kbd>`</kbd>.</p>')
    expect(findings(html)).toEqual({})
  })

  test('navigation and footer chrome outside article.doc are ignored', () => {
    const html = page('<p>clean</p>', 'stray ` backtick and xref:nav.adoc[]')
    expect(findings(html)).toEqual({})
  })

  test('literal xref:, include::, leftover attributes and table markup are reported', () => {
    const html = page([
      '<p>See xref:guides:bloblang/about.adoc[Bloblang].</p>',
      '<p>include::components:partial$fields/inputs/kafka.adoc[]</p>',
      '<p>Available in {page-component-title} and {env-cloud}. Not {product-name}.</p>',
      '<p>|===</p>'
    ].join('\n'))
    const f = findings(html)
    expect(f['literal-xref'].count).toBe(1)
    expect(f['literal-include'].count).toBe(1)
    expect(f['leftover-attribute'].count).toBe(2)
    expect(f['table-markup'].count).toBe(1)
  })

  test('Unresolved include directive text is reported even inside a code block, once', () => {
    const html = page([
      '<div class="paragraph"><p>Unresolved include directive in modules/components/pages/inputs/kafka.adoc - include::connect:components:partial$fields/inputs/kafka.adoc[]</p></div>',
      '<div class="listingblock"><pre>Unresolved include directive in x.adoc - include::y.adoc[]</pre></div>'
    ].join('\n'))
    const f = findings(html)
    expect(f['unresolved-include'].count).toBe(2)
    // The include:: inside the unresolved message is not counted twice.
    expect(f['literal-include']).toBeUndefined()
  })

  test('a link with the unresolved class is reported', () => {
    const html = page('<p><a href="#guides:missing.adoc" class="xref unresolved">guides:missing.adoc</a></p>')
    expect(findings(html)['unresolved-xref'].count).toBe(1)
  })

  test('an empty section is reported; a section holding only subsections is not', () => {
    const html = page([
      sect1('empty', 'Empty section', ''),
      sect1('parent', 'Parent', '<div class="sect2"><h3 id="child">Child</h3><div class="paragraph"><p>content</p></div></div>'),
      sect1('lastsub', 'Has an empty subsection', '<div class="paragraph"><p>intro</p></div><div class="sect2"><h3 id="emptysub">Empty sub</h3></div>')
    ].join('\n'))
    const f = findings(html)
    expect(f['empty-section'].count).toBe(2)
    expect(f['empty-section'].samples).toEqual(['Empty section', 'Empty sub'])
  })
})

describe('check-rendered-html: site scan and CLI', () => {
  let site
  beforeAll(() => {
    site = fs.mkdtempSync(path.join(os.tmpdir(), 'crh-site-'))
    const write = (rel, html) => {
      fs.mkdirSync(path.dirname(path.join(site, rel)), { recursive: true })
      fs.writeFileSync(path.join(site, rel), html)
    }
    write('connect/components/processors/http/index.html', page('<p>Options: <code>A</code>, ``</p>'))
    write('connect/components/inputs/kafka/index.html', page('<p>clean</p>'))
    // Another component's defects are out of scope.
    write('streaming/current/index.html', page('<p>stray `</p>'))
  })

  test('scans only the chosen component and reports per page with counts', () => {
    const result = checkRenderedHtml({ siteDir: site, component: 'connect' })
    expect(result.scanned).toBe(2)
    expect(result.total).toBe(2)
    expect(result.pages).toEqual([
      expect.objectContaining({ page: 'connect/components/processors/http/index.html', findings: { 'literal-backtick': expect.objectContaining({ count: 2 }) } })
    ])
    const md = formatMarkdown(result)
    expect(md).toMatch(/2 findings \(warning only\)/)
    expect(md).toMatch(/connect\/components\/processors\/http\/index\.html \| literal-backtick: 2/)
  })

  test('--pages limits the scan', () => {
    const result = checkRenderedHtml({ siteDir: site, component: 'connect', pages: ['connect/components/inputs/kafka/index.html'] })
    expect(result.scanned).toBe(1)
    expect(result.total).toBe(0)
  })

  const run = (args) => spawnSync('node', [BIN, 'check-rendered-html', ...args], { encoding: 'utf8' })

  test('exits 0 with findings by default (warn only)', () => {
    const r = run([site])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/literal-backtick: 2/)
  })

  test('exits 1 with findings under --strict', () => {
    expect(run([site, '--strict']).status).toBe(1)
  })

  test('exits 0 under --strict when the scanned pages are clean', () => {
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'crh-clean-'))
    fs.mkdirSync(path.join(clean, 'connect'))
    fs.writeFileSync(path.join(clean, 'connect', 'index.html'), page('<p>clean</p>'))
    expect(run([clean, '--strict']).status).toBe(0)
  })

  test('exits 2 when the component directory is missing', () => {
    const r = run([site, '--component', 'nope'])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/component directory not found/)
  })
})

describe('check-rendered-html: anchors and links', () => {
  test('a same-page fragment with no matching id is a broken-anchor', () => {
    // Real defect: azure_blob_storage linked #targetsinput; the field id is targets_input.
    const html = page(sect1('fields', 'Fields', '<p>See <a href="#targetsinput">targets_input</a>.</p><div class="sect2"><h3 id="targets_input">targets_input</h3><p>x</p></div>'))
    const f = findings(html)
    expect(f['broken-anchor'].count).toBe(1)
    expect(f['broken-anchor'].samples).toEqual(['targets_input -> #targetsinput'])
  })

  test('negative control: fragments matching an id or a[name], percent-encoded, empty, or external are fine', () => {
    const html = page([
      sect1('fields', 'Fields', '<p><a href="#fields">up</a> <a href="#legacy">old</a> <a name="legacy"></a></p>'),
      '<p id="a b"><a href="#a%20b">encoded</a> <a href="#">top</a> <a href="https://example.com/#nope">ext</a> <a href="mailto:x@y.z#nope">mail</a></p>'
    ].join('\n'))
    expect(findings(html)).toEqual({})
  })

  test('an unresolved xref is not counted again as a broken anchor', () => {
    const f = findings(page('<p><a href="#guides:missing.adoc" class="xref unresolved">x</a></p>'))
    expect(f['unresolved-xref'].count).toBe(1)
    expect(f['broken-anchor']).toBeUndefined()
  })

  test('links in the navigation outside article.doc are not checked', () => {
    expect(findings(page('<p>clean</p>', '<a href="#nowhere">nav</a>'))).toEqual({})
  })

  describe('cross-page links against a built site', () => {
    let site
    const write = (rel, html) => {
      fs.mkdirSync(path.dirname(path.join(site, rel)), { recursive: true })
      fs.writeFileSync(path.join(site, rel), html)
    }
    beforeAll(() => {
      site = fs.mkdtempSync(path.join(os.tmpdir(), 'crh-links-'))
      write('connect/components/inputs/kafka/index.html', page(sect1('tls', 'tls', '<p>x</p>') + '<p id="tls-enabled">e</p>'))
      write('connect/components/outputs/kafka/index.html', page([
        '<p><a href="../../inputs/kafka/#tls">ok relative</a>',
        '<a href="/connect/components/inputs/kafka/#tls-enabled">ok root-relative</a>',
        '<a href="../../inputs/kafka/">ok no fragment</a>',
        '<a href="../../inputs/kafka/index.html#tls">ok explicit file</a>',
        '<a href="./#here">ok self</a><span id="here"></span>',
        '<a href="../../../_attachments/x.yaml">ok attachment</a>',
        '<a href="../../inputs/kafka/#tlsenabled">bad fragment</a>',
        '<a href="/connect/components/inputs/nope/">bad page</a>',
        '<a href="/cloud-data-platform/develop/connect/components/inputs/kafka/#tls">cloud ok</a>',
        '<a href="/cloud-data-platform/develop/connect/components/inputs/gone/">cloud bad</a>',
        '<a href="../../../../streaming/current/">trimmed out</a>',
        '<a href="/cloud-data-platform/">outside root</a>',
        '<a href="https://docs.redpanda.com/connect/nope/">external</a></p>'
      ].join('\n')))
      write('connect/_attachments/x.yaml', 'a: 1\n')
      write('cloud-data-platform/develop/connect/components/inputs/kafka/index.html', page('<p id="tls">x</p>'))
    })

    test('resolves relative and root-relative links and their fragments', () => {
      const result = checkRenderedHtml({ siteDir: site, component: 'connect' })
      const p = result.pages.find((x) => x.page === 'connect/components/outputs/kafka/index.html')
      expect(p.findings['broken-anchor']).toEqual({ count: 1, samples: ['bad fragment -> ../../inputs/kafka/#tlsenabled'] })
      expect(p.findings['broken-link']).toEqual({ count: 2, samples: ['bad page -> /connect/components/inputs/nope/', 'cloud bad -> /cloud-data-platform/develop/connect/components/inputs/gone/'] })
      expect(result.pages).toHaveLength(1)
      expect(result.links).toEqual({ internal: 11, external: 1, unchecked: 2 })
      expect(result.totals['broken-anchor']).toBe(1)
      expect(result.totals['broken-link']).toBe(2)
    })

    test('a link root missing from the build is unchecked, not a finding', () => {
      const trimmed = fs.mkdtempSync(path.join(os.tmpdir(), 'crh-trim-'))
      fs.mkdirSync(path.join(trimmed, 'connect'))
      fs.writeFileSync(path.join(trimmed, 'connect', 'index.html'), page('<p><a href="/cloud-data-platform/develop/connect/x/#y">cloud</a> <a href="/connect/missing/">bad</a></p>'))
      const result = checkRenderedHtml({ siteDir: trimmed, component: 'connect' })
      expect(result.linkRoots).toEqual(['connect'])
      expect(result.links).toEqual({ internal: 1, external: 0, unchecked: 1 })
      expect(result.totals['broken-link']).toBe(1)
    })

    test('target pages are parsed once', () => {
      const resolver = createLinkResolver({ siteDir: site })
      const spy = jest.spyOn(fs, 'readFileSync')
      resolver.check('connect/index.html', '/connect/components/inputs/kafka/#tls')
      resolver.check('connect/index.html', '/connect/components/inputs/kafka/#nope')
      const reads = spy.mock.calls.filter(([f]) => String(f).endsWith(path.join('inputs', 'kafka', 'index.html'))).length
      spy.mockRestore()
      expect(reads).toBe(1)
    })

    test('--component takes several paths, including the Cloud connect pages', () => {
      const result = checkRenderedHtml({ siteDir: site, component: ['connect', 'cloud-data-platform/develop/connect'] })
      expect(result.scanned).toBe(3)
      const r = spawnSync('node', [BIN, 'check-rendered-html', site, '--component', 'connect', '--component', 'cloud-data-platform/develop/connect', '--format', 'json'], { encoding: 'utf8' })
      expect(r.status).toBe(0)
      expect(JSON.parse(r.stdout).scanned).toBe(3)
      const comma = spawnSync('node', [BIN, 'check-rendered-html', site, '--component', 'connect,cloud-data-platform/develop/connect', '--format', 'json'], { encoding: 'utf8' })
      expect(JSON.parse(comma.stdout).scanned).toBe(3)
    })
  })
})

describe('check-rendered-html: changed pages', () => {
  let site
  let dir
  const bad = 'connect/components/inputs/bad/index.html'
  const good = 'connect/components/inputs/good/index.html'
  beforeAll(() => {
    site = fs.mkdtempSync(path.join(os.tmpdir(), 'crh-changed-'))
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crh-lists-'))
    for (const [rel, html] of [[bad, page('<p><a href="#nope">x</a></p>')], [good, page('<p>clean</p>')]]) {
      fs.mkdirSync(path.dirname(path.join(site, rel)), { recursive: true })
      fs.writeFileSync(path.join(site, rel), html)
    }
  })
  const list = (name, text) => {
    fs.writeFileSync(path.join(dir, name), text)
    return path.join(dir, name)
  }
  const run = (args) => spawnSync('node', [BIN, 'check-rendered-html', site, ...args], { encoding: 'utf8' })

  test('splits findings into changed and other pages, and lists changed pages not in the scan', () => {
    const result = checkRenderedHtml({ siteDir: site, changedPages: [good, 'connect/components/inputs/removed/index.html'] })
    expect(result.total).toBe(1)
    expect(result.changed).toEqual(expect.objectContaining({ listed: 2, scanned: 1, total: 0, pages: [], missing: ['connect/components/inputs/removed/index.html'] }))
    expect(result.other).toEqual(expect.objectContaining({ scanned: 1, total: 1 }))
    expect(result.other.pages.map((p) => p.page)).toEqual([bad])
    const md = formatMarkdown(result, { strict: true })
    expect(md).toMatch(/Rendered HTML checks: clean/)
    expect(md).toMatch(/### Findings on changed pages\n\nNone\./)
    expect(md).toMatch(/Findings on other pages \(1\)/)
  })

  test('--strict exits 0 when only unchanged pages have findings', () => {
    expect(run(['--changed-pages', list('good.txt', `${good}\n`), '--strict']).status).toBe(0)
  })

  test('--strict exits 1 when a changed page has findings', () => {
    const r = run(['--changed-pages', list('bad.txt', `./${bad}\n\n`), '--strict', '--format', 'json'])
    expect(r.status).toBe(1)
    expect(JSON.parse(r.stdout).changed.pages.map((p) => p.page)).toEqual([bad])
  })

  test('without --strict, changed-page findings still exit 0', () => {
    expect(run(['--changed-pages', list('bad2.txt', `${bad}\n`)]).status).toBe(0)
  })

  test('accepts connect-docs-diff --format json output', () => {
    const file = list('diff.json', JSON.stringify({ summary: {}, pages: [{ url: 'https://docs.redpanda.com/connect/components/inputs/bad/', sitePath: bad, anchors: [], files: [] }] }))
    expect(readChangedPages(file)).toEqual([bad])
    expect(run(['--changed-pages', file, '--strict']).status).toBe(1)
  })

  test('without --changed-pages the result has no changed/other split', () => {
    const result = checkRenderedHtml({ siteDir: site })
    expect(result.changed).toBeUndefined()
    expect(result.other).toBeUndefined()
  })
})
