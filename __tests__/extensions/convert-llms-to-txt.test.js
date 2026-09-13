'use strict'

const { getTopLevelNavItems } = require('../../extensions/convert-llms-to-txt')

// The llms.txt "key sections" list falls back to listing pages for components
// with no nav.adoc. For `solutions` only overview pages (page-layout: solution)
// qualify, and unpublished pages (no `out`, e.g. drafts) never appear.
describe('convert-llms-to-txt getTopLevelNavItems fallback', () => {
  const page = (component, relative, layout, { out = true } = {}) => ({
    src: { component, relative, family: 'page' },
    out: out ? { path: 'x' } : undefined,
    pub: { url: `/${component}/${relative.replace(/\.adoc$/, '')}/` },
    asciidoc: { doctitle: relative, attributes: { 'page-layout': layout } },
  })
  const catalogOf = (pages) => ({ findBy: ({ component }) => pages.filter((p) => p.src.component === component) })

  test('solutions lists published overviews only', () => {
    const pages = [
      page('solutions', 'a/index.adoc', 'solution'),
      page('solutions', 'a/step.adoc', 'solution-step'),
      page('solutions', 'draft/index.adoc', 'solution', { out: false }),
      page('solutions', 'index.adoc', 'solutions-home'),
    ]
    const items = getTopLevelNavItems(catalogOf(pages), { name: 'solutions' }, { version: '' })
    expect(items.map((i) => i.url)).toEqual(['/solutions/a/index/'])
  })

  test('other nav-less components list every published page', () => {
    const pages = [page('labs', 'b.adoc', 'lab'), page('labs', 'a.adoc', 'lab'), page('labs', 'gone.adoc', 'lab', { out: false })]
    const items = getTopLevelNavItems(catalogOf(pages), { name: 'labs' }, { version: '' })
    expect(items.map((i) => i.content)).toEqual(['a.adoc', 'b.adoc'])
  })

  test('a navigation tree wins over the fallback', () => {
    const items = getTopLevelNavItems(catalogOf([]), { name: 'docs' }, { version: '', navigation: [{ items: [{ content: 'Home', url: '/docs/' }] }] })
    expect(items).toEqual([{ content: 'Home', url: '/docs/' }])
  })
})
