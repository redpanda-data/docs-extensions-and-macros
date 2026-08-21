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
    // A resolver that actually resolves. With `() => undefined` Antora emits its
    // unresolved placeholder (`href="#reference:...adoc#anchor" class="xref
    // unresolved"`), which a loose regex matches happily -- so the test passed
    // while xref resolution was doing nothing.
    resolveResource: (spec) => {
      const match = /^reference:(.+)\.adoc$/.exec(String(spec).split('#')[0])
      if (!match) return undefined
      return { pub: { url: `/streaming/26.2/reference/${match[1]}/` } }
    },
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
  // Both events, in build order. The anchor index is built at contentClassified
  // because Antora deletes page.src.contents once conversion finishes; firing
  // only documentsConverted would leave the index empty, which is precisely the
  // silent degradation this ordering exists to prevent.
  context.handlers.contentClassified({ contentCatalog })
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
    // A resolved, site-root-relative link -- not Antora's unresolved placeholder.
    expect(html).toContain('href="/streaming/26.2/reference/properties/cluster-properties/#iceberg_enabled"')
    expect(html).toContain('class="xref page"')
    expect(html).not.toContain('unresolved')
  })

  // Display text is pasted into an attribute list, where an unescaped ] ends the
  // list and a bare = is read as a named attribute. Untreated, the first was
  // published as a truncated link with the tail outside it, and the second lost
  // the label entirely and applied part of it as a CSS role.
  it.each([
    ['brackets', 'the flag [beta] option'],
    ['closing bracket', 'element a] b'],
    ['equals sign', 'x=y mapping'],
    ['equals and bracket', 'x=y and a] b'],
    ['quotes', 'say "hi" now'],
    ['comma', 'comma, separated'],
  ])('keeps display text intact through the attribute list: %s', (_label, text) => {
    const partial = '=== iceberg_enabled\n\nEnables Iceberg.\n\n=== other_property\n\nElse.\n'
    const catalog = catalogWith(
      dataset({ other_property: `See <<iceberg_enabled,${text}>>.`, iceberg_enabled: 'Enables Iceberg.' }),
      { partialSource: partial }
    )
    const { data } = run(catalog)
    const html = data.properties.other_property.description_html
    expect(html).toContain('#iceberg_enabled"')
    // The label survives whole, inside the anchor, with nothing trailing it.
    expect(html).toMatch(new RegExp('>' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</a>'))
  })

  // Antora converts each page with its component version's own AsciiDoc config,
  // not the site config, so attributes declared in antora.yml exist only there.
  // Five real descriptions branch on env-cloud.
  it('converts with the component version\'s own attributes', () => {
    const catalog = catalogWith(dataset({ conditional: 'Base.\n\nifdef::env-cloud[]\nCloud only.\nendif::[]' }))
    catalog.getComponentVersion = () => ({
      version: '26.2',
      asciidoc: { attributes: { 'env-cloud': '', 'attribute-missing': 'drop' }, extensions: [] },
    })
    const { data } = run(catalog)
    expect(data.properties.conditional.description_html).toContain('Cloud only.')
  })

  it('falls back to the site config when the component version has none', () => {
    const catalog = catalogWith(dataset({ plain: 'A description.' }))
    catalog.getComponentVersion = () => undefined
    const { data } = run(catalog)
    expect(data.properties.plain.description_html).toBe('A description.')
  })

  // Antora deletes page.src.contents after conversion, so an index built at
  // documentsConverted comes back empty and every reference degrades to plain
  // text. Warming it at contentClassified is what prevents that, and the
  // degradation must be reported rather than silent.
  it('reports rather than silently degrading when no page documents a property', () => {
    const catalog = catalogWith(dataset({ lonely: 'See <<iceberg_enabled,the flag>>.' }), { pages: true })
    const { warnings } = run(catalog)
    expect(warnings.some((w) => String(w).includes('render as plain text'))).toBe(true)
  })

  it('does not treat a shift expression as a property reference', () => {
    // <<20>> is not an anchor. Reporting it as a broken one told writers to fix
    // an anchor that never existed.
    const catalog = catalogWith(dataset({ shifty: 'Compute 1<<20>> bytes.' }))
    const { warnings } = run(catalog)
    expect(warnings.some((w) => String(w).includes('20'))).toBe(false)
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
