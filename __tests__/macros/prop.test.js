'use strict'

const { register, buildPropContent, compareTags } = require('../../macros/prop')

const PROPERTIES_JSON = JSON.stringify({
  properties: {
    cloud_storage_enabled: { name: 'cloud_storage_enabled', config_scope: 'cluster' },
    fips_mode: { name: 'fips_mode', config_scope: 'broker' },
    'redpanda.iceberg.mode': { name: 'redpanda.iceberg.mode', config_scope: 'topic' },
    admin: { name: 'admin', config_scope: 'broker' },
  },
})

function fakeCatalog ({ json = PROPERTIES_JSON, tag = 'v26.2.1', extraTags = [] } = {}) {
  const attachment = (fileTag, contents) => ({
    src: { module: 'reference', relative: `redpanda-properties-${fileTag}.json` },
    contents: Buffer.from(contents),
  })
  const files = [attachment(tag, json)]
  for (const extra of extraTags) files.push(attachment(extra, JSON.stringify({ properties: { stale_property: {} } })))
  return { findBy: jest.fn(() => files) }
}

function convert (input, { catalog, attributes = {}, filePath = 'modules/manage/pages/example.adoc' } = {}) {
  const Asciidoctor = require('@asciidoctor/core')()
  const extensionRegistry = Asciidoctor.Extensions.create()
  register(extensionRegistry, catalog && {
    contentCatalog: catalog,
    file: { src: { path: filePath } },
  })
  return Asciidoctor.convert(input, { extension_registry: extensionRegistry, attributes })
}

describe('prop macro', () => {
  describe('buildPropContent', () => {
    test('emits a marked code element the UI can decorate', () => {
      const html = buildPropContent({ name: 'cloud_storage_enabled', link: false, role: 'property-ref' })
      expect(html).toBe('<code class="property-ref" data-property-name="cloud_storage_enabled">cloud_storage_enabled</code>')
    })

    test('links to the scope-derived reference page', () => {
      const html = buildPropContent({ name: 'fips_mode', link: true, scope: 'broker', role: 'property-ref' })
      expect(html).toContain('xref:reference:properties/broker-properties.adoc#fips_mode[fips_mode]')
    })

    test('page overrides the derived target', () => {
      const html = buildPropContent({
        name: 'cloud_storage_enabled',
        link: true,
        scope: 'cluster',
        page: 'properties/object-storage-properties',
        role: 'property-ref',
      })
      expect(html).toContain('xref:reference:properties/object-storage-properties.adoc#cloud_storage_enabled[')
    })

    test('defaults to the cluster page when scope is unknown', () => {
      const html = buildPropContent({ name: 'x_y', link: true, role: 'property-ref' })
      expect(html).toContain('properties/cluster-properties.adoc#x_y')
    })

    test('honors display text overrides', () => {
      const html = buildPropContent({ name: 'write_caching_default', text: 'write caching', link: false, role: 'property-ref' })
      expect(html).toContain('>write caching</code>')
      expect(html).toContain('data-property-name="write_caching_default"')
    })
  })

  describe('compareTags', () => {
    test.each([
      ['v26.2.1', 'v26.1.14', 1],
      ['v26.1.14', 'v26.2.1', -1],
      ['v26.2.1', 'v26.2.1', 0],
    ])('%s vs %s', (a, b, expected) => {
      expect(Math.sign(compareTags(a, b))).toBe(expected)
    })
  })

  describe('registry-backed conversion', () => {
    test('marks a known property', () => {
      const html = convert('Set prop:cloud_storage_enabled[] to true.', { catalog: fakeCatalog() })
      expect(html).toContain('data-property-name="cloud_storage_enabled"')
      expect(html).toContain('class="property-ref"')
    })

    test('validates against the newest published JSON when several exist', () => {
      const catalog = fakeCatalog({ extraTags: ['v25.3.1'] })
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      convert('prop:stale_property[]', { catalog })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not match any property'))
      warn.mockRestore()
    })

    test('warns on unknown property names by default, with the file path', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const html = convert('prop:cloud_storage_enabbled[]', { catalog: fakeCatalog() })
      expect(html).toContain('cloud_storage_enabbled')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('modules/manage/pages/example.adoc'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Did you mean'))
      warn.mockRestore()
    })

    test('fails the conversion in error mode', () => {
      expect(() => convert('prop:not_a_property[]', {
        catalog: fakeCatalog(),
        attributes: { 'property-validate': 'error' },
      })).toThrow(/does not match any property/)
    })

    test('stays silent in off mode', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      convert('prop:not_a_property[]', {
        catalog: fakeCatalog(),
        attributes: { 'property-validate': 'off' },
      })
      const validationWarnings = warn.mock.calls.filter(([msg]) => String(msg).includes('does not match'))
      expect(validationWarnings).toHaveLength(0)
      warn.mockRestore()
    })

    test('link=true resolves the scope from the published JSON', () => {
      const html = convert('prop:fips_mode[link=true]', { catalog: fakeCatalog() })
      expect(html).toContain('broker-properties')
      expect(html).toContain('data-property-name="fips_mode"')
    })

    test('supports dotted topic property names', () => {
      const html = convert('prop:redpanda.iceberg.mode[]', { catalog: fakeCatalog() })
      expect(html).toContain('data-property-name="redpanda.iceberg.mode"')
    })

    test('caches the property data on the content catalog across conversions', () => {
      const catalog = fakeCatalog()
      convert('prop:admin[]', { catalog })
      convert('prop:admin[]', { catalog })
      expect(catalog.findBy).toHaveBeenCalledTimes(1)
    })

    test('renders unvalidated without a catalog (graceful degradation)', () => {
      const html = convert('prop:anything_goes[]', {})
      expect(html).toContain('data-property-name="anything_goes"')
    })
  })

  describe('registration', () => {
    test('registers an inline macro on a plain registry', () => {
      const inlineMacro = jest.fn()
      register({ inlineMacro })
      expect(inlineMacro).toHaveBeenCalledTimes(1)
    })
  })
})
