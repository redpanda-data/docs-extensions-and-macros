'use strict'

const {
  register,
  buildEnterpriseContent,
  buildFeatureTable,
  parseRegistry,
  resolveTooltipAttribute,
} = require('../../macros/enterprise')

const REGISTRY_YAML = `
schema-version: 1
features:
  - name: Tiered Storage
    scope: redpanda
    xref: manage:tiered-storage.adoc
    xref-kubernetes: manage:kubernetes/tiered-storage/k-tiered-storage.adoc
    xref-cloud: cloud-data-platform:manage:tiered-storage.adoc
    description: |
      Enables data storage in cloud object storage.
    expiration: |
      Topics cannot be created or modified to enable Tiered Storage features.
    aliases: [cloud_storage]
    source:
      kind: core-enum
      value: cloud_storage
    gating-property: cloud_storage_enabled
  - name: Topic Deletion Control
    scope: redpanda
    description: |
      Prevents topic deletion through the Kafka DeleteTopics API.
    expiration: |
      Topic deletion reverts to enabled.
    show-gating-property: true
    source:
      kind: core-enum
      value: topic_deletion_disabled
    gating-property: delete_topic_enable
  - name: Enterprise connectors
    scope: connect
    url: https://docs.redpanda.com/redpanda-connect/components/catalog/?support=enterprise
    description: |
      Connectors available only to enterprise customers.
    expiration: |
      All enterprise connectors are blocked.
    source:
      kind: manual
      value: Aggregate entry tracked in info.csv.
  - name: Stretch Clusters
    scope: operator
    xref: deploy:redpanda/kubernetes/k-stretch-clusters.adoc
    description: |
      Multi-region clusters.
    expiration: |
      The multicluster operator requires a valid license to start.
    feature-suffix: (StretchCluster resource)
    beta: true
    source:
      kind: manual
      value: License gate in cmd/multicluster.
`

function fakeCatalog (yamlSource = REGISTRY_YAML) {
  return {
    findBy: jest.fn(() => [
      { path: 'modules/ROOT/partials/enterprise-features.yml', contents: Buffer.from(yamlSource) },
    ]),
  }
}

function convert (input, { catalog, attributes = {}, filePath = 'modules/manage/pages/example.adoc', component = 'streaming', version = '26.2' } = {}) {
  const Asciidoctor = require('@asciidoctor/core')()
  const extensionRegistry = Asciidoctor.Extensions.create()
  register(extensionRegistry, catalog && {
    contentCatalog: catalog,
    file: { src: { path: filePath, component, version } },
  })
  return Asciidoctor.convert(input, { extension_registry: extensionRegistry, attributes })
}

/**
 * A catalog whose component versions carry Antora's prerelease flag, which is
 * how the macro tells a beta branch from released docs.
 */
function catalogWithVersions (yamlSource, versions) {
  return {
    findBy: jest.fn(() => [
      { path: 'modules/ROOT/partials/enterprise-features.yml', contents: Buffer.from(yamlSource) },
    ]),
    getComponent: (name) => name === 'streaming'
      ? { name, versions, latest: versions[0] }
      : undefined,
  }
}

const VERSIONS = [{ version: '26.2' }, { version: '26.3', prerelease: true }]

