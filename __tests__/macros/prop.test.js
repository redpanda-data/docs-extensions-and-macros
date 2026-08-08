'use strict'

const {
  register,
  buildPropContent,
  compareTags,
  extractHeadingsWithTags,
  evaluateTagExpression,
  helmValuesPath,
} = require('../../macros/prop')

const PROPERTIES_JSON = JSON.stringify({
  properties: {
    cloud_storage_enabled: { name: 'cloud_storage_enabled', config_scope: 'cluster' },
    fips_mode: { name: 'fips_mode', config_scope: 'broker' },
    'redpanda.iceberg.mode': { name: 'redpanda.iceberg.mode', config_scope: 'topic' },
    iceberg_enabled: { name: 'iceberg_enabled', config_scope: 'cluster' },
    admin: { name: 'admin', config_scope: 'broker' },
  },
})

function fakeCatalog ({ json = PROPERTIES_JSON, tag = 'v26.2.1', extraTags = [], files = [] } = {}) {
  const attachment = (fileTag, contents, component = 'streaming') => ({
    src: { component, module: 'reference', family: 'attachment', relative: `redpanda-properties-${fileTag}.json` },
    contents: Buffer.from(contents),
  })
  const all = [attachment(tag, json), ...files]
  for (const extra of extraTags) all.push(attachment(extra, JSON.stringify({ properties: { stale_property: {} } })))
  return {
    findBy: jest.fn((query) => all.filter((file) =>
      Object.entries(query).every(([key, value]) => file.src[key] === value || (key === 'family' && file.src.family === value))
    )),
  }
}

function page (component, relative, contents) {
  return { src: { component, module: 'reference', family: 'page', relative }, contents: Buffer.from(contents) }
}

function partial (component, relative, contents) {
  return { src: { component, module: 'reference', family: 'partial', relative }, contents: Buffer.from(contents) }
}

