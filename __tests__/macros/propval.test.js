'use strict'

// Same mocked logger as prop.test.js: the macro logs through @antora/logger.
jest.mock('@antora/logger', () => {
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const getLogger = () => logger
  getLogger.configure = () => getLogger
  return getLogger
})

const fs = require('fs')
const path = require('path')
const handlebars = require('handlebars')
const { register, buildPropvalContent } = require('../../macros/prop')
const {
  fieldValue,
  humanizeDuration,
  humanizeBytes,
  normalizeField,
} = require('../../extension-utils/property-values')

// Real entries copied from redpanda-properties-v26.2.4.json in the docs repo.
const SAMPLE_PATH = path.join(__dirname, '..', 'fixtures', 'propval', 'redpanda-properties-v26.2.4-sample.json')
const SAMPLE = JSON.parse(fs.readFileSync(SAMPLE_PATH, 'utf8'))
const SAMPLE_JSON = JSON.stringify(SAMPLE)

function attachment (component, version, tag, json = SAMPLE_JSON) {
  return {
    src: { component, version, module: 'reference', family: 'attachment', relative: `redpanda-properties-${tag}.json` },
    contents: Buffer.from(json),
  }
}

function catalogOf (files, components = {}) {
  const names = new Set([...files.map((f) => f.src.component), ...Object.keys(components)])
  return {
    findBy: (query) => files.filter((file) => Object.entries(query).every(([key, value]) => file.src[key] === value)),
    getComponent: (name) => {
      if (!names.has(name)) return undefined
      const attributes = components[name] || {}
      const versions = [...new Set(files.filter((f) => f.src.component === name).map((f) => f.src.version))]
        .sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }))
        .map((v) => ({ version: v, asciidoc: { attributes } }))
      if (!versions.length) versions.push({ version: '', asciidoc: { attributes } })
      return { name, versions, latest: versions[versions.length - 1] }
    },
  }
}

function convert (input, { catalog, attributes = {}, component = 'streaming', version = '26.2' } = {}) {
  const Asciidoctor = require('@asciidoctor/core')()
  const registry = Asciidoctor.Extensions.create()
  register(registry, catalog && {
    contentCatalog: catalog,
    file: { src: { path: 'modules/manage/pages/example.adoc', component, version, module: 'manage' } },
  })
  return Asciidoctor.convert(input, { extension_registry: registry, attributes })
}

// The rendered value of the first propval: span, as text.
const valueOf = (html) => {
  const match = html.match(/<span class="property-value[^"]*"[^>]*>([\s\S]*?)<\/span>/)
  return match && match[1].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

const warnings = () => jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})