describe('enterprise macro', () => {
  // jest.spyOn returns the existing spy when console.warn is already mocked, so
  // a test that does not restore its own leaks its calls into the next test.
  afterEach(() => jest.restoreAllMocks())

  describe('release status', () => {
    // A release cycle: a feature lands in an RC (unreleased), later becomes a
    // public beta, later ships. Each state decides where it may be referenced.
    const STATUS_YAML = `
schema-version: 1
features:
  - name: Shipped Feature
    scope: redpanda
    description: Already released.
    expiration: Restricted.
    kind: license
    source: x
    value: y
  - name: Public Beta Feature
    scope: redpanda
    status: beta
    description: Available as a beta.
    expiration: Restricted.
    kind: license
    source: x
    value: y
  - name: Upcoming Feature
    scope: redpanda
    status: unreleased
    description: Only in a release candidate.
    expiration: Restricted.
    kind: license
    source: x
    value: y
  - name: Legacy Beta Feature
    scope: redpanda
    beta: true
    description: Marked with the older boolean.
    expiration: Restricted.
    kind: license
    source: x
    value: y
`
    const catalog = () => catalogWithVersions(STATUS_YAML, VERSIONS)
    const onReleased = (input) => convert(input, { catalog: catalog(), component: 'streaming', version: '26.2' })
    const onBeta = (input) => convert(input, { catalog: catalog(), component: 'streaming', version: '26.3' })

    test('a shipped feature renders normally on released docs', () => {
      const html = onReleased('enterprise:Shipped Feature[]')
      expect(html).toContain('class="enterprise-feature"')
      expect(html).not.toContain('unreleased')
      expect(html).not.toContain('>beta<')
    })

    test('a public beta feature renders with a beta badge anywhere', () => {
      for (const html of [onReleased('enterprise:Public Beta Feature[]'), onBeta('enterprise:Public Beta Feature[]')]) {
        expect(html).toContain('class="enterprise-feature"')
        expect(html).toContain('beta')
      }
    })

    test('beta: true still means beta, so existing entries keep working', () => {
      const html = onReleased('enterprise:Legacy Beta Feature[]')
      expect(html).toContain('class="enterprise-feature"')
      expect(html).toContain('beta')
    })

    test('an unreleased feature on released docs renders as plain text and warns', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const html = onReleased('enterprise:Upcoming Feature[]')
      // No enterprise styling, no tooltip, no link: the reader cannot get it.
      expect(html).not.toContain('enterprise-feature')
      expect(html).not.toContain('unreleased')
      expect(html).toContain('Upcoming Feature')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('status: unreleased'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('prerelease (beta) branch'))
    })

    test('an unreleased feature on a prerelease page renders with an unreleased badge', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const html = onBeta('enterprise:Upcoming Feature[]')
      expect(html).toContain('class="enterprise-feature"')
      expect(html).toContain('unreleased')
      expect(warn).not.toHaveBeenCalled()
    })

    test('the display text override survives the plain rendering', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      expect(onReleased('enterprise:Upcoming Feature[text=the upcoming thing]')).toContain('the upcoming thing')
      warn.mockRestore()
    })

    test('enterprise-validate=error fails the build on a released page', () => {
      expect(() => convert('enterprise:Upcoming Feature[]', {
        catalog: catalog(), component: 'streaming', version: '26.2',
        attributes: { 'enterprise-validate': 'error' },
      })).toThrow(/status: unreleased/)
    })

    test('enterprise-validate=off silences the report', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const html = convert('enterprise:Upcoming Feature[]', {
        catalog: catalog(), component: 'streaming', version: '26.2',
        attributes: { 'enterprise-validate': 'off' },
      })
      expect(html).toContain('Upcoming Feature')
      expect(warn).not.toHaveBeenCalled()
    })

    // A typo in the status is the one thing that must not publish an unreleased
    // feature, so an unrecognized value fails closed. The two directions are not
    // symmetric: gating a shipped feature shows the writer a warning and an
    // unstyled mention they will notice, while publishing an unreleased one
    // promises readers a feature they cannot get and looks entirely normal.
    test('an unrecognized status is treated as unreleased, not as shipped', () => {
      const typo = STATUS_YAML.replace('status: unreleased', 'status: unreleaased')
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const html = convert('enterprise:Upcoming Feature[]', {
        catalog: catalogWithVersions(typo, VERSIONS), component: 'streaming', version: '26.2',
      })
      expect(html).not.toContain('class="enterprise-feature"')
      expect(html).toContain('Upcoming Feature')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("status 'unreleaased' is not one of"))
    })

    test('a blank status is an absent status, not an invalid one', () => {
      const blank = STATUS_YAML.replace('status: unreleased', 'status:')
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const html = convert('enterprise:Upcoming Feature[]', {
        catalog: catalogWithVersions(blank, VERSIONS), component: 'streaming', version: '26.2',
      })
      expect(html).toContain('class="enterprise-feature"')
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('is not one of'))
    })

    test('the licensing table omits unreleased features on released docs', () => {
      const html = onReleased('enterprise_features::redpanda[]')
      expect(html).toContain('Shipped Feature')
      expect(html).toContain('Public Beta Feature')
      expect(html).not.toContain('Upcoming Feature')
    })

    test('the licensing table lists them on prerelease docs, badged', () => {
      const html = onBeta('enterprise_features::redpanda[]')
      expect(html).toContain('Upcoming Feature')
      expect(html).toContain('unreleased')
    })

    test('a playbook attribute can declare prerelease-ness directly', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const html = convert('enterprise:Upcoming Feature[]', {
        catalog: catalog(), component: 'streaming', version: '26.2',
        attributes: { 'page-component-version-is-prerelease': 'true' },
      })
      expect(html).toContain('class="enterprise-feature"')
      expect(warn).not.toHaveBeenCalled()
    })
  })

  describe('buildEnterpriseContent', () => {
    const defaults = {
      licensingPage: 'get-started:licensing/overview.adoc',
      role: 'enterprise-feature',
      tooltipAttr: 'title',
      links: true,
    }

    test('links the feature name to the licensing page by default', () => {
      const html = buildEnterpriseContent({ ...defaults, feature: 'Continuous Data Balancing' })
      expect(html).toBe(
        '<span class="enterprise-feature" title="Continuous Data Balancing requires an Enterprise Edition license.">' +
        'xref:get-started:licensing/overview.adoc[Continuous Data Balancing]</span>'
      )
    })

    test('links to the feature doc when an xref attribute is given', () => {
      const html = buildEnterpriseContent({
        ...defaults,
        feature: 'Tiered Storage',
        xref: 'manage:tiered-storage.adoc',
      })
      expect(html).toContain('xref:manage:tiered-storage.adoc[Tiered Storage]')
    })

    test('links to an absolute URL when only a url is given', () => {
      const html = buildEnterpriseContent({
        ...defaults,
        feature: 'Enterprise connectors',
        url: 'https://docs.redpanda.com/redpanda-connect/components/catalog/?support=enterprise',
      })
      expect(html).toContain('link:https://docs.redpanda.com/redpanda-connect/components/catalog/?support=enterprise[Enterprise connectors]')
    })

    test('honors display text and tooltip overrides', () => {
      const html = buildEnterpriseContent({
        ...defaults,
        feature: 'Audit Logging',
        text: 'audit logging',
        tooltip: 'Audit Logging needs a license and a SASL listener.',
      })
      expect(html).toContain('[audit logging]')
      expect(html).toContain('title="Audit Logging needs a license and a SASL listener."')
    })

    test('escapes double quotes in tooltip text', () => {
      const html = buildEnterpriseContent({
        ...defaults,
        feature: 'X',
        tooltip: 'Requires a "valid" license.',
      })
      expect(html).toContain('title="Requires a &quot;valid&quot; license."')
    })

    test('renders plain text without a link when links are disabled', () => {
      const html = buildEnterpriseContent({ ...defaults, feature: 'Shadowing', links: false })
      expect(html).not.toContain('xref:')
      expect(html).toContain('>Shadowing</span>')
    })

    test('omits the tooltip when disabled', () => {
      const html = buildEnterpriseContent({ ...defaults, feature: 'Shadowing', tooltipAttr: undefined })
      expect(html).not.toContain('title=')
    })
  })

  describe('resolveTooltipAttribute', () => {
    test.each([
      [undefined, 'title'],
      ['title', 'title'],
      ['true', 'data-enterprise-tooltip'],
      ['data-tooltip', 'data-tooltip'],
      ['false', undefined],
    ])('%s resolves to %s', (input, expected) => {
      expect(resolveTooltipAttribute(input)).toBe(expected)
    })

    test('falls back to title for invalid values', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      expect(resolveTooltipAttribute('sparkles')).toBe('title')
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  describe('parseRegistry', () => {
    test('indexes features by lowercased name and alias', () => {
      const { lookup } = parseRegistry(REGISTRY_YAML)
      expect(lookup.get('tiered storage').name).toBe('Tiered Storage')
      expect(lookup.get('cloud_storage').name).toBe('Tiered Storage')
    })

    test('throws on duplicate names across entries', () => {
      const dup = `${REGISTRY_YAML}\n  - name: tiered storage\n    scope: redpanda\n`
      expect(() => parseRegistry(dup)).toThrow(/Duplicate enterprise feature name 'tiered storage'/)
    })

    test('throws on an alias that collides with another feature', () => {
      const dup = `${REGISTRY_YAML}\n  - name: Object Storage Mode\n    scope: redpanda\n    aliases: [Tiered Storage]\n`
      expect(() => parseRegistry(dup)).toThrow(/Duplicate enterprise feature alias/)
    })

    test('throws on unknown scope', () => {
      expect(() => parseRegistry('features:\n  - name: X\n    scope: mainframe\n')).toThrow(/unknown scope 'mainframe'/)
    })

    test('throws when the features list is missing', () => {
      expect(() => parseRegistry('schema-version: 1\n')).toThrow(/no 'features' list/)
    })

    // Invalid YAML used to escape as the raw js-yaml message, which names no
    // file, so the caller had to prefix a path -- and then printed it twice for
    // the four throws above, which name the file themselves.
    test('names the file when the YAML itself is invalid', () => {
      expect(() => parseRegistry('features: [oops\n', 'shared/enterprise-features.yml'))
        .toThrow(/registry shared\/enterprise-features\.yml is not valid YAML/)
    })

    test('every failure names the file exactly once', () => {
      const origin = 'shared/modules/ROOT/partials/enterprise-features.yml'
      const broken = [
        'features: [oops\n',
        'schema-version: 1\n',
        'features:\n  - description: x\n',
        'features:\n  - name: A\n    scope: nonsense\n',
        'features:\n  - name: A\n    aliases: [dup]\n  - name: B\n    aliases: [dup]\n',
      ]
      for (const source of broken) {
        let message = ''
        try {
          parseRegistry(source, origin)
        } catch (error) {
          message = error.message
        }
        expect(message).toContain(origin)
        expect(message.split(origin).length - 1).toBe(1)
        // "could not be read" was inaccurate for everything but invalid YAML.
        expect(message).not.toMatch(/could not be read/)
      }
    })
  })

  describe('buildFeatureTable', () => {
    const { features } = parseRegistry(REGISTRY_YAML)

    test('renders scope rows alphabetically with the scope heading', () => {
      const table = buildFeatureTable(features, 'redpanda')
      expect(table).toContain('.Enterprise features in Redpanda')
      expect(table).toContain('| Feature | Description | Behavior Upon Expiration')
      expect(table.indexOf('Tiered Storage')).toBeLessThan(table.indexOf('Topic Deletion Control'))
      expect(table).toContain('| xref:manage:tiered-storage.adoc[Tiered Storage]')
    })

    test('renders a plain name when the entry has no xref, plus its gating property', () => {
      const table = buildFeatureTable(features, 'redpanda')
      expect(table).toContain('| Topic Deletion Control\n(`delete_topic_enable`)')
    })

    test('renders url links and the non-redpanda third-column heading', () => {
      const table = buildFeatureTable(features, 'connect')
      expect(table).toContain('| Feature | Description | Restrictions Without Valid License')
      expect(table).toContain('link:https://docs.redpanda.com/redpanda-connect/components/catalog/?support=enterprise[Enterprise connectors]')
      expect(table).not.toContain('Tiered Storage')
    })

    test('appends the feature suffix after the feature link', () => {
      const table = buildFeatureTable(features, 'operator')
      expect(table).toContain('xref:deploy:redpanda/kubernetes/k-stretch-clusters.adoc[Stretch Clusters] (StretchCluster resource)')
    })

    test('honors title and heading overrides', () => {
      const table = buildFeatureTable(features, 'connect', { title: 'My Title', heading: 'My Heading' })
      expect(table).toContain('.My Title')
      expect(table).toContain('| Feature | Description | My Heading')
    })

    // A registry entry used to flag beta by embedding a badge macro call in
    // feature-suffix, which rendered as the literal text 'badge::[label=beta]'
    // in any build that did not register the badge macro. The badge is now
    // derived from `beta: true` and emitted as a passthrough, so it does not
    // depend on that registration.
    test('renders a beta badge for entries marked beta', () => {
      const table = buildFeatureTable(features, 'operator')
      expect(table).toContain('pass:[<span class="badge badge--beta ">(beta)</span>]')
      expect(table).not.toContain('badge::[')
      expect(table).not.toContain('badge:[label')
    })

    // The label lands in the class attribute and in the text content, so it
    // needs escaping as much as the tooltip does. Escaping only the tooltip left
    // a label free to close the class attribute and add an event handler.
    test('a hostile badge label cannot escape the class attribute', () => {
      const { buildBadgeHtml } = require('../../macros/badge')
      const html = buildBadgeHtml({ label: 'x" onmouseover="alert(1)', tooltip: 'safe' })
      expect(html).not.toContain('onmouseover="alert(1)"')
      expect(html).toContain('&quot;')
      const withTag = buildBadgeHtml({ label: '<img src=x onerror=alert(1)>' })
      expect(withTag).not.toContain('<img')
      expect(withTag).toContain('&lt;img')
      // Ordinary labels are untouched.
      expect(buildBadgeHtml({ label: 'beta', tooltip: 'Beta feature' }))
        .toBe('<span class="badge badge--beta " data-tooltip="Beta feature">(beta)</span>')
    })

    test('places the beta badge after the feature suffix', () => {
      const table = buildFeatureTable(features, 'operator')
      expect(table).toContain(
        'xref:deploy:redpanda/kubernetes/k-stretch-clusters.adoc[Stretch Clusters] ' +
        '(StretchCluster resource) pass:[<span class="badge badge--beta ">(beta)</span>]'
      )
    })

    test('omits the badge for entries that are not beta', () => {
      const table = buildFeatureTable(features, 'connect')
      expect(table).not.toContain('badge--beta')
    })
  })

  describe('registry-backed conversion', () => {
    test('canonicalizes an alias and links to the registry xref', () => {
      const html = convert('enterprise:cloud_storage[]', { catalog: fakeCatalog() })
      expect(html).toContain('Tiered Storage')
      expect(html).toContain('tiered-storage')
      expect(html).toContain('class="enterprise-feature"')
    })

    test('adds the beta badge in prose for a feature marked beta', () => {
      const html = convert('enterprise:Stretch Clusters[]', { catalog: fakeCatalog() })
      expect(html).toContain('class="enterprise-feature"')
      expect(html).toContain('class="badge badge--beta ">(beta)</span>')
      // The badge must be real markup, never the escaped source of a macro call.
      expect(html).not.toContain('badge::[')
      expect(html).not.toContain('&lt;span')
    })

    test('leaves prose for a non-beta feature unbadged', () => {
      const html = convert('enterprise:Tiered Storage[]', { catalog: fakeCatalog() })
      expect(html).not.toContain('badge--beta')
    })

    test('enterprise-beta-badge=false suppresses the badge in prose', () => {
      const html = convert('enterprise:Stretch Clusters[]', {
        catalog: fakeCatalog(),
        attributes: { 'enterprise-beta-badge': 'false' },
      })
      expect(html).toContain('class="enterprise-feature"')
      expect(html).not.toContain('badge--beta')
    })

    test('canonicalizes case-insensitive spellings of the name', () => {
      const html = convert('enterprise:tiered storage[]', { catalog: fakeCatalog() })
      expect(html).toContain('Tiered Storage requires an Enterprise Edition license.')
    })

    test('per-use xref overrides the registry xref', () => {
      const html = convert('enterprise:Tiered Storage[xref=other:page.adoc]', { catalog: fakeCatalog() })
      expect(html).toContain('other')
      expect(html).not.toContain('manage:tiered-storage.adoc')
    })

    test('warns on unknown feature names by default', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const html = convert('enterprise:Warp Drive[]', { catalog: fakeCatalog() })
      expect(html).toContain('Warp Drive')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not match any feature'))
      warn.mockRestore()
    })

    test('fails the conversion in error mode', () => {
      expect(() => convert('enterprise:Warp Drive[]', {
        catalog: fakeCatalog(),
        attributes: { 'enterprise-validate': 'error' },
      })).toThrow(/does not match any feature/)
    })

    test('stays silent in off mode', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      convert('enterprise:Warp Drive[]', {
        catalog: fakeCatalog(),
        attributes: { 'enterprise-validate': 'off' },
      })
      const validationWarnings = warn.mock.calls.filter(([msg]) => String(msg).includes('does not match'))
      expect(validationWarnings).toHaveLength(0)
      warn.mockRestore()
    })

    test('suggests close names in the warning', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      convert('enterprise:Tiered Storage Cache[]', { catalog: fakeCatalog() })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Did you mean: Tiered Storage'))
      warn.mockRestore()
    })

    test('caches the registry on the content catalog across conversions', () => {
      const catalog = fakeCatalog()
      convert('enterprise:Tiered Storage[]', { catalog })
      convert('enterprise:Tiered Storage[]', { catalog })
      expect(catalog.findBy).toHaveBeenCalledTimes(1)
    })

    test('renders unvalidated without a catalog (graceful degradation)', () => {
      const html = convert('enterprise:Anything Goes[]', {})
      expect(html).toContain('Anything Goes')
      expect(html).toContain('class="enterprise-feature"')
    })

    test('renders the feature table through the block macro', () => {
      const html = convert('enterprise_features::redpanda[]', { catalog: fakeCatalog() })
      expect(html).toContain('Enterprise features in Redpanda')
      expect(html).toContain('Behavior Upon Expiration')
      expect(html).toContain('Tiered Storage')
      expect(html).toContain('Topic Deletion Control')
    })

    test('uses the Kubernetes feature page when env-kubernetes is set', () => {
      const html = convert('enterprise:Tiered Storage[]', {
        catalog: fakeCatalog(),
        attributes: { 'env-kubernetes': '' },
      })
      expect(html).toContain('k-tiered-storage')
    })

    test('uses the Cloud feature page when env-cloud is set', () => {
      const html = convert('enterprise:Tiered Storage[]', {
        catalog: fakeCatalog(),
        attributes: { 'env-cloud': '' },
      })
      expect(html).toContain('cloud-data-platform')
    })

    test('falls back to the default xref without env attributes', () => {
      const html = convert('enterprise:Tiered Storage[]', { catalog: fakeCatalog() })
      expect(html).not.toContain('k-tiered-storage')
      expect(html).not.toContain('cloud-data-platform')
      expect(html).toContain('tiered-storage')
    })

    test('re-emits a block anchor as the table id and resolves crossrefs to it', () => {
      const html = convert('[[my-table]]\nenterprise_features::redpanda[]\n\nSee <<my-table,the table>>.', { catalog: fakeCatalog() })
      expect(html).toContain('id="my-table"')
      expect(html).toContain('href="#my-table"')
      expect(html).not.toContain('[my-table]')
    })

    test('rejects an unknown scope on the block macro', () => {
      expect(() => convert('enterprise_features::mainframe[]', { catalog: fakeCatalog() }))
        .toThrow(/needs a scope/)
    })

    test('renders a warning admonition when the registry is missing', () => {
      const emptyCatalog = { findBy: jest.fn(() => []) }
      const html = convert('enterprise_features::redpanda[]', { catalog: emptyCatalog })
      expect(html).toContain('cannot be rendered')
    })
  })

  describe('registration', () => {
    test('registers inline and block macros on a plain registry', () => {
      const inlineMacro = jest.fn()
      const blockMacro = jest.fn()
      register({ inlineMacro, blockMacro })
      expect(inlineMacro).toHaveBeenCalledTimes(1)
      expect(blockMacro).toHaveBeenCalledTimes(1)
      expect(typeof inlineMacro.mock.calls[0][0]).toBe('function')
    })

    test('uses the group form when the registry supports register()', () => {
      const inlineMacro = jest.fn()
      const blockMacro = jest.fn()
      const registry = {
        register (group) {
          group.call({ inlineMacro, blockMacro })
        },
      }
      register(registry)
      expect(inlineMacro).toHaveBeenCalledTimes(1)
      expect(blockMacro).toHaveBeenCalledTimes(1)
    })
  })
})
