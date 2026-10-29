'use strict'

jest.mock('@antora/logger', () => {
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const getLogger = () => logger
  getLogger.configure = () => getLogger
  return getLogger
})

const fs = require('fs')
const path = require('path')
const { register } = require('../../macros/prop')
const { THROW_KINDS } = require('../../macros/connectval')
const connectValues = require('../../extension-utils/connect-values')
const renderConnectFields = require('../../tools/redpanda-connect/helpers/renderConnectFields')

// Real data: rp-connect-docs af33755 connect-4.114.0.json, trimmed, and the
// translated csvData rows for the same components from connect's info.csv
// (see _source in each file).
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'connectval')
const SAMPLE = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'connect-4.114.0-sample.json'), 'utf8'))
const CSV = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'csvdata-sample.json'), 'utf8')).data
const clone = (value) => JSON.parse(JSON.stringify(value))

function attachment (tag, data = SAMPLE) {
  return {
    src: { component: 'connect', version: '', module: 'components', family: 'attachment', relative: `connect-${tag}.json` },
    contents: Buffer.from(JSON.stringify(data)),
  }
}

// A catalog with the connect component (unversioned) plus any page
// components. connectAttributes become the connect latest version's
// attributes, where generate-rp-connect-info puts csvData.
function catalogOf (files, { components = {}, connectAttributes = {} } = {}) {
  const all = { ...components }
  if (files.some((f) => f.src.component === 'connect')) all.connect = connectAttributes
  return {
    findBy: (query) => files.filter((file) => Object.entries(query).every(([key, value]) => file.src[key] === value)),
    getComponent: (name) => {
      if (!Object.prototype.hasOwnProperty.call(all, name)) return undefined
      const versions = [{ version: name === 'streaming' ? '26.2' : '', asciidoc: { attributes: all[name] } }]
      return { name, versions, latest: versions[0] }
    },
  }
}

function convert (input, { catalog, attributes = {}, component = 'connect', version = '' } = {}) {
  const Asciidoctor = require('@asciidoctor/core')()
  const registry = Asciidoctor.Extensions.create()
  register(registry, catalog && {
    contentCatalog: catalog,
    file: { src: { path: 'modules/guides/pages/example.adoc', component, version, module: 'guides' } },
  })
  return Asciidoctor.convert(input, { extension_registry: registry, attributes })
}

const spans = (html) => [...html.matchAll(/<span class="connect-value[^"]*"[^>]*>([\s\S]*?)<\/span>/g)]
  .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
const valueOf = (html) => spans(html)[0]
const warnings = () => jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})

const connect = (data) => catalogOf([attachment('4.114.0', data)])
const cloudCatalog = ({ csv = false, data } = {}) => catalogOf([attachment('4.114.0', data)], {
  components: { 'cloud-data-platform': { 'env-cloud': true } },
  connectAttributes: csv ? { csvData: { data: CSV } } : {},
})
const onCloud = (input, opts = {}) => convert(input, { catalog: cloudCatalog(opts), component: 'cloud-data-platform', ...opts })

