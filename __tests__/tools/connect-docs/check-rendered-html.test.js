'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { checkHtml, checkRenderedHtml, formatMarkdown } = require('../../../tools/connect-docs/check-rendered-html')

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