function convert (input, { catalog, attributes = {}, filePath = 'modules/manage/pages/example.adoc', component = 'streaming' } = {}) {
  const Asciidoctor = require('@asciidoctor/core')()
  const extensionRegistry = Asciidoctor.Extensions.create()
  register(extensionRegistry, catalog && {
    contentCatalog: catalog,
    file: { src: { path: filePath, component, module: 'manage' } },
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

    test('link=true falls back to the scope-derived page when nothing is discovered', () => {
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

  describe('helm-path display', () => {
    test.each([
      ['cloud_storage_enabled', 'cluster', 'storage.tiered.config.cloud_storage_enabled'],
      ['fips_mode', 'broker', 'config.node.fips_mode'],
      ['log_segment_size', 'cluster', 'config.cluster.log_segment_size'],
    ])('%s (%s) -> %s', (name, scope, expected) => {
      expect(helmValuesPath(name, scope)).toBe(expected)
    })

    test('helm-path=auto displays the Helm values path on env-kubernetes pages', () => {
      const html = convert('prop:cloud_storage_enabled[helm-path=auto]', {
        catalog: fakeCatalog(),
        attributes: { 'env-kubernetes': 'true' },
      })
      expect(html).toContain('storage.tiered.config.cloud_storage_enabled')
      expect(html).toContain('data-property-name="cloud_storage_enabled"')
    })

    test('non-tiered properties get the config.cluster path, fixing config_ref mislabeling', () => {
      const html = convert('prop:iceberg_enabled[helm-path=auto]', {
        catalog: fakeCatalog(),
        attributes: { 'env-kubernetes': 'true' },
      })
      expect(html).toContain('config.cluster.iceberg_enabled')
      expect(html).not.toContain('storage.tiered.config')
    })

    test('broker properties get the config.node path', () => {
      const html = convert('prop:fips_mode[helm-path=auto]', {
        catalog: fakeCatalog(),
        attributes: { 'env-kubernetes': 'true' },
      })
      expect(html).toContain('config.node.fips_mode')
    })

    test('helm-path=auto renders the plain name without env-kubernetes', () => {
      const html = convert('prop:cloud_storage_enabled[helm-path=auto]', { catalog: fakeCatalog() })
      expect(html).not.toContain('storage.tiered.config')
      expect(html).toContain('>cloud_storage_enabled</code>')
    })

    test('explicit text= wins over the helm path', () => {
      const html = convert('prop:cloud_storage_enabled[helm-path=auto,text=the tiered flag]', {
        catalog: fakeCatalog(),
        attributes: { 'env-kubernetes': 'true' },
      })
      expect(html).toContain('>the tiered flag</code>')
    })
  })

  describe('dynamic page discovery', () => {
    const PARTIAL = [
      '=== cloud_storage_enabled',
      'Enables tiered storage.',
      '// tag::redpanda-cloud[]',
      '=== fips_mode',
      'FIPS.',
      '// end::redpanda-cloud[]',
    ].join('\n')

    test('links to the page that includes the partial documenting the property', () => {
      const catalog = fakeCatalog({
        files: [
          partial('streaming', 'properties/all-properties.adoc', PARTIAL),
          page('streaming', 'properties/custom-page.adoc', 'include::reference:partial$properties/all-properties.adoc[]'),
        ],
      })
      const html = convert('prop:cloud_storage_enabled[link=true]', { catalog })
      expect(html).toContain('properties/custom-page')
      expect(html).not.toContain('cluster-properties')
    })

    test('follows a future split of properties across pages', () => {
      const catalog = fakeCatalog({
        files: [
          partial('streaming', 'properties/storage.adoc', '=== cloud_storage_enabled\n'),
          partial('streaming', 'properties/security.adoc', '=== fips_mode\n'),
          page('streaming', 'properties/storage-props.adoc', 'include::reference:partial$properties/storage.adoc[]'),
          page('streaming', 'properties/security-props.adoc', 'include::reference:partial$properties/security.adoc[]'),
        ],
      })
      expect(convert('prop:cloud_storage_enabled[link=true]', { catalog })).toContain('storage-props')
      expect(convert('prop:fips_mode[link=true]', { catalog })).toContain('security-props')
    })

    test('cloud pages discover their own page through cross-component tag-filtered includes', () => {
      const catalog = fakeCatalog({
        files: [
          partial('streaming', 'properties/all-properties.adoc', PARTIAL),
          page('cloud-data-platform', 'properties/cloud-cluster.adoc',
            'include::streaming:reference:partial$properties/all-properties.adoc[tags=redpanda-cloud]'),
        ],
      })
      // fips_mode is inside the redpanda-cloud tag: discovered on the cloud page.
      const linked = convert('prop:fips_mode[link=true]', { catalog, component: 'cloud-data-platform' })
      expect(linked).toContain('cloud-cluster')
      // cloud_storage_enabled is outside the tag: not on the cloud page, falls back to scope.
      const fallback = convert('prop:cloud_storage_enabled[link=true]', { catalog, component: 'cloud-data-platform' })
      expect(fallback).toContain('cluster-properties')
    })

    test('components without property pages get component-qualified links into streaming', () => {
      const catalog = fakeCatalog({
        files: [
          partial('streaming', 'properties/all-properties.adoc', PARTIAL),
          page('streaming', 'properties/cluster-properties.adoc', 'include::reference:partial$properties/all-properties.adoc[]'),
        ],
      })
      // The preview/connect components publish no property pages at all.
      const html = convert('prop:cloud_storage_enabled[link=true]', { catalog, component: 'preview' })
      expect(html).toContain('streaming')
      expect(html).toContain('cluster-properties')
    })

    test('a component with SOME property pages still borrows streaming for properties it does not publish', () => {
      const catalog = fakeCatalog({
        files: [
          // Cloud publishes cluster properties but not topic properties.
          partial('cloud-data-platform', 'properties/cluster.adoc', '=== cloud_storage_enabled\n'),
          page('cloud-data-platform', 'properties/cluster-properties.adoc', 'include::reference:partial$properties/cluster.adoc[]'),
          partial('streaming', 'properties/topic.adoc', '=== redpanda.iceberg.mode\n'),
          page('streaming', 'properties/topic-properties.adoc', 'include::reference:partial$properties/topic.adoc[]'),
        ],
      })
      // Documented in cloud's own pages: component-relative link.
      const own = convert('prop:cloud_storage_enabled[link=true]', { catalog, component: 'cloud-data-platform' })
      expect(own).not.toContain('streaming')
      // Not documented in cloud: component-qualified link into streaming.
      const borrowed = convert('prop:redpanda.iceberg.mode[link=true]', { catalog, component: 'cloud-data-platform' })
      expect(borrowed).toContain('streaming')
      expect(borrowed).toContain('topic-properties')
    })

    test('page= overrides discovery', () => {
      const catalog = fakeCatalog({
        files: [
          partial('streaming', 'properties/all-properties.adoc', PARTIAL),
          page('streaming', 'properties/custom-page.adoc', 'include::reference:partial$properties/all-properties.adoc[]'),
        ],
      })
      const html = convert('prop:cloud_storage_enabled[link=true,page=properties/object-storage-properties]', { catalog })
      expect(html).toContain('object-storage-properties')
    })
  })

  describe('extractHeadingsWithTags', () => {
    test('records the open tags around each heading', () => {
      const headings = extractHeadingsWithTags([
        '=== plain_prop',
        '// tag::redpanda-cloud[]',
        '=== cloud_prop',
        '// tag::deprecated[]',
        '=== old_cloud_prop',
        '// end::deprecated[]',
        '// end::redpanda-cloud[]',
      ].join('\n'))
      expect(headings).toEqual([
        { name: 'plain_prop', tags: [] },
        { name: 'cloud_prop', tags: ['redpanda-cloud'] },
        { name: 'old_cloud_prop', tags: ['redpanda-cloud', 'deprecated'] },
      ])
    })
  })

  describe('evaluateTagExpression', () => {
    test.each([
      [[], undefined, true],
      [['deprecated'], '!deprecated;!exclude-from-docs', false],
      [[], '!deprecated;!exclude-from-docs', true],
      [['redpanda-cloud'], 'redpanda-cloud;!deprecated', true],
      [[], 'redpanda-cloud;!deprecated', false],
      [['redpanda-cloud', 'deprecated'], 'redpanda-cloud;!deprecated', false],
    ])('tags %j with expression %j -> %s', (tags, expression, expected) => {
      expect(evaluateTagExpression(tags, expression)).toBe(expected)
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