describe('propval macro', () => {
  afterEach(() => jest.restoreAllMocks())
  const streaming = () => catalogOf([attachment('streaming', '26.2', 'v26.2.4')])

  describe('rendering', () => {
    test('renders a human-readable default as plain text with a stable class', () => {
      const html = convert('Defaults to propval:log_segment_ms[default].', { catalog: streaming() })
      expect(html).toContain('<span class="property-value" data-property="log_segment_ms" data-field="default">2 weeks</span>')
      // Plain text: no code element, no tooltip marker.
      expect(html).not.toContain('data-property-name')
      expect(html).not.toContain('<code')
    })

    test('the field defaults to default', () => {
      expect(valueOf(convert('propval:log_segment_ms[]', { catalog: streaming() }))).toBe('2 weeks')
    })

    test('format=raw gives the exact value', () => {
      expect(valueOf(convert('propval:log_segment_ms[default,format=raw]', { catalog: streaming() }))).toBe('1209600000')
    })

    test.each([
      ['propval:log_segment_ms[min]', '1 minute'],
      ['propval:log_segment_ms[min,format=raw]', '60000'],
      ['propval:log_segment_ms[unit]', 'milliseconds'],
      ['propval:log_segment_ms[type]', 'integer'],
      ['propval:log_segment_ms[scope]', 'cluster'],
      ['propval:log_segment_ms[visibility]', 'user'],
      ['propval:log_segment_ms[restored]', 'yes'],
      ['propval:log_segment_ms[nullable]', 'yes'],
      ['propval:log_segment_ms[cloud-access]', 'read-only'],
      ['propval:cloud_storage_enabled[restart]', 'yes'],
      ['propval:cloud_storage_enabled[restart,format=raw]', 'true'],
      ['propval:log_segment_size[restart]', 'no'],
      ['propval:fetch_max_bytes[default]', '55 MiB'],
      ['propval:fetch_max_bytes[unit]', 'bytes'],
      ['propval:log_cleanup_policy[values]', 'none, delete, compact, compact,delete'],
      ['propval:log_cleanup_policy[enum]', 'none, delete, compact, compact,delete'],
      ['propval:write_caching_default[default]', 'false'],
      ['propval:node_id[default]', 'null'],
      ['propval:cloud_storage_enabled[default]', 'false'],
      ['propval:default_topic_replications[minimum]', '1'],
    ])('%s renders %s', (input, expected) => {
      expect(valueOf(convert(input, { catalog: streaming() }))).toBe(expected)
    })

    test('enum values render as separate code elements so commas stay unambiguous', () => {
      const html = convert('propval:log_cleanup_policy[values]', { catalog: streaming() })
      expect(html).toContain('<code>compact,delete</code>')
    })

    test('works inside a monospace span', () => {
      const html = convert('`propval:log_segment_ms[default,format=raw]`', { catalog: streaming() })
      expect(html).toMatch(/<code><span class="property-value"[^>]*>1209600000<\/span><\/code>/)
    })

    test('escapes values and attributes', () => {
      expect(buildPropvalContent({ name: 'a"b', field: 'default', text: '<x>' }))
        .toBe('<span class="property-value" data-property="a&quot;b" data-field="default">&lt;x&gt;</span>')
    })

    test('an unsupported format warns and falls back to the human-readable value', () => {
      const warn = warnings()
      expect(valueOf(convert('propval:log_segment_ms[default,format=fancy]', { catalog: streaming() }))).toBe('2 weeks')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('format=fancy is not supported'))
    })
  })

  describe('version selection (same rules as prop:)', () => {
    const json = (value) => JSON.stringify({ properties: { log_segment_size: { name: 'log_segment_size', config_scope: 'cluster', type: 'integer', default: value } } })

    test('main: a 26.2 page reads the newest 26.2 patch, not a neighbouring series', () => {
      const catalog = catalogOf([
        attachment('streaming', '26.2', 'v26.2.1', json(1)),
        attachment('streaming', '26.2', 'v26.2.4', json(4)),
        attachment('streaming', '26.2', 'v26.1.14', json(114)),
      ])
      expect(valueOf(convert('propval:log_segment_size[]', { catalog, version: '26.2' }))).toBe('4')
    })

    test('a v/* branch reads its own series', () => {
      const catalog = catalogOf([
        attachment('streaming', '26.2', 'v26.2.4', json(4)),
        attachment('streaming', '25.3', 'v25.3.11', json(311)),
      ])
      expect(valueOf(convert('propval:log_segment_size[]', { catalog, version: '25.3' }))).toBe('311')
      expect(valueOf(convert('propval:log_segment_size[]', { catalog, version: '26.2' }))).toBe('4')
    })

    test('a prerelease branch reads the newest RC of its series, and GA beats its RCs', () => {
      const rcs = catalogOf([
        attachment('streaming', '26.3', 'v26.3.1-rc1', json(1)),
        attachment('streaming', '26.3', 'v26.3.1-rc2', json(2)),
        attachment('streaming', '26.2', 'v26.2.4', json(4)),
      ])
      expect(valueOf(convert('propval:log_segment_size[]', { catalog: rcs, version: '26.3' }))).toBe('2')
      const ga = catalogOf([
        attachment('streaming', '26.3', 'v26.3.1-rc2', json(2)),
        attachment('streaming', '26.3', 'v26.3.1', json(10)),
      ])
      expect(valueOf(convert('propval:log_segment_size[]', { catalog: ga, version: '26.3' }))).toBe('10')
    })

    test('a missing dataset renders the placeholder and never borrows another release', () => {
      const warn = warnings()
      const catalog = catalogOf([attachment('streaming', '26.2', 'v26.2.4', json(4))])
      const html = convert('propval:log_segment_size[]', { catalog, version: '26.3' })
      expect(valueOf(html)).toBe('<unknown default>')
      expect(html).toContain('property-value-unknown')
      expect(html).not.toContain('>4<')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('publishes no redpanda-properties-v26.3.*.json'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('this page has no property data'))
    })

    test('no catalog at all renders the placeholder with a warning', () => {
      const warn = warnings()
      expect(valueOf(convert('propval:log_segment_size[]', {}))).toBe('<unknown default>')
      expect(warn).toHaveBeenCalled()
    })

    test('a component with no property data renders the placeholder', () => {
      const warn = warnings()
      const catalog = catalogOf([attachment('streaming', '26.2', 'v26.2.4')], { connect: {} })
      expect(valueOf(convert('propval:log_segment_ms[]', { catalog, component: 'connect', version: '4.50' }))).toBe('<unknown default>')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no redpanda-properties-<tag>.json attachment found'))
    })
  })

  describe('Cloud', () => {
    const cloud = () => catalogOf([
      attachment('streaming', '26.2', 'v26.2.4'),
      attachment('streaming', '26.3', 'v26.3.1-rc1', JSON.stringify({ properties: { log_segment_ms: { name: 'log_segment_ms', config_scope: 'cluster', cloud_supported: true, cloud_readonly: false, cloud_editable: true, minimum: 1 } } })),
    ], { 'cloud-data-platform': { 'env-cloud': true } })
    const onCloud = (input) => convert(input, { catalog: cloud(), component: 'cloud-data-platform', version: '' })

    test('reads the newest GA data, never a release candidate', () => {
      expect(valueOf(onCloud('propval:log_segment_ms[min]'))).toBe('1 minute')
      expect(valueOf(onCloud('propval:log_segment_ms[cloud-access]'))).toBe('read-only')
    })

    test('a cluster property with cloud_supported: false renders the placeholder', () => {
      const warn = warnings()
      expect(valueOf(onCloud('propval:log_segment_size[min]'))).toBe('<unknown min>')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cloud_supported: false'))
    })

    test('defaults are not stated on Cloud, matching the Cloud property reference', () => {
      const warn = warnings()
      expect(valueOf(onCloud('propval:log_segment_ms[default]'))).toBe('<unknown default>')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ifndef::env-cloud[]'))
    })

    test('topic properties are not gated by cloud_supported', () => {
      expect(valueOf(onCloud('propval:retention.ms[type]'))).toBe('integer')
    })

    test('introduced is not stated on Cloud, matching the Cloud property reference', () => {
      const json = JSON.stringify({ properties: { new_prop: { name: 'new_prop', config_scope: 'cluster', cloud_supported: true, version: 'v26.2.1' } } })
      const catalog = catalogOf([attachment('streaming', '26.2', 'v26.2.4', json)], { 'cloud-data-platform': { 'env-cloud': true } })
      const warn = warnings()
      expect(valueOf(convert('propval:new_prop[introduced]', { catalog, component: 'cloud-data-platform', version: '' }))).toBe('<unknown introduced>')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("does not state 'introduced' for Cloud"))
      expect(valueOf(convert('propval:new_prop[introduced]', { catalog }))).toBe('v26.2.1')
    })

    test('error mode fails the Cloud build on cloud-hidden fields and unavailable properties', () => {
      const attributes = { 'property-validate': 'error' }
      const onCloudStrict = (input) => convert(input, { catalog: cloud(), component: 'cloud-data-platform', version: '', attributes })
      expect(() => onCloudStrict('propval:log_segment_ms[default]')).toThrow(/does not state 'default' for Cloud/)
      expect(() => onCloudStrict('propval:log_segment_size[min]')).toThrow(/cloud_supported: false/)
      expect(valueOf(onCloudStrict('propval:log_segment_ms[min]'))).toBe('1 minute')
    })
  })

  describe('failures', () => {
    test('an unknown property warns with the dataset and renders the placeholder', () => {
      const warn = warnings()
      expect(valueOf(convert('propval:log_segment_mss[]', { catalog: streaming() }))).toBe('<unknown default>')
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/propval:log_segment_mss\[default\] in modules\/manage\/pages\/example\.adoc: .*redpanda-properties-v26\.2\.4\.json from streaming@26\.2/))
    })

    test('a field the property does not have warns naming property, field and dataset', () => {
      const warn = warnings()
      expect(valueOf(convert('propval:log_segment_size[max]', { catalog: streaming() }))).toBe('<unknown max>')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'log_segment_size' has no max in redpanda-properties-v26.2.4.json from streaming@26.2"))
    })

    test('an unsupported field warns and lists the supported ones', () => {
      const warn = warnings()
      expect(valueOf(convert('propval:log_segment_ms[colour]', { catalog: streaming() }))).toBe('<unknown colour>')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Supported fields: default, type'))
    })

    test('error mode fails the build on authoring errors', () => {
      const attributes = { 'property-validate': 'error' }
      expect(() => convert('propval:nope_nope[]', { catalog: streaming(), attributes })).toThrow(/not in the property data/)
      expect(() => convert('propval:log_segment_size[max]', { catalog: streaming(), attributes })).toThrow(/has no max/)
      expect(() => convert('propval:log_segment_size[colour]', { catalog: streaming(), attributes })).toThrow(/not a field/)
    })

    test('off mode still reports a placeholder, because a value has no safe fallback', () => {
      const warn = warnings()
      const html = convert('propval:nope_nope[]', { catalog: streaming(), attributes: { 'property-validate': 'off' } })
      expect(valueOf(html)).toBe('<unknown default>')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('propval:nope_nope[default]'))
    })

    test('a deprecated property with no default in the data renders the placeholder, not a guess', () => {
      const warn = warnings()
      expect(valueOf(convert('propval:coproc_supervisor_server[]', { catalog: streaming() }))).toBe('<unknown default>')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no default'))
    })

    test('an integer beyond the exact JavaScript range renders the placeholder', () => {
      const warn = warnings()
      expect(valueOf(convert('propval:virtual_cluster_min_producer_ids[]', { catalog: streaming() }))).toBe('<unknown default>')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('larger than JavaScript represents exactly'))
    })

    test('inherited object keys are not properties', () => {
      warnings()
      expect(valueOf(convert('propval:constructor[]', { catalog: streaming() }))).toBe('<unknown default>')
    })
  })

  describe('formatting', () => {
    test.each([
      [1209600000, 'milliseconds', '2 weeks'],
      [60000, 'milliseconds', '1 minute'],
      [1500, 'milliseconds', '1500 milliseconds'],
      [150, 'milliseconds', '150 milliseconds'],
      [0, 'milliseconds', '0 milliseconds'],
      [60, 'seconds', '1 minute'],
      [86400, 'seconds', '1 day'],
      [31536000000, 'milliseconds', '1 year'],
    ])('humanizeDuration(%p, %s) is %s', (value, unit, expected) => {
      expect(humanizeDuration(value, unit)).toBe(expected)
    })

    test.each([
      [134217728, '128 MiB'],
      [1073741824, '1 GiB'],
      [5368709120, '5 GiB'],
      [512000, '500 KiB'],
      [1000, '1000 bytes'],
      [1, '1 byte'],
      [0, '0 bytes'],
    ])('humanizeBytes(%p) is %s', (value, expected) => {
      expect(humanizeBytes(value)).toBe(expected)
    })

    test('bytes are humanized only where the reference table says the unit is bytes', () => {
      // fetch_max_bytes: the table's Unit row says Bytes (from the name).
      expect(fieldValue(SAMPLE.properties.fetch_max_bytes, 'default').text).toBe('55 MiB')
      // log_segment_size and segment.bytes: no unit in the data or the table,
      // so the exact number renders rather than a guessed unit.
      expect(fieldValue(SAMPLE.properties.log_segment_size, 'default').text).toBe('134217728')
      expect(fieldValue(SAMPLE.properties['segment.bytes'], 'default').text).toBe('134217728')
    })

    test('booleans, enums, null, floats, lists and objects', () => {
      const p = SAMPLE.properties
      expect(fieldValue(p.cloud_storage_enabled, 'default').text).toBe('false')
      expect(fieldValue(p.log_cleanup_policy, 'default').text).toBe('delete')
      expect(fieldValue(p.node_id, 'default').text).toBe('null')
      expect(fieldValue(p.min_cleanable_dirty_ratio, 'default').text).toBe('0.5')
      expect(fieldValue(p.kafka_api, 'default').text).toBe('[{address: "127.0.0.1", name: "", port: 9092}]')
      // An empty-string default renders as the table renders it.
      expect(fieldValue(p.sasl_mechanism, 'default').text).toBe('null')
    })

    test('negative sentinels render as written', () => {
      expect(fieldValue({ name: 'retention_bytes', default: -1 }, 'default').text).toBe('-1')
    })

    test('field aliases resolve to the canonical field', () => {
      expect(normalizeField('minimum')).toBe('min')
      expect(normalizeField('needs_restart')).toBe('restart')
      expect(normalizeField('Default')).toBe('default')
      expect(normalizeField('bogus')).toBeUndefined()
    })
  })

  describe('shared fields and text values', () => {
    const cloud = () => catalogOf([attachment('streaming', '26.2', 'v26.2.4')], { 'cloud-data-platform': { 'env-cloud': true } })
    const onCloud = (input, opts = {}) => convert(input, { catalog: cloud(), component: 'cloud-data-platform', version: '', ...opts })

    test.each([
      ['propval:cloud_storage_enabled[enterprise]', 'yes'],
      ['propval:cloud_storage_enabled[is_enterprise,format=raw]', 'true'],
      ['propval:log_segment_ms[deprecated]', 'no'],
      ['propval:cloud_storage_enabled[secret]', 'no'],
      ['propval:log_segment_ms[category]', 'other'],
      ['propval:cleanup.policy[options]', 'none, delete, compact, compact,delete'],
    ])('%s renders %s', (input, expected) => {
      expect(valueOf(convert(input, { catalog: streaming() }))).toBe(expected)
    })

    test('since is introduced: the shared alias reaches the same field', () => {
      warnings()
      expect(convert('propval:log_segment_ms[since]', { catalog: streaming() })).toContain('data-field="introduced">&lt;unknown introduced&gt;')
    })

    test('a one-paragraph description renders inline, with its AsciiDoc markup', () => {
      const html = convert('propval:log_segment_ms[description]', { catalog: streaming() })
      expect(html).toContain('<span class="property-value" data-property="log_segment_ms" data-field="description">Default lifetime of log segments. If <code>null</code>, the property is disabled')
    })

    test('a one-line example renders inline as the reference renders it', () => {
      expect(convert('propval:enable_transactions[example]', { catalog: streaming() })).toContain('data-field="examples"><code>false</code></span>')
    })

    test('a description longer than one paragraph warns, names the block form, and renders the placeholder', () => {
      const warn = warnings()
      expect(valueOf(convert('propval:cleanup.policy[description]', { catalog: streaming() }))).toBe('<unknown description>')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Use the block form on a line of its own: propval::cleanup.policy[description].'))
    })

    test('the block form parses the description into the page', () => {
      const html = convert('propval::cleanup.policy[description]', { catalog: streaming() })
      expect(html).toContain('<div class="openblock property-value property-value-description">')
      expect(html).toContain('<li>\n<p><code>none</code> - No cleanup runs.')
    })

    test('the block form parses an example with a listing', () => {
      const html = convert('propval::kafka_api[examples]', { catalog: streaming() })
      expect(html).toContain('<div class="title">Basic example</div>')
      expect(html).toContain('<code class="language-yaml" data-lang="yaml">redpanda:')
    })

    test('the block form of a short field is a paragraph with the value', () => {
      expect(convert('propval::log_segment_ms[default]', { catalog: streaming() })).toContain('<p><span class="property-value" data-property="log_segment_ms" data-field="default">2 weeks</span></p>')
    })

    test('see-also has the items for the page\'s surface only', () => {
      const html = convert('propval:write_caching_default[see-also]', { catalog: streaming() })
      expect(html).toContain('href="reference:properties/topic-properties.html#write-caching"><code>write.caching</code></a>, <a href="develop:manage-topics/config-topics.html#configure-write-caching">Write caching</a>')
      expect(valueOf(convert('propval:log_segment_ms[see-also]', { catalog: streaming() }))).toBe('segment.ms')
      warnings()
      // log_segment_ms has only a self_managed_only item.
      expect(valueOf(onCloud('propval:log_segment_ms[see-also]'))).toBe('<unknown see-also>')
    })

    test('the block form of see-also is a list', () => {
      const html = convert('propval::cleanup.policy[see_also]', { catalog: streaming() })
      expect(html).toContain('<div class="openblock property-value property-value-see-also">')
      expect((html.match(/<li>/g) || []).length).toBe(3)
    })

    test('enterprise is hidden on Cloud, where the reference shows no license note', () => {
      const warn = warnings()
      expect(valueOf(convert('propval:http_authentication[enterprise]', { catalog: streaming() }))).toBe('yes')
      expect(valueOf(onCloud('propval:http_authentication[enterprise]'))).toBe('<unknown enterprise>')
      expect(warn.mock.calls[0][0]).toContain("the property reference does not state 'enterprise' for Cloud")
    })

    test('the block form inside a sentence is an error in error mode', () => {
      const warn = warnings()
      expect(valueOf(convert('See propval::cleanup.policy[description] here.', { catalog: streaming() }))).toBe('<unknown description>')
      expect(warn.mock.calls[0][0]).toContain('propval:: is the block form')
      expect(() => convert('See propval::cleanup.policy[description] here.', { catalog: streaming(), attributes: { 'property-validate': 'error' } })).toThrow(/block form/)
    })

    test('needs-block fails the build in error mode', () => {
      expect(() => convert('propval:cleanup.policy[description]', { catalog: streaming(), attributes: { 'property-validate': 'error' } })).toThrow(/block form/)
    })

    test('an unknown field in the block form warns with the supported fields', () => {
      const warn = warnings()
      expect(convert('propval::log_segment_ms[colour]', { catalog: streaming() })).toContain('property-value-unknown')
      expect(warn.mock.calls[0][0]).toContain("propval::log_segment_ms[colour] in modules/manage/pages/example.adoc: 'colour' is not a field propval: supports. Supported fields: default, type,")
    })
  })

  describe('agreement with the property reference', () => {
    // Render the reference generator's own template for each sample property
    // and check propval: produces exactly its Default cell: the code value for
    // format=raw, the parenthetical (when the table has one) for the default
    // human format.
    const hb = handlebars.create()
    for (const [name, fn] of Object.entries(require('../../tools/property-extractor/helpers'))) hb.registerHelper(name, fn)
    const template = hb.compile(fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'property-extractor', 'templates', 'property.hbs'), 'utf8'))
    const defaultCell = (entry) => {
      const lines = template(entry).split('\n')
      const at = lines.indexOf('| Default')
      const value = lines.slice(at + 1).find((line) => line.startsWith('`'))
      const match = value.match(/^`(.*)`(?: \((.*)\))?$/)
      return { raw: match[1], human: match[2] }
    }
    const sampled = Object.keys(SAMPLE.properties).filter((name) =>
      Object.prototype.hasOwnProperty.call(SAMPLE.properties[name], 'default') &&
      !(Number.isInteger(SAMPLE.properties[name].default) && !Number.isSafeInteger(SAMPLE.properties[name].default)))

    test('the sample covers a useful spread of properties', () => {
      expect(sampled.length).toBeGreaterThanOrEqual(15)
    })

    test.each(sampled)('%s', (name) => {
      const entry = SAMPLE.properties[name]
      const cell = defaultCell(entry)
      const html = convert(`propval:${name}[default,format=raw]`, { catalog: streaming() })
      expect(valueOf(html)).toBe(cell.raw)
      if (cell.human) expect(valueOf(convert(`propval:${name}[default]`, { catalog: streaming() }))).toBe(cell.human)
    })
  })
})
