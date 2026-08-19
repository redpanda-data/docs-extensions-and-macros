'use strict'

const {
  register,
  buildPropContent,
  compareTags,
  extractHeadingsWithTags,
  evaluateTagExpression,
  helmValuesPath,
  loadPropertiesFor,
  releaseSeries,
} = require('../../macros/prop')

// cloud_supported mirrors the published data: it is the union of editable and
// read-only in Cloud, so it is the single availability gate. Here iceberg_enabled
// is the Cloud-available one; the rest exist in Redpanda but not in Cloud.
const PROPERTIES_JSON = JSON.stringify({
  properties: {
    cloud_storage_enabled: { name: 'cloud_storage_enabled', config_scope: 'cluster', cloud_supported: false },
    fips_mode: { name: 'fips_mode', config_scope: 'broker', cloud_supported: false },
    'redpanda.iceberg.mode': { name: 'redpanda.iceberg.mode', config_scope: 'topic', cloud_supported: false },
    iceberg_enabled: { name: 'iceberg_enabled', config_scope: 'cluster', cloud_supported: true },
    admin: { name: 'admin', config_scope: 'broker', cloud_supported: false },
  },
})

function fakeCatalog ({ json = PROPERTIES_JSON, tag = 'v26.2.1', version = 'current', extraTags = [], files = [], components = {} } = {}) {
  const attachment = (fileTag, contents, component = 'streaming', attachmentVersion = version) => ({
    src: { component, version: attachmentVersion, module: 'reference', family: 'attachment', relative: `redpanda-properties-${fileTag}.json` },
    contents: Buffer.from(contents),
  })
  const all = [attachment(tag, json), ...files]
  for (const extra of extraTags) all.push(attachment(extra, JSON.stringify({ properties: { stale_property: {} } })))
  return catalogOf(all, components)
}

/**
 * A content catalog over the given files. `components` maps a component name to
 * the asciidoc attributes its versions declare, which is how the macro learns
 * that a component is Cloud (env-cloud) and so tracks streaming's newest data.
 */
function catalogOf (files, components = {}) {
  const names = new Set([...files.map((f) => f.src.component), ...Object.keys(components)])
  return {
    findBy: jest.fn((query) => files.filter((file) =>
      Object.entries(query).every(([key, value]) => file.src[key] === value)
    )),
    getComponent: (name) => {
      if (!names.has(name)) return undefined
      const attributes = components[name] || {}
      const versions = [...new Set(files.filter((f) => f.src.component === name).map((f) => f.src.version))]
        .map((v) => ({ version: v, asciidoc: { attributes } }))
      if (!versions.length) versions.push({ version: '', asciidoc: { attributes } })
      return { name, versions, latest: versions[versions.length - 1] }
    },
  }
}

// Shorthand: a Cloud component declares env-cloud, like cloud-docs' antora.yml.
const CLOUD = { 'cloud-data-platform': { 'env-cloud': 'true' } }

function propertiesAttachment (component, version, tag, json = PROPERTIES_JSON) {
  return {
    src: { component, version, module: 'reference', family: 'attachment', relative: `redpanda-properties-${tag}.json` },
    contents: Buffer.from(json),
  }
}

function page (component, relative, contents, version = 'current') {
  return { src: { component, version, module: 'reference', family: 'page', relative }, contents: Buffer.from(contents) }
}

function partial (component, relative, contents, version = 'current') {
  return { src: { component, version, module: 'reference', family: 'partial', relative }, contents: Buffer.from(contents) }
}

function convert (input, { catalog, attributes = {}, filePath = 'modules/manage/pages/example.adoc', component = 'streaming', version = 'current' } = {}) {
  const Asciidoctor = require('@asciidoctor/core')()
  const extensionRegistry = Asciidoctor.Extensions.create()
  register(extensionRegistry, catalog && {
    contentCatalog: catalog,
    file: { src: { path: filePath, component, version, module: 'manage' } },
  })
  return Asciidoctor.convert(input, { extension_registry: extensionRegistry, attributes })
}