describe('connectval macro', () => {
  afterEach(() => jest.restoreAllMocks())

  describe('fields', () => {
    test('a field written after component= is still the field', () => {
      expect(valueOf(convert('connectval:client_id[component=inputs/redpanda,type]', { catalog: connect() }))).toBe('string')
    })

    test('renders a span naming the component and field', () => {
      const html = convert('connectval:incremental_snapshot.chunk_size[component=inputs/postgres_cdc]', { catalog: connect() })
      expect(html).toContain('<span class="connect-value" data-connect-component="inputs/postgres_cdc" data-connect-field="incremental_snapshot.chunk_size" data-field="default">1024</span>')
    })

    test.each([
      ['a string default', 'connectval:client_id[component=inputs/redpanda]', 'redpanda-connect'],
      ['a number default', 'connectval:incremental_snapshot.chunk_size[component=inputs/postgres_cdc]', '1024'],
      ['a bool default', 'connectval:tls.enabled[component=inputs/redpanda]', 'false'],
      ['an empty list default', 'connectval:pipeline.processors[component=config]', '[]'],
      ['format=raw default', 'connectval:client_id[default,component=inputs/redpanda,format=raw]', 'redpanda-connect'],
      ['a root field', 'connectval:pipeline.threads[component=config]', '-1'],
      ['a type', 'connectval:topics[type,component=inputs/redpanda]', 'array<string>'],
      ['plain options', 'connectval:merge_strategy[options,component=outputs/iceberg]', 'merge-on-read, copy-on-write'],
      ['annotated options', 'connectval:start_offset[options,component=inputs/redpanda]', 'committed, earliest, latest'],
      ['options through an array of objects', 'connectval:sasl.mechanism[values,component=inputs/redpanda]', 'AWS_MSK_IAM, OAUTHBEARER, PLAIN, REDPANDA_CLOUD_SERVICE_ACCOUNT, SCRAM-SHA-256, SCRAM-SHA-512, none'],
      ['options raw', 'connectval:merge_strategy[options,component=outputs/iceberg,format=raw]', '["merge-on-read","copy-on-write"]'],
      ['deprecated', 'connectval:client_id[deprecated,component=inputs/redpanda]', 'no'],
      ['deprecated raw', 'connectval:client_id[deprecated,component=inputs/redpanda,format=raw]', 'false'],
      ['introduced', 'connectval:client_id[introduced,component=inputs/redpanda]', '4.21.0'],
      ['the plural type form', 'connectval:count[component=rate_limits/local]', '1000'],
      ['the singular type form', 'connectval:count[component=rate_limit/local]', '1000'],
      ['the hyphen type form', 'connectval:count[component=rate-limits/local]', '1000'],
      ['a metrics component', 'connectval:use_histogram_timing[component=metrics/prometheus]', 'false'],
    ])('%s', (_name, input, expected) => {
      expect(valueOf(convert(input, { catalog: connect() }))).toBe(expected)
    })

    test('an empty object default renders {}', () => {
      const data = clone(SAMPLE)
      data.outputs.find((c) => c.name === 'stdout').config.children.find((f) => f.name === 'codec').default = {}
      expect(valueOf(convert('connectval:codec[component=outputs/stdout]', { catalog: connect(data) }))).toBe('{}')
    })

    test('options render each value in its own code element', () => {
      const html = convert('connectval:merge_strategy[options,component=outputs/iceberg]', { catalog: connect() })
      expect(html).toContain('<code>merge-on-read</code>, <code>copy-on-write</code>')
    })

    test('a kafka input and a kafka output resolve by their type', () => {
      const registry = connectValues.loadConnect(connect())
      const input = connectValues.resolveConnectValue({ registry, component: 'inputs/kafka', path: 'addresses', field: 'type' })
      const output = connectValues.resolveConnectValue({ registry, component: 'outputs/kafka', path: 'topic', field: 'type' })
      expect(input.ok && input.componentKey).toBe('inputs')
      expect(output.ok && output.componentKey).toBe('outputs')
    })
  })

  describe('failures', () => {
    test.each([
      ['unknown-type', 'connectval:x[component=widgets/local]', "'widgets' is not a component type"],
      ['unknown-component', 'connectval:x[component=inputs/kafak_franz]', 'Did you mean: kafka_franz?'],
      ['unknown-field', 'connectval:clinet_id[component=inputs/redpanda]', 'Did you mean: client_id?'],
      ['unknown-field below a map', 'connectval:sasl.extensions.foo[component=inputs/redpanda]', "'sasl.extensions' is a map"],
      ['complex-default', 'connectval:partition_assignment_strategy[component=inputs/redpanda]', 'prints as a YAML block'],
      ['description-default', 'connectval:metadata_table[component=inputs/gcp_spanner_cdc]', 'its description states the real one'],
      ['missing-field', 'connectval:seed_brokers[component=inputs/kafka_franz]', 'has no default'],
      ['a missing component=', 'connectval:client_id[]', 'component= must be <type>/<name>'],
    ])('%s', (_name, input, message) => {
      const warn = warnings()
      const html = convert(input, { catalog: connect() })
      expect(html).toContain('connect-value-unknown')
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toContain(message)
    })

    test('an imprecise integer default', () => {
      const data = clone(SAMPLE)
      data.inputs.find((c) => c.name === 'postgres_cdc').config.children.find((f) => f.name === 'incremental_snapshot').children.find((f) => f.name === 'chunk_size').default = 2 ** 64
      warnings()
      expect(valueOf(convert('connectval:incremental_snapshot.chunk_size[component=inputs/postgres_cdc]', { catalog: connect(data) }))).toBe('<unknown default>')
    })

    test('a deprecated field still renders, with a deprecated-field warning', () => {
      const warn = warnings()
      expect(valueOf(convert('connectval:regexp_topics[deprecated,component=inputs/redpanda]', { catalog: connect() }))).toBe('yes')
      expect(warn.mock.calls[0][0]).toContain('the Connect reference does not list deprecated fields')
    })
  })

  describe('Cloud', () => {
    test('a component csvData marks unavailable is a placeholder', () => {
      const warn = warnings()
      expect(valueOf(onCloud('connectval:max_buffer[component=inputs/stdin]', { csv: true }))).toBe('<unknown default>')
      expect(warn.mock.calls[0][0]).toContain('(csvData)')
    })

    test('a GPU-only component is available', () => {
      expect(onCloud('connectval:model[type,component=processors/ollama_chat]', { csv: true })).not.toContain('connect-value-unknown')
    })

    test('csvData wins over a disagreeing cloudSupported', () => {
      // ollama_embeddings: cloudSupported false in the JSON, cloud_with_gpu y in info.csv.
      expect(SAMPLE.processors.find((c) => c.name === 'ollama_embeddings').cloudSupported).toBe(false)
      expect(onCloud('connectval:model[type,component=processors/ollama_embeddings]', { csv: true })).not.toContain('connect-value-unknown')
      warnings()
      expect(onCloud('connectval:model[type,component=processors/ollama_embeddings]')).toContain('connect-value-unknown')
    })

    test('without csvData the JSON cloudSupported decides, and the message names it', () => {
      const warn = warnings()
      expect(valueOf(onCloud('connectval:max_buffer[component=inputs/stdin]'))).toBe('<unknown default>')
      expect(warn.mock.calls[0][0]).toContain('connect-4.114.0.json cloudSupported')
    })

    test('introduced is hidden on Cloud', () => {
      warnings()
      expect(valueOf(onCloud('connectval:client_id[introduced,component=inputs/redpanda]'))).toBe('<unknown introduced>')
      expect(valueOf(onCloud('connectval:client_id[component=inputs/redpanda]'))).toBe('redpanda-connect')
    })

    test('config is never gated', () => {
      expect(valueOf(onCloud('connectval:pipeline.threads[component=config]'))).toBe('-1')
    })

    test('a cloud-docs page that includes rp-connect-docs text is gated by its own component', () => {
      // The macro reads config.file.src, which is the including Cloud page.
      warnings()
      expect(valueOf(onCloud('connectval:max_buffer[component=inputs/stdin]'))).toBe('<unknown default>')
      expect(valueOf(convert('connectval:max_buffer[component=inputs/stdin]', { catalog: cloudCatalog() }))).toBe('1000000')
    })

    test('a component neither source covers renders, with one cloud-unknown warning', () => {
      const data = clone(SAMPLE)
      delete data.inputs.find((c) => c.name === 'generate').cloudSupported
      const warn = warnings()
      const html = onCloud('connectval:interval[component=inputs/generate] connectval:interval[component=inputs/generate]', { data })
      expect(spans(html)).toEqual(['1s', '1s'])
      expect(warn.mock.calls.filter((c) => c[0].includes('neither csvData'))).toHaveLength(1)
    })
  })

  describe('data and modes', () => {
    test('no connect component gives a placeholder and the playbook hint', () => {
      const warn = warnings()
      const catalog = catalogOf([], { components: { streaming: {} } })
      expect(valueOf(convert('connectval:client_id[component=inputs/redpanda]', { catalog, component: 'streaming', version: '26.2' }))).toBe('<unknown default>')
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toContain('add the rp-connect-docs content source to the playbook')
    })

    test('two datasets warn once and the newest wins, whatever the page version', () => {
      const newer = clone(SAMPLE)
      newer.version = '4.115.1'
      newer.inputs.find((c) => c.name === 'redpanda').config.children.find((f) => f.name === 'client_id').default = 'newer'
      const catalog = catalogOf([attachment('4.114.0'), attachment('4.115.1', newer)], { components: { streaming: {}, 'cloud-data-platform': { 'env-cloud': true } } })
      const warn = warnings()
      expect(valueOf(convert('connectval:client_id[component=inputs/redpanda]', { catalog, component: 'streaming', version: '26.2' }))).toBe('newer')
      expect(valueOf(convert('connectval:client_id[component=inputs/redpanda]', { catalog, component: 'cloud-data-platform' }))).toBe('newer')
      expect(warn.mock.calls.map((c) => c[0])).toEqual(['connectval macro: 2 Connect datasets in connect:components; using connect-4.115.1.json.'])
    })

    test('off silences rendered-value warnings but still reports a placeholder', () => {
      const warn = warnings()
      convert('connectval:regexp_topics[component=inputs/redpanda]', { catalog: connect(), attributes: { 'connect-validate': 'off' } })
      expect(warn).not.toHaveBeenCalled()
      convert('connectval:nope[component=inputs/redpanda]', { catalog: connect(), attributes: { 'connect-validate': 'off' } })
      expect(warn).toHaveBeenCalledTimes(1)
    })

    const throwing = {
      'needs-block': ['connectval:[inputs/kafka_franz.consumer_group,description]'],
      'block-form-inline': ['See connectval::[inputs/kafka_franz.consumer_group,description] here.'],
      'unknown-type': ['connectval:x[component=widgets/local]'],
      'unknown-component': ['connectval:x[component=inputs/nope]'],
      'unknown-field': ['connectval:nope[component=inputs/redpanda]'],
      'missing-field': ['connectval:seed_brokers[component=inputs/kafka_franz]'],
      'unsupported-field': ['connectval:client_id[colour,component=inputs/redpanda]'],
      'cloud-hidden': ['connectval:client_id[introduced,component=inputs/redpanda]', true],
      unavailable: ['connectval:max_buffer[component=inputs/stdin]', true],
    }
    test('the throw list is exactly the authoring errors and Cloud gates', () => {
      expect([...THROW_KINDS].sort()).toEqual(Object.keys(throwing).sort())
    })
    test.each(Object.entries(throwing))('error mode throws for %s', (_kind, [input, cloud]) => {
      const attributes = { 'connect-validate': 'error' }
      expect(() => (cloud ? onCloud(input, { attributes }) : convert(input, { catalog: connect(), attributes }))).toThrow()
    })
    test.each([
      ['no-data', 'connectval:client_id[component=inputs/redpanda]', () => catalogOf([], { components: { connect: {} } })],
      ['complex-default', 'connectval:partition_assignment_strategy[component=inputs/redpanda]', connect],
      ['description-default', 'connectval:metadata_table[component=inputs/gcp_spanner_cdc]', connect],
      ['deprecated-field', 'connectval:regexp_topics[component=inputs/redpanda]', connect],
    ])('error mode never throws for %s', (_kind, input, catalog) => {
      warnings()
      expect(() => convert(input, { catalog: catalog(), attributes: { 'connect-validate': 'error' } })).not.toThrow()
    })

    test('an unsupported format warns and falls back to human', () => {
      const warn = warnings()
      expect(valueOf(convert('connectval:client_id[deprecated,component=inputs/redpanda,format=json]', { catalog: connect() }))).toBe('no')
      expect(warn.mock.calls[0][0]).toContain('format=json is not supported')
    })

    test.each(['toString', 'constructor', '__proto__'])('%s is never a field or component', (name) => {
      warnings()
      expect(valueOf(convert(`connectval:${name}[component=inputs/redpanda]`, { catalog: connect() }))).toBe('<unknown default>')
      expect(valueOf(convert(`connectval:client_id[component=inputs/${name}]`, { catalog: connect() }))).toBe('<unknown default>')
      expect(valueOf(convert(`connectval:client_id[component=${name}/redpanda]`, { catalog: connect() }))).toBe('<unknown default>')
    })

    test('two macros on one line and inside backticks', () => {
      const html = convert('`connectval:tls.enabled[component=inputs/redpanda]` and connectval:pipeline.threads[component=config]', { catalog: connect() })
      expect(spans(html)).toEqual(['false', '-1'])
    })
  })

  describe('the bracket form and the shared fields', () => {
    // A page in another component, an rp-connect-docs page elsewhere in
    // connect, and the component's own page.
    const render = (input, src = {}, catalog = connect()) => {
      const Asciidoctor = require('@asciidoctor/core')()
      const registry = Asciidoctor.Extensions.create()
      register(registry, { contentCatalog: catalog, file: { src: { path: 'modules/x/pages/example.adoc', component: 'ROOT', version: '', module: 'x', relative: 'example.adoc', ...src } } })
      return Asciidoctor.convert(input, { extension_registry: registry })
    }

    test.each([
      ['connectval:[inputs/redpanda.client_id]', 'connectval:client_id[component=inputs/redpanda]'],
      ['connectval:[inputs/postgres_cdc.incremental_snapshot.chunk_size,default]', 'connectval:incremental_snapshot.chunk_size[default,component=inputs/postgres_cdc]'],
      ['connectval:[outputs/iceberg.merge_strategy,values]', 'connectval:merge_strategy[values,component=outputs/iceberg]'],
      ['connectval:[config.pipeline.threads]', 'connectval:pipeline.threads[component=config]'],
      ['connectval:[rate_limit/local.count]', 'connectval:count[component=rate_limit/local]'],
      ['connectval:[inputs/redpanda.sasl.mechanism,options,format=raw]', 'connectval:sasl.mechanism[options,component=inputs/redpanda,format=raw]'],
    ])('%s renders what %s renders', (bracket, named) => {
      const a = convert(bracket, { catalog: connect() })
      expect(a).toBe(convert(named, { catalog: connect() }))
      expect(a).not.toContain('connect-value-unknown')
    })

    test('options is an alias: data-field is the canonical values', () => {
      expect(convert('connectval:merge_strategy[options,component=outputs/iceberg]', { catalog: connect() })).toContain('data-field="values"><code>merge-on-read</code>')
    })

    test.each([
      ['a component status', 'connectval:[inputs/kafka_franz,status]', 'deprecated'],
      ['a deprecated component', 'connectval:[inputs/kafka_franz,deprecated]', 'yes'],
      ['component categories', 'connectval:[inputs/generate,categories]', 'Utility'],
      ['a component introduced version', 'connectval:[inputs/generate,introduced]', '3.40.0'],
      ['a field summary', 'connectval:[inputs/kafka_franz.consumer_group,summary]', 'An optional consumer group to consume as. Partitions and offsets are managed automatically across the group.'],
      ['required: not optional, no default, a scalar', 'connectval:[inputs/generate.mapping,required]', 'yes'],
      ['required: a list is never required', 'connectval:[inputs/redpanda.seed_brokers,required]', 'no'],
      ['optional, the inverse of required', 'connectval:[inputs/generate.mapping,optional]', 'no'],
      ['secret', 'connectval:[inputs/kafka_franz.sasl.password,secret]', 'yes'],
      ['secret through is_secret', 'connectval:[inputs/kafka_franz.consumer_group,is_secret]', 'no'],
      ['advanced', 'connectval:[inputs/kafka_franz.consumer_group,advanced]', 'no'],
      ['interpolated', 'connectval:[inputs/kafka_franz.consumer_group,interpolated,format=raw]', 'false'],
      ['scalar examples, each as code', 'connectval:[inputs/generate.interval,examples]', '5s, 1m, 1h, @every 1s, 0,30 */2 * * * *, TZ=Europe/London 30 3-6,20-23 * * *'],
    ])('%s', (_name, input, expected) => {
      expect(valueOf(convert(input, { catalog: connect() }))).toBe(expected)
    })

    test('a component field carries no data-connect-field', () => {
      expect(convert('connectval:[inputs/kafka_franz,status]', { catalog: connect() })).toContain('<span class="connect-value" data-connect-component="inputs/kafka_franz" data-field="status">deprecated</span>')
    })

    test('a field of the wrong level says which to write', () => {
      const warn = warnings()
      convert('connectval:[inputs/kafka_franz,default]', { catalog: connect() })
      convert('connectval:[inputs/kafka_franz.consumer_group,status]', { catalog: connect() })
      expect(warn.mock.calls[0][0]).toContain('default is a field of a config field, not of a component. Name a field after the component, as in connectval:[inputs/kafka_franz.consumer_group,default].')
      expect(warn.mock.calls[1][0]).toContain('status is a field of a component, not of a config field. Name the component alone, as in connectval:[inputs/kafka_franz,status].')
    })

    test('a one-paragraph description renders inline with its markup and links', () => {
      const html = convert('connectval:[inputs/generate,summary]', { catalog: connect() })
      expect(html).toContain('Generates messages at a given interval using a <a href="guides:bloblang/about.html">Bloblang</a> mapping')
    })

    test('a description longer than one paragraph names the block form', () => {
      const warn = warnings()
      expect(valueOf(convert('connectval:[inputs/kafka_franz.consumer_group,description]', { catalog: connect() }))).toBe('<unknown description>')
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toContain('Use the block form on a line of its own: connectval::[inputs/kafka_franz.consumer_group,description].')
    })

    test('the block form parses the description, list included', () => {
      const html = convert('connectval::[inputs/kafka_franz.consumer_group,description]', { catalog: connect() })
      expect(html).toContain('<div class="openblock connect-value connect-value-description">')
      expect(html).toContain('<li>\n<p>Partition offsets are automatically committed and resumed under this name.</p>')
    })

    test('the block form of examples is a YAML listing', () => {
      const html = convert('connectval::[inputs/kafka_franz.topics,examples]', { catalog: connect() })
      expect(html).toContain('<code class="language-yaml" data-lang="yaml">topics:\n  - foo\n  - bar\n\n# ---\n\ntopics:\n  - things.*')
    })

    test('object examples have no inline form', () => {
      warnings()
      expect(valueOf(convert('connectval:[inputs/redpanda.tls.client_certs,examples]', { catalog: connect() }))).toBe('<unknown examples>')
    })

    describe('links in a string reused off its page', () => {
      const toast = 'connectval::[inputs/postgres_cdc.unchanged_toast_value,description]'
      test('on another component\'s page, a same-page ref links the component page with connect:', () => {
        expect(render(toast)).toContain('<a href="connect:components:inputs/postgres_cdc.html#signal_table_name"><code>signal_table_name</code></a>')
      })
      test('elsewhere in connect, the ref stays in the component', () => {
        expect(render(toast, { component: 'connect', module: 'guides' })).toContain('<a href="components:inputs/postgres_cdc.html#signal_table_name">')
      })
      test('on the component\'s own page, nothing changes', () => {
        expect(render(toast, { component: 'connect', module: 'components', relative: 'inputs/postgres_cdc.adoc' })).toContain('<a href="#signal_table_name"><code>signal_table_name</code></a>')
      })
      test('a connect-relative xref is qualified with connect: on another component\'s page', () => {
        expect(render('connectval:[inputs/generate,summary]')).toContain('<a href="connect:guides:bloblang/about.html">Bloblang</a>')
        expect(render('connectval:[inputs/generate,summary]', { component: 'connect', module: 'components' })).toContain('<a href="guides:bloblang/about.html">Bloblang</a>')
      })
      test('on Cloud, a link stays relative where Cloud has the page, and renders as text where it does not', () => {
        const warn = warnings()
        const catalog = cloudCatalog()
        catalog.resolvePage = (spec) => (spec.startsWith('components:') ? { src: {} } : undefined)
        const summary = render('connectval:[inputs/generate,summary]', { component: 'cloud-data-platform' }, catalog)
        expect(summary).toContain('using a Bloblang mapping')
        expect(summary).not.toContain('<a href')
        expect(warn.mock.calls.map((c) => c[0]).join('\n')).toContain('the summary links connect:guides:bloblang/about.adoc, which this Cloud page has no page for, so that link renders as text.')
        expect(render(toast, { component: 'cloud-data-platform' }, catalog)).toContain('<a href="components:inputs/postgres_cdc.html#signal_table_name">')
      })
    })

    test('docs_format: markdown strings are converted from Markdown', () => {
      const data = clone(SAMPLE)
      data.docs_format = 'markdown'
      const consumer = data.inputs.find((c) => c.name === 'kafka_franz').config.children.find((f) => f.name === 'consumer_group')
      consumer.description = 'An optional consumer group. When you specify this value:\n\n- The partitions of any topics specified in the `topics` field are distributed.\n- Offsets are committed under **this** name.\n\nSee the [franz-go docs](https://github.com/twmb/franz-go).'
      consumer.short_description = 'An optional consumer group, *managed* by `franz-go`.'
      expect(convert('connectval:[inputs/kafka_franz.consumer_group,summary]', { catalog: connect(data) })).toContain('An optional consumer group, <em>managed</em> by <code>franz-go</code>.')
      const html = convert('connectval::[inputs/kafka_franz.consumer_group,description]', { catalog: connect(data) })
      expect(html).toContain('<li>\n<p>Offsets are committed under <strong>this</strong> name.</p>')
      expect(html).toContain('<a href="https://github.com/twmb/franz-go">franz-go docs</a>')
    })

    test('connectval:: in a sentence is block-form-inline', () => {
      const warn = warnings()
      expect(valueOf(convert('See connectval::[inputs/kafka_franz.consumer_group,description] here.', { catalog: connect() }))).toBe('<unknown description>')
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toContain('connectval:: is the block form, which renders only on a line of its own.')
    })
  })

  describe('agreement with the generated component reference', () => {
    // Every non-deprecated field the reference renders: its heading path,
    // *Type*: and the inline *Default*:, when it prints one.
    const referenceFields = (children) => {
      const text = String(renderConnectFields(children))
      const out = []
      for (const block of text.split(/^=== /m).slice(1)) {
        const heading = block.match(/^`([^`]+)`/)
        const type = block.match(/^\*Type\*: `([^`]*)`$/m)
        const inline = block.match(/^\*Default\*: `([^`]*)`$/m)
        const yamlBlock = /^\*Default\*:\n\[source,yaml\]/m.test(block)
        out.push({ path: heading[1].split('.').map((s) => s.replace(/\[\]$/, '')).join('.'), type: type && type[1], inline: inline && inline[1], yamlBlock })
      }
      return out
    }
    const cases = []
    for (const [key, list] of Object.entries(SAMPLE)) {
      if (!Array.isArray(list) || key === 'config' || key === '_source') continue
      for (const entry of list) {
        if (!entry.config || !Array.isArray(entry.config.children)) continue
        for (const f of referenceFields(entry.config.children)) cases.push([`${key}/${entry.name} ${f.path}`, `${key.replace(/-/g, '_')}/${entry.name}`, f])
      }
    }
    test('the fixture has fields to compare', () => {
      expect(cases.length).toBeGreaterThan(500)
    })
    const registry = connectValues.loadConnect(connect())
    test.each(cases)('%s', (_name, component, f) => {
      const type = connectValues.resolveConnectValue({ registry, component, path: f.path, field: 'type' })
      expect(type.ok).toBe(true)
      expect(type.text).toBe(f.type)
      const def = connectValues.resolveConnectValue({ registry, component, path: f.path, field: 'default', format: 'raw' })
      if (f.inline !== null) {
        if (def.ok) expect(def.text).toBe(f.inline)
        else expect(def.kind).toBe('description-default')
      } else if (f.yamlBlock) {
        expect(def.ok).toBe(false)
        expect(['complex-default', 'missing-field']).toContain(def.kind)
      } else {
        expect(def.ok).toBe(false)
        expect(def.kind).toBe('missing-field')
      }
    })
  })
})
