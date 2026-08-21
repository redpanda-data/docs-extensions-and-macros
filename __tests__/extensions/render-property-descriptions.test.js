'use strict'

const extension = require('../../extensions/render-property-descriptions')
const glossary = require('../../macros/glossary')

// The constructs the browser's hand-written formatter never handled, alongside
// the ones it did, so a regression shows up as a missing tag rather than as
// silently leaked source.
function dataset (descriptions) {
  const properties = {}
  for (const [name, description] of Object.entries(descriptions)) {
    properties[name] = { name, config_scope: 'cluster', description }
  }
  return JSON.stringify({ properties })
}

function catalogWith (json, { pages = true, partialSource } = {}) {
  const files = [
    {
      src: { component: 'streaming', version: '26.2', module: 'reference', family: 'attachment', relative: 'redpanda-properties-v26.2.1.json', path: 'modules/reference/attachments/redpanda-properties-v26.2.1.json' },
      contents: Buffer.from(json),
    },
  ]
  if (pages) {
    files.push({
      src: { component: 'streaming', version: '26.2', module: 'reference', family: 'page', relative: 'properties/cluster-properties.adoc' },
      pub: { url: '/streaming/26.2/reference/properties/cluster-properties/', moduleRootPath: '..', rootPath: '../../../..' },
      contents: Buffer.from(partialSource || 'include::reference:partial$properties/cluster-properties.adoc[]'),
    })
  }
  if (partialSource) {
    files.push({
      src: { component: 'streaming', version: '26.2', module: 'reference', family: 'partial', relative: 'properties/cluster-properties.adoc' },
      contents: Buffer.from(partialSource),
    })
  }
  return {
    files,
    findBy: (query) => files.filter((f) => Object.entries(query).every(([k, v]) => f.src[k] === v)),
    getComponents: () => [{ name: 'streaming', versions: [{ version: '26.2' }] }],
    // Antora's loader reads component.title and component.latest.version when
    // computing page attributes, so a component without them crashes the
    // converter rather than the extension.
    getComponent: () => {
      const versions = [{ version: '26.2', displayVersion: '26.2', asciidoc: { attributes: {} } }]
      return { name: 'streaming', title: 'Redpanda', versions, latest: versions[0] }
    },
    resolveResource: () => undefined,
    getById: () => undefined,
  }
}

function run (contentCatalog, { extensions = [] } = {}) {
  const warnings = []
  const context = {
    handlers: {},
    getLogger: () => ({ info: () => {}, debug: () => {}, warn: (m) => warnings.push(m), error: () => {} }),
    once (event, handler) { this.handlers[event] = handler },
    on (event, handler) { this.handlers[event] = handler },
    getMaxListeners: () => 20,
    setMaxListeners: () => {},
  }
  extension.register.call(context)
  context.handlers.documentsConverted({
    contentCatalog,
    siteAsciiDocConfig: { attributes: { 'attribute-missing': 'drop' }, extensions },
  })
  const attachment = contentCatalog.files.find((f) => f.src.family === 'attachment')
  const raw = attachment.contents.toString()
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    data = undefined
  }
  return { data, raw, warnings }
}