describe('prop macro', () => {
  // jest.spyOn returns the existing spy when console.warn is already mocked,
  // so a test that fails before its own mockRestore would otherwise leak its
  // calls into the next test's assertions.
  afterEach(() => jest.restoreAllMocks())

  describe('buildPropContent', () => {
    test('emits a marked code element the UI can decorate', () => {
      const html = buildPropContent({ name: 'cloud_storage_enabled', link: false, role: 'property-ref' })
      expect(html).toBe('<code class="property-ref" data-property-name="cloud_storage_enabled">cloud_storage_enabled</code>')
    })

    test('links to the page it is given', () => {
      const html = buildPropContent({ name: 'fips_mode', link: true, page: 'properties/broker-properties', role: 'property-ref' })
      expect(html).toContain('xref:reference:properties/broker-properties.adoc#fips_mode[fips_mode]')
    })

    test('link=true without a page renders unlinked rather than guessing one', () => {
      // A target derived from config_scope was a guess, and guessed wrong for
      // any component that does not publish that scope's page.
      const html = buildPropContent({ name: 'fips_mode', link: true, scope: 'broker', role: 'property-ref' })
      expect(html).toBe('<code class="property-ref" data-property-name="fips_mode">fips_mode</code>')
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

    test('plain rendering drops the marker entirely', () => {
      // No marker means the docs UI adds no tooltip, which is what an
      // unverified property should get.
      expect(buildPropContent({ name: 'x_y', plain: true, role: 'property-ref' })).toBe('<code>x_y</code>')
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

  describe('releaseSeries', () => {
    test.each([
      ['26.2', '26.2'],
      ['25.3.1', '25.3'],
      ['v26.2.1', '26.2'],
      ['v26.3.1-rc1', '26.3'],
      // Unversioned components and named branches have no series.
      ['', undefined],
      ['current', undefined],
      [undefined, undefined],
    ])('%s -> %s', (input, expected) => {
      expect(releaseSeries(input)).toBe(expected)
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
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('is not in the property data'))
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
      })).toThrow(/is not in the property data/)
    })

    test('stays silent in off mode', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      convert('prop:not_a_property[]', {
        catalog: fakeCatalog(),
        attributes: { 'property-validate': 'off' },
      })
      const validationWarnings = warn.mock.calls.filter(([msg]) => String(msg).includes('is not in the property data'))
      expect(validationWarnings).toHaveLength(0)
      warn.mockRestore()
    })

    test('link=true renders unlinked when no page documents the property', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const html = convert('prop:fips_mode[link=true]', { catalog: fakeCatalog() })
      expect(html).toContain('data-property-name="fips_mode"')
      expect(html).not.toContain('href')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no reference page in this component'))
    })

    test('supports dotted topic property names', () => {
      const html = convert('prop:redpanda.iceberg.mode[]', { catalog: fakeCatalog() })
      expect(html).toContain('data-property-name="redpanda.iceberg.mode"')
    })

    test('caches the property data on the content catalog across conversions', () => {
      const catalog = fakeCatalog()
      // The first conversion scans the catalog (properties JSON plus one
      // page-index scan per candidate component); repeats hit the caches.
      convert('prop:admin[]', { catalog })
      const scansAfterFirst = catalog.findBy.mock.calls.length
      convert('prop:admin[]', { catalog })
      expect(catalog.findBy.mock.calls.length).toBe(scansAfterFirst)
    })

    test('renders plain with no catalog to check against', () => {
      // Nothing to validate means nothing to assert, so no marker and no
      // tooltip rather than an unchecked one.
      expect(convert('prop:anything_goes[]', {})).toContain('<code>anything_goes</code>')
    })
  })

  describe('version awareness', () => {
    test('a page validates against its own version of the properties JSON', () => {
      const oldJson = JSON.stringify({ properties: { legacy_only_prop: { name: 'legacy_only_prop', config_scope: 'cluster' } } })
      const catalog = fakeCatalog({
        files: [
          { src: { component: 'streaming', version: '25.3', module: 'reference', family: 'attachment', relative: 'redpanda-properties-v25.3.11.json' }, contents: Buffer.from(oldJson) },
        ],
      })
      // legacy_only_prop exists only in 25.3 data: valid on the 25.3 page...
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      convert('prop:legacy_only_prop[]', { catalog, version: '25.3' })
      const oldPageWarnings = warn.mock.calls.filter(([m]) => String(m).includes('is not in the property data'))
      expect(oldPageWarnings).toHaveLength(0)
      // ...but unknown on the current page.
      convert('prop:legacy_only_prop[]', { catalog, version: 'current' })
      expect(warn.mock.calls.some(([m]) => String(m).includes('is not in the property data'))).toBe(true)
      warn.mockRestore()
    })

    describe('release-series matching', () => {
      // Every published Redpanda series ships its own properties JSON. Match
      // by major.minor rather than "newest tag anywhere", so a 25.3 page is
      // never checked against 26.x data.
      const load = (files, component, version) => {
        const catalog = { findBy: (q) => files.filter((f) => Object.entries(q).every(([k, v]) => f.src[k] === v)) }
        const registry = loadPropertiesFor(catalog, component, version)
        return registry && registry.tag
      }
      const A = propertiesAttachment

      test('picks the JSON for the page version series, not the newest tag', () => {
        const files = [A('streaming', '26.2', 'v26.2.1'), A('streaming', '26.1', 'v26.1.14'), A('streaming', '25.3', 'v25.3.11')]
        expect(load(files, 'streaming', '26.2')).toBe('v26.2.1')
        expect(load(files, 'streaming', '26.1')).toBe('v26.1.14')
        expect(load(files, 'streaming', '25.3')).toBe('v25.3.11')
      })

      test('a branch carrying an out-of-series JSON does not derail its own series', () => {
        // The docs main branch really does keep the previous series' JSON
        // alongside its own, and a prerelease could land there too.
        const files = [A('streaming', '26.2', 'v26.2.1'), A('streaming', '26.2', 'v26.1.14'), A('streaming', '26.2', 'v26.3.0')]
        expect(load(files, 'streaming', '26.2')).toBe('v26.2.1')
      })

      test('newest patch within the series wins, compared numerically', () => {
        const files = [A('streaming', '25.3', 'v25.3.2'), A('streaming', '25.3', 'v25.3.11')]
        expect(load(files, 'streaming', '25.3')).toBe('v25.3.11')
      })

      test('a series JSON published only on another branch is still used', () => {
        const files = [A('streaming', '26.2', 'v26.2.1'), A('streaming', '26.2', 'v25.3.11')]
        expect(load(files, 'streaming', '25.3')).toBe('v25.3.11')
      })

      test('prerelease tags match their series', () => {
        expect(load([A('streaming', '26.3', 'v26.3.1-rc1')], 'streaming', '26.3')).toBe('v26.3.1-rc1')
      })

      test('a version with no data of its own goes unvalidated, silently at load time', () => {
        // Reporting here would fire for every version in the build, including
        // the many that never use the macro: the index-warming extension calls
        // this for each one. The gap is recorded and reported on first use.
        const files = [A('streaming', '26.2', 'v26.2.1'), A('streaming', '25.3', 'v25.3.11')]
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
        expect(load(files, 'streaming', '25.1')).toBeUndefined()
        expect(warn).not.toHaveBeenCalled()
      })

      test('a page that actually uses prop: reports the gap, naming the missing file', () => {
        const catalog = fakeCatalog({
          version: '26.2',
          files: [propertiesAttachment('streaming', '25.3', 'v25.3.11')],
        })
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
        const html = convert('prop:cloud_storage_enabled[]', { catalog, version: '25.1' })
        // Unvalidated means unmarked: no tooltip the build could not check.
        expect(html).toContain('<code>cloud_storage_enabled</code>')
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('redpanda-properties-v25.1.*.json'))
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('v25.3.11, v26.2.1'))
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('property-docs --tag v25.1.'))
      })

      test('a later build in the same process warns again', () => {
        // Watch mode keeps one process across builds, so the guard is scoped to
        // the content catalog rather than the module: a writer iterating on a
        // page must keep seeing the warning, not just on the first build.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
        for (const build of [1, 2]) {
          const catalog = fakeCatalog({ version: '26.2' })
          convert('prop:cloud_storage_enabled[]', { catalog, version: '24.7' })
          expect(warn.mock.calls.filter(([m]) => String(m).includes('24.7'))).toHaveLength(build)
        }
      })

      test('property-validate=off silences the missing-series warning too', () => {
        const catalog = fakeCatalog({ version: '26.2' })
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
        convert('prop:cloud_storage_enabled[]', {
          catalog,
          version: '24.8',
          attributes: { 'property-validate': 'off' },
        })
        expect(warn).not.toHaveBeenCalled()
      })

      test('the gap is reported once per component version, not once per mention', () => {
        const catalog = fakeCatalog({ version: '26.2' })
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
        convert('prop:cloud_storage_enabled[] prop:fips_mode[]', { catalog, version: '24.9' })
        convert('prop:iceberg_enabled[]', { catalog, version: '24.9' })
        expect(warn.mock.calls.filter(([m]) => String(m).includes('24.9'))).toHaveLength(1)
      })

      test('a component with no data of its own and no env-cloud gets nothing', () => {
        // Connect and the agentic data plane carry their own product versions,
        // which say nothing about which Redpanda properties exist, so no
        // dataset is inferred for them. Supporting a further doc set is a
        // deliberate addition, not a guess from a version number.
        const files = [A('streaming', '26.2', 'v26.2.1'), A('streaming', '25.1', 'v25.1.9')]
        expect(load(files, 'connect', '4.85')).toBeUndefined()
        expect(load(files, 'agentic-data-plane', '1.2')).toBeUndefined()
        expect(load(files, 'connect', '')).toBeUndefined()
      })

      test('a Cloud component tracks the newest self-managed data', () => {
        // Cloud is managed streaming: no data of its own, always the latest.
        const files = [A('streaming', '25.1', 'v25.1.9'), A('streaming', '26.2', 'v26.2.1')]
        const catalog = catalogOf(files, CLOUD)
        const registry = loadPropertiesFor(catalog, 'cloud-data-platform', '')
        expect(registry.tag).toBe('v26.2.1')
        expect(registry.surface).toBe('cloud')
      })

      test('a self-managed component may reference every property in its series', () => {
        const files = [A('streaming', '26.2', 'v26.2.1')]
        expect(loadPropertiesFor(catalogOf(files), 'streaming', '26.2').surface).toBe('all')
      })
    })

    test('discovery never links a versioned page into another version', () => {
      const catalog = fakeCatalog({
        files: [
          // 25.3 pages need 25.3 property data: without it the macro declines
          // to validate or index them rather than borrow 26.x data.
          propertiesAttachment('streaming', '25.3', 'v25.3.11'),
          partial('streaming', 'properties/all.adoc', '=== cloud_storage_enabled\n', '25.3'),
          page('streaming', 'properties/legacy-page.adoc', 'include::reference:partial$properties/all.adoc[]', '25.3'),
          partial('streaming', 'properties/all.adoc', '=== cloud_storage_enabled\n', 'current'),
          page('streaming', 'properties/current-page.adoc', 'include::reference:partial$properties/all.adoc[]', 'current'),
        ],
      })
      expect(convert('prop:cloud_storage_enabled[link=true]', { catalog, version: '25.3' })).toContain('legacy-page')
      expect(convert('prop:cloud_storage_enabled[link=true]', { catalog, version: 'current' })).toContain('current-page')
    })
  })

  describe('cloud availability', () => {
    // cloud_supported is the single gate: the published data has no property
    // that is editable or read-only in Cloud without also being supported, so
    // it is already the union of both.
    const cloudCatalog = (files = []) => catalogOf([propertiesAttachment('streaming', 'current', 'v26.2.1'), ...files], CLOUD)

    test('a cloud_supported property is marked on a Cloud page', () => {
      const html = convert('prop:iceberg_enabled[]', { catalog: cloudCatalog(), component: 'cloud-data-platform', version: '' })
      expect(html).toContain('data-property-name="iceberg_enabled"')
    })

    test('a property Cloud does not support renders plain and warns', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const html = convert('prop:fips_mode[]', { catalog: cloudCatalog(), component: 'cloud-data-platform', version: '' })
      expect(html).toContain('<code>fips_mode</code>')
      expect(html).not.toContain('data-property-name')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not available in the cloud-data-platform component'))
    })

    test('self-managed pages are not gated by cloud_supported', () => {
      const html = convert('prop:fips_mode[]', { catalog: fakeCatalog(), component: 'streaming', version: '26.2' })
      expect(html).toContain('data-property-name="fips_mode"')
    })

    test('property-validate=off silences the availability warning', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const html = convert('prop:fips_mode[]', {
        catalog: cloudCatalog(), component: 'cloud-data-platform', version: '',
        attributes: { 'property-validate': 'off' },
      })
      expect(html).toContain('<code>fips_mode</code>')
      expect(warn).not.toHaveBeenCalled()
    })

    test('an unavailable property keeps its display text override', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const html = convert('prop:fips_mode[text=FIPS mode]', { catalog: cloudCatalog(), component: 'cloud-data-platform', version: '' })
      expect(html).toContain('<code>FIPS mode</code>')
      warn.mockRestore()
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
      '=== iceberg_enabled',
      'Iceberg.',
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

    test('stamps the discovered documentation URL and Asciidoctor anchor on every marker', () => {
      const withPub = page('streaming', 'properties/topic-properties.adoc', '=== redpanda.iceberg.mode\n')
      withPub.pub = { url: '/current/reference/properties/topic-properties/' }
      const catalog = fakeCatalog({ files: [withPub] })
      // Tooltip-only markers carry the stamp too (no link requested), and the
      // anchor is what Asciidoctor generates: dots become hyphens,
      // underscores stay.
      const plain = convert('prop:redpanda.iceberg.mode[]', { catalog })
      expect(plain).toContain('data-doc-url="/current/reference/properties/topic-properties/#redpanda-iceberg-mode"')
      expect(plain).not.toContain('xref:')
      const linked = convert('prop:redpanda.iceberg.mode[link=true]', { catalog })
      expect(linked).toContain('topic-properties.html#redpanda-iceberg-mode')
    })

    test('cloud pages discover their own page through cross-component tag-filtered includes', () => {
      const catalog = catalogOf([
        propertiesAttachment('streaming', 'current', 'v26.2.1'),
        partial('streaming', 'properties/all-properties.adoc', PARTIAL),
        page('cloud-data-platform', 'properties/cloud-cluster.adoc',
          'include::streaming:reference:partial$properties/all-properties.adoc[tags=redpanda-cloud]'),
      ], CLOUD)
      // iceberg_enabled is cloud_supported and sits inside the redpanda-cloud
      // tag, so the cloud page documents it and the link stays component-local.
      const linked = convert('prop:iceberg_enabled[link=true]', { catalog, component: 'cloud-data-platform', version: '' })
      expect(linked).toContain('cloud-cluster')
      expect(linked).not.toContain('streaming:')
    })

    test('a property Cloud does not support renders plain, whatever the pages say', () => {
      // Availability is a property of the data, not of which pages happen to
      // include it: cloud_supported false means a Cloud reader cannot set it.
      const catalog = catalogOf([
        propertiesAttachment('streaming', 'current', 'v26.2.1'),
        partial('streaming', 'properties/all.adoc', '=== cloud_storage_enabled\n'),
        // Even though a cloud page renders the heading, the data says no.
        page('cloud-data-platform', 'properties/cloud-cluster.adoc',
          'include::streaming:reference:partial$properties/all.adoc[]'),
      ], CLOUD)
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const html = convert('prop:cloud_storage_enabled[link=true]', {
        catalog, component: 'cloud-data-platform', version: '',
        filePath: 'modules/manage/pages/config-cluster.adoc',
      })
      expect(html).toBe('<div class="paragraph">\n<p><code>cloud_storage_enabled</code></p>\n</div>')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'cloud_storage_enabled' is not available in the cloud-data-platform component"))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cloud_supported: false'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('modules/manage/pages/config-cluster.adoc'))
    })

    test('the same property is fine on a self-managed page', () => {
      const catalog = catalogOf([
        propertiesAttachment('streaming', '26.2', 'v26.2.1'),
        partial('streaming', 'properties/all.adoc', '=== cloud_storage_enabled\n', '26.2'),
        page('streaming', 'properties/cluster-properties.adoc',
          'include::reference:partial$properties/all.adoc[]', '26.2'),
      ])
      const html = convert('prop:cloud_storage_enabled[link=true]', { catalog, component: 'streaming', version: '26.2' })
      expect(html).toContain('data-property-name="cloud_storage_enabled"')
      expect(html).toContain('cluster-properties')
    })

    test('a property published nowhere keeps its tooltip and only warns on link=true', () => {
      const catalog = fakeCatalog({
        files: [
          // Pages exist, but none of them includes a partial documenting admin
          // -- a deprecated property, or one held back by include tags. The
          // published JSON still describes it, so the tooltip stays useful.
          partial('streaming', 'properties/all.adoc', '=== cloud_storage_enabled\n'),
          page('streaming', 'properties/cluster-properties.adoc', 'include::reference:partial$properties/all.adoc[]'),
        ],
      })
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const linked = convert('prop:admin[link=true]', { catalog })
      expect(linked).toContain('data-property-name="admin"')
      expect(linked).not.toContain('href')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('renders without a link'))
      // A tooltip-only mention is silent: there is nothing for a writer to fix.
      warn.mockClear()
      const plain = convert('prop:admin[]', { catalog })
      expect(plain).toContain('data-property-name="admin"')
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    test('property-validate=off silences the wrong-audience warning', () => {
      const catalog = fakeCatalog({
        files: [
          partial('cloud-data-platform', 'properties/cluster.adoc', '=== cloud_storage_enabled\n'),
          page('cloud-data-platform', 'properties/cluster-properties.adoc', 'include::reference:partial$properties/cluster.adoc[]'),
          partial('streaming', 'properties/topic.adoc', '=== redpanda.iceberg.mode\n'),
          page('streaming', 'properties/topic-properties.adoc', 'include::reference:partial$properties/topic.adoc[]'),
        ],
      })
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const html = convert('prop:redpanda.iceberg.mode[]', {
        catalog,
        component: 'cloud-data-platform',
        attributes: { 'property-validate': 'off' },
      })
      expect(html).toContain('<code>redpanda.iceberg.mode</code>')
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    test('an unknown name warns once, not twice', () => {
      const catalog = fakeCatalog({
        components: CLOUD,
        files: [
          partial('cloud-data-platform', 'properties/cluster.adoc', '=== iceberg_enabled\n'),
          page('cloud-data-platform', 'properties/cluster-properties.adoc', 'include::reference:partial$properties/cluster.adoc[]'),
        ],
      })
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      convert('prop:cloud_storage_enabbled[link=true]', { catalog, component: 'cloud-data-platform' })
      expect(warn.mock.calls).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('is not in the property data'))
      warn.mockRestore()
    })

    test('a display text override survives the plain rendering', () => {
      const catalog = fakeCatalog({
        files: [
          partial('cloud-data-platform', 'properties/cluster.adoc', '=== cloud_storage_enabled\n'),
          page('cloud-data-platform', 'properties/cluster-properties.adoc', 'include::reference:partial$properties/cluster.adoc[]'),
          partial('streaming', 'properties/topic.adoc', '=== redpanda.iceberg.mode\n'),
          page('streaming', 'properties/topic-properties.adoc', 'include::reference:partial$properties/topic.adoc[]'),
        ],
      })
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const html = convert('prop:redpanda.iceberg.mode[text=Iceberg mode]', { catalog, component: 'cloud-data-platform' })
      expect(html).toContain('<code>Iceberg mode</code>')
      warn.mockRestore()
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
