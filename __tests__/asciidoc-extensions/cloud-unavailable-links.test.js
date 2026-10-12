'use strict'

const asciidoctor = require('@asciidoctor/core')()
const ext = require('../../asciidoc-extensions/cloud-unavailable-links')

// A catalog where Cloud has the interpolation page, and connect has it plus the
// streams mode guide and the resources page.
const pages = new Set([
  'cloud-data-platform:configuration:interpolation.adoc',
  'cloud-data-platform:develop:connect/components/inputs/inproc.adoc',
  'connect:configuration:interpolation.adoc',
  'connect:configuration:resources.adoc',
  'connect:guides:streams_mode/about.adoc',
  'connect:components:inputs/inproc.adoc',
])
const src = { component: 'cloud-data-platform', version: 'ROOT', module: 'develop', relative: 'connect/components/inputs/inproc.adoc' }
const contentCatalog = {
  resolvePage (spec, ctx) {
    let id = spec
    if (spec.split(':').length === 2) id = `${ctx.component}:${spec}`
    else if (!spec.includes(':')) id = `${ctx.component}:${ctx.module}:${spec}`
    return pages.has(id) ? { id } : undefined
  },
}

function convert (source, attributes = {}) {
  const registry = asciidoctor.Extensions.create()
  ext.register(registry, { file: { src }, contentCatalog })
  return asciidoctor.convert(source, { extension_registry: registry, attributes, safe: 'safe' })
}

const doc = `Uses xref:configuration:interpolation.adoc[interpolation].

Run it in xref:guides:streams_mode/about.adoc[streams mode].

* See xref:configuration:resources.adoc#reuse[resources].
* Keep this item.

* Only xref:guides:streams_mode/about.adoc[streams mode] here.

* {empty}
+
A list item whose own text is empty.

Broken everywhere: xref:configuration:nope.adoc[nope].
`

describe('cloud-unavailable-links', () => {
  test('removes paragraphs and list items that link to Connect-only pages in Cloud', () => {
    const html = convert(doc, { 'env-cloud': '' })
    expect(html).toContain('interpolation')
    expect(html).not.toContain('streams mode')
    expect(html).not.toContain('resources')
    expect(html).toContain('Keep this item.')
    // The list whose only item went is removed too, not left empty.
    expect(html.match(/<ul>/g).length).toBe(1)
    // A link that resolves nowhere stays, so Antora still reports it.
    expect(html).toContain('Broken everywhere')
  })

  test('leaves documents without env-cloud alone', () => {
    const html = convert(doc)
    expect(html).toContain('streams mode')
    expect(html).toContain('resources')
  })

  test('pageSpec and hasComponent', () => {
    expect(ext.pageSpec('configuration:resources.adoc#reuse')).toBe('configuration:resources.adoc')
    expect(ext.pageSpec('{attr}/x.adoc')).toBeNull()
    expect(ext.pageSpec('#local')).toBeNull()
    expect(ext.hasComponent('streaming:manage:x.adoc')).toBe(true)
    expect(ext.hasComponent('2.0@connect:guides:x.adoc')).toBe(true)
    expect(ext.hasComponent('guides:x.adoc')).toBe(false)
  })

  test('does not fall back for xrefs that name a component', () => {
    expect(ext.cloudOnlyMissing('connect:guides:streams_mode/about.adoc', contentCatalog, src)).toBe(false)
  })
})