describe('render-property-descriptions extension', () => {
  it('renders AsciiDoc the browser formatter never handled', () => {
    const catalog = catalogWith(dataset({
      bolded: 'Interval between runs.\n\n*Unit*: milliseconds',
      italicised: 'Toggle to `true` _only_ when forcing compaction.',
      arrowed: 'Applies when a -> b.',
    }))
    const { data } = run(catalog)
    expect(data.properties.bolded.description_html).toContain('<strong>Unit</strong>')
    expect(data.properties.italicised.description_html).toContain('<em>only</em>')
    expect(data.properties.italicised.description_html).toContain('<code>true</code>')
    // Asciidoctor's character replacement, which the browser never did.
    expect(data.properties.arrowed.description_html).toContain('&#8594;')
  })

  it('runs the repo\'s own macros rather than reimplementing them', () => {
    // glossterm's bracketed value is the definition, not display text. Rendering
    // through macros/glossary.js is what makes that impossible to get wrong.
    const catalog = catalogWith(dataset({
      admin: 'Network address for the glossterm:Admin API[] server.',
      custom: 'See glossterm:wire format[wire-format] for details.',
    }))
    const { data } = run(catalog, { extensions: [glossary] })
    expect(data.properties.admin.description_html).toContain('Admin API')
    expect(data.properties.admin.description_html).not.toContain('glossterm:')
    expect(data.properties.custom.description_html).toContain('wire format')
    expect(data.properties.custom.description_html).not.toContain('wire-format')
  })

  it('keeps the source description alongside the rendered HTML', () => {
    const catalog = catalogWith(dataset({ plain: 'A plain description.' }))
    const { data } = run(catalog)
    expect(data.properties.plain.description).toBe('A plain description.')
    expect(data.properties.plain.description_html).toBe('A plain description.')
  })

  it('points an <<anchor>> reference at the page documenting that property', () => {
    // Asciidoctor renders <<anchor>> as a same-page fragment, which is wrong in
    // a tooltip shown on some other page.
    const partial = '=== iceberg_enabled\n\nEnables Iceberg.\n\n=== other_property\n\nSomething else.\n'
    const catalog = catalogWith(
      dataset({ other_property: 'Companion to <<iceberg_enabled,`iceberg_enabled`>>.', iceberg_enabled: 'Enables Iceberg.' }),
      { partialSource: partial }
    )
    const { data } = run(catalog)
    const html = data.properties.other_property.description_html
    expect(html).not.toContain('<<')
    expect(html).toMatch(/href="[^"]*properties\/cluster-properties[^"]*#iceberg_enabled"/)
  })

  it('renders an anchor it cannot attribute to a property as plain text, and reports it', () => {
    // A same-page fragment goes nowhere in a tooltip shown on another page, and
    // a dead link still invites a click. Several real descriptions carry anchors
    // with the dots stripped (redpandastoragemode), which match nothing.
    const catalog = catalogWith(dataset({ lonely: 'See <<redpandastoragemode,the storage mode>>.' }))
    const { data, warnings } = run(catalog)
    const html = data.properties.lonely.description_html
    expect(html).toContain('the storage mode')
    expect(html).not.toContain('<a href')
    expect(html).not.toContain('&lt;&lt;')
    expect(warnings.some((w) => w.includes('redpandastoragemode'))).toBe(true)
  })

  it('falls back to the anchor name when a broken reference has no display text', () => {
    const catalog = catalogWith(dataset({ lonely: 'See <<flushbytes>> for details.' }))
    const { data } = run(catalog)
    expect(data.properties.lonely.description_html).toContain('<code>flushbytes</code>')
    expect(data.properties.lonely.description_html).not.toContain('<a href')
  })

  it('skips properties with no usable description', () => {
    const json = JSON.stringify({ properties: {
      nulled: { name: 'nulled', description: null },
      blank: { name: 'blank', description: '   ' },
      missing: { name: 'missing' },
    } })
    const { data } = run(catalogWith(json))
    for (const name of ['nulled', 'blank', 'missing']) {
      expect(data.properties[name].description_html).toBeUndefined()
    }
  })

  it('warns and leaves the attachment alone when the JSON is unusable', () => {
    const catalog = catalogWith('{"properties": {')
    const { warnings } = run(catalog)
    expect(warnings.some((w) => w.includes('not valid JSON'))).toBe(true)
    expect(catalog.files[0].contents.toString()).toBe('{"properties": {')
  })

  it('does nothing when the component has no reference page to convert as', () => {
    const catalog = catalogWith(dataset({ plain: 'A description.' }), { pages: false })
    const { data } = run(catalog)
    expect(data.properties.plain.description_html).toBeUndefined()
  })
})
