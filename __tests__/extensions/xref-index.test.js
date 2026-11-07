'use strict'

const { extractAnchors, extractTags, htmlToText } = require('../../extensions/xref-index')

describe('xref-index extractAnchors', () => {
  test('reads section headings with their level and plain-text title', () => {
    const html = [
      '<div class="sect1"><h2 id="_enable_tls"><a class="anchor" href="#_enable_tls"></a>Enable <code>tls</code> &amp; mTLS</h2>',
      '<div class="sect2"><h3 id="rotate"><a class="anchor" href="#rotate"></a>Rotate &#8217;em</h3></div></div>',
      '<h4 id="discrete" class="discrete">A discrete heading</h4>',
    ].join('\n')
    expect(extractAnchors(html).sections).toEqual([
      { id: '_enable_tls', title: 'Enable tls & mTLS', level: 1 },
      { id: 'rotate', title: 'Rotate ’em', level: 2 },
      { id: 'discrete', title: 'A discrete heading', level: 3 },
    ])
  })

  test('lists other element ids separately and skips generated tab, preamble, toc and footnote ids', () => {
    const html = [
      '<h2 id="_s"><a class="anchor" href="#_s"></a>S</h2>',
      '<table id="cert-table" class="tableblock"></table>',
      '<p><a id="inline-spot"></a>text</p>',
      '<div id="_tabs_1" class="openblock tabs"><li id="_tabs_1_linux" class="tab"></li></div>',
      '<div id="preamble"><div id="toc" class="toc"></div></div>',
      '<sup class="footnote">[<a id="_footnoteref_1" href="#_footnotedef_1">1</a>]</sup><div class="footnote" id="_footnotedef_1"></div>',
    ].join('\n')
    const { sections, ids } = extractAnchors(html)
    expect(sections.map((s) => s.id)).toEqual(['_s'])
    expect(ids).toEqual(['cert-table', 'inline-spot'])
  })

  test('skips the footnotes container, ids inside inline SVG, and tabs whose block has an explicit id', () => {
    const html = [
      '<div id="mytabs" class="openblock tabs is-loading"><li id="mytabs_linux" class="tab"></li>',
      '<div id="mytabs_linux--panel" class="tabpanel" aria-labelledby="mytabs_linux"></div></div>',
      '<svg viewBox="0 0 1 1"><g id="svg-node-1"></g></svg>',
      '<div id="footnotes"><div class="footnote" id="_footnotedef_1"></div></div>',
      '<div id="kept" class="tabular"></div>',
    ].join('\n')
    expect(extractAnchors(html).ids).toEqual(['mytabs', 'kept'])
  })

  test('strips the section number from titles on a sectnums page only', () => {
    const html = '<h2 id="_first"><a class="anchor" href="#_first"></a>1. First</h2><h3 id="_sub">1.2. Sub</h3>'
    expect(extractAnchors(html, { sectnums: true }).sections.map((s) => s.title)).toEqual(['First', 'Sub'])
    // Negative control: without sectnums a leading number is the author's text.
    expect(extractAnchors(html).sections.map((s) => s.title)).toEqual(['1. First', '1.2. Sub'])
  })

  // Negative control: a body with no ids yields nothing.
  test('a page body with no ids yields no anchors', () => {
    expect(extractAnchors('<div class="paragraph"><p>Plain text.</p></div><h2>No id</h2>')).toEqual({ sections: [], ids: [] })
  })
})

describe('xref-index extractTags', () => {
  test('returns sorted unique tag names in any comment style', () => {
    const src = '// tag::b[]\nx\n// end::b[]\n# tag::a[]\ny\n# end::a[]\n// tag::b[]\n// end::b[]\n'
    expect(extractTags(src)).toEqual(['a', 'b'])
  })

  test('a file with no tag directives yields none', () => {
    expect(extractTags('Just a partial that mentions tags in prose.\n')).toEqual([])
  })
})

describe('xref-index htmlToText', () => {
  test('leaves an unknown entity as written', () => {
    expect(htmlToText('a &bogus; b')).toBe('a &bogus; b')
  })
})
