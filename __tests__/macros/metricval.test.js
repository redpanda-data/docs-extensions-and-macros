'use strict'

// Same mocked logger as prop.test.js: the macro logs through @antora/logger.
jest.mock('@antora/logger', () => {
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const getLogger = () => logger
  getLogger.configure = () => getLogger
  return getLogger
})

const {
  SAMPLE,
  SAMPLE_JSON,
  attachment,
  page,
  streamingFiles,
  catalogOf,
  streamingCatalog,
  convert,
  onCloud,
} = require('../helpers/metrics-catalog')
const { THROW_KINDS } = require('../../macros/metricval')
const metricValues = require('../../extension-utils/metric-values')
const { convertPageHtml } = require('../../extensions/convert-to-markdown')

const warnings = () => jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})
const messages = (warn) => warn.mock.calls.map((call) => call[0])

const unescape = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
// The rendered value of the first metricval: span, as text.
const valueOf = (html) => {
  const match = html.match(/<span class="metric-value[^"]*"[^>]*>([\s\S]*?)<\/span>/)
  return match && unescape(match[1].replace(/<[^>]+>/g, ''))
}
const render = (input, options = {}) => valueOf(convert(input, { catalog: streamingCatalog(), ...options }))

const BROKERS = 'redpanda_cluster_brokers'
const LATENCY = 'redpanda_kafka_request_latency_seconds'
const BYTES = 'redpanda_kafka_request_bytes_total'
const REFRESHES = 'redpanda_cluster_health_refreshes_total'
const BUCKETS = '0.000255, 0.000511, 0.001023, 0.002047, 0.004095, 0.008191, 0.016383, 0.032767, 0.065535, 0.131071, 0.262143, 0.524287, 1.048575, 2.097151, 4.194303, 8.388607, 16.777215, 33.554431, +Inf'

describe('metricval macro', () => {
  afterEach(() => jest.restoreAllMocks())

  describe('every field', () => {
    test('a value renders as plain text in a span with a stable class and data attributes', () => {
      const warn = warnings()
      const html = convert(`It is a metricval:${BROKERS}[type].`, { catalog: streamingCatalog() })
      expect(html).toContain(`It is a <span class="metric-value" data-metric="${BROKERS}" data-field="type">gauge</span>.`)
      expect(warn).not.toHaveBeenCalled()
    })

    test.each([
      [`metricval:${BROKERS}[description]`, 'Number of configured brokers in the cluster'],
      [`metricval:${BROKERS}[type]`, 'gauge'],
      [`metricval:${BYTES}[type]`, 'counter'],
      [`metricval:${LATENCY}[type]`, 'histogram'],
      [`metricval:${LATENCY}[unit]`, 'seconds'],
      [`metricval:${BYTES}[unit]`, 'bytes'],
      [`metricval:${LATENCY}[labels]`, 'redpanda_request'],
      [`metricval:redpanda_kafka_under_replicated_replicas[labels]`, 'redpanda_namespace, redpanda_partition, redpanda_topic, shard'],
      [`metricval:${LATENCY}[labels,format=raw]`, '["redpanda_request"]'],
      [`metricval:${LATENCY}[values,label=redpanda_request]`, 'consume, produce'],
      [`metricval:${LATENCY}[values,label=redpanda_request,format=raw]`, '["consume","produce"]'],
      [`metricval:${BROKERS}[endpoint]`, '/public_metrics'],
      [`metricval:vectorized_alien_receive_batch_queue_length[endpoint]`, '/metrics'],
      [`metricval:${BROKERS}[endpoint,format=raw]`, 'public'],
      [`metricval:${LATENCY}[buckets]`, BUCKETS],
      [`metricval:${LATENCY}[buckets,format=raw]`, JSON.stringify(BUCKETS.split(', '))],
      [`metricval:${BROKERS}[category]`, 'Cluster metrics'],
      [`metricval:${BROKERS}[use-cases]`, 'cluster-health, alerting'],
      [`metricval:${BROKERS}[use-cases,format=raw]`, '["cluster-health","alerting"]'],
      [`metricval:${BROKERS}[usage]`, 'Create an alert if this gauge falls below a steady-state threshold.'],
      [`metricval:${REFRESHES}[requires]`, 'health_monitor_metrics_enabled is true'],
      [`metricval:${REFRESHES}[requires,format=raw]`, '[{"property":"health_monitor_metrics_enabled","value":true}]'],
      [`metricval:${BROKERS}[introduced]`, 'v22.1'],
      [`metricval:${BROKERS}[deprecated]`, 'no'],
      [`metricval:${BROKERS}[deprecated,format=raw]`, 'false'],
      [`metricval:redpanda_example_deprecated_total[deprecated,deprecated=ok]`, 'yes'],
      [`metricval:redpanda_example_deprecated_total[deprecated,format=raw,deprecated=ok]`, 'v26.1'],
      [`metricval:${BROKERS}[status]`, 'stable'],
      [`metricval:redpanda_example_deprecated_total[status,deprecated=ok]`, 'deprecated'],
      [`metricval:${BROKERS}[see-also]`, 'health_monitor_metrics_enabled, Monitor Redpanda, Cluster diagnostics'],
      [`metricval:${BROKERS}[cloud-access]`, 'Self-Managed, Dedicated, BYOC'],
      [`metricval:${LATENCY}[cloud-access]`, 'Self-Managed, Dedicated, BYOC, Serverless'],
      [`metricval:${BROKERS}[cloud-access,format=raw]`, '{"self_managed":true,"dedicated":true,"byoc":true,"serverless":false}'],
      ['metricval:redpanda_example_removed_total[removed]', 'v26.2'],
    ])('%s renders %s', (input, expected) => {
      warnings()
      expect(render(input)).toBe(expected)
    })

    test('the test above covers every field metricval: has', () => {
      // removed, on a metric still in the data, is covered under failures.
      expect(Object.keys(metricValues.FIELDS).sort()).toEqual(['buckets', 'category', 'cloud-access', 'deprecated', 'description', 'endpoint', 'introduced', 'labels', 'removed', 'requires', 'see-also', 'status', 'type', 'unit', 'usage', 'use-cases', 'values'])
    })

    test.each([
      ['availability', 'cloud-access'],
      ['cloud', 'cloud-access'],
      ['use_cases', 'use-cases'],
      ['units', 'unit'],
      ['desc', 'description'],
      ['since', 'introduced'],
      ['version', 'introduced'],
      ['is_deprecated', 'deprecated'],
      ['options', 'values'],
      ['categories', 'category'],
      ['see_also', 'see-also'],
      ['Type', 'type'],
    ])('the alias %s is the field %s', (alias, field) => {
      expect(metricValues.normalizeField(alias)).toBe(field)
    })

    test('labels, values and endpoint render each item as code', () => {
      const html = convert(`metricval:${LATENCY}[values,label=redpanda_request] metricval:${BROKERS}[endpoint]`, { catalog: streamingCatalog() })
      expect(html).toContain('data-field="values"><code>consume</code>, <code>produce</code></span>')
      expect(html).toContain('data-field="endpoint"><code>/public_metrics</code></span>')
    })

    test('text values render as AsciiDoc: related properties through prop:, related topics as links', () => {
      warnings()
      const html = convert(`metricval:${BROKERS}[see-also]`, { catalog: streamingCatalog() })
      expect(html).toContain('<code>health_monitor_metrics_enabled</code>, <a href="manage:monitoring.html">Monitor Redpanda</a>')
    })

    test('on a Cloud page see-also leaves out the self-managed-only topic', () => {
      warnings()
      expect(valueOf(onCloud(`metricval:${BROKERS}[see-also]`))).toBe('health_monitor_metrics_enabled, Monitor Redpanda')
    })

    test('a histogram series name reads its family', () => {
      const warn = warnings()
      const html = convert(`metricval:${LATENCY}_bucket[type] metricval:${LATENCY}_sum[unit]`, { catalog: streamingCatalog() })
      expect(html).toContain(`<span class="metric-value" data-metric="${LATENCY}" data-field="type">histogram</span>`)
      expect(html).toContain(`<span class="metric-value" data-metric="${LATENCY}" data-field="unit">seconds</span>`)
      expect(warn).not.toHaveBeenCalled()
    })

    test('a gauge whose name ends in _sum reads its own entry', () => {
      const warn = warnings()
      expect(render('metricval:redpanda_kafka_consumer_group_lag_sum[type]')).toBe('gauge')
      expect(render('metricval:redpanda_kafka_consumer_group_lag_sum[description]')).toBe('Sum of consumer group lag for all topic-partitions')
      expect(warn).not.toHaveBeenCalled()
    })

    test('an unsupported format warns and renders the human value', () => {
      const warn = warnings()
      expect(render(`metricval:${BROKERS}[endpoint,format=json]`)).toBe('/public_metrics')
      expect(messages(warn)).toEqual([expect.stringContaining('format=json is not supported')])
    })
  })

  describe('failures render <unknown FIELD> and say why', () => {
    test('the placeholder is the one propval: uses, with the unknown class', () => {
      warnings()
      const html = convert(`metricval:${BYTES}[category]`, { catalog: streamingCatalog() })
      expect(html).toContain(`<span class="metric-value metric-value-unknown" data-metric="${BYTES}" data-field="category">&lt;unknown category&gt;</span>`)
    })

    test('an unknown field warns with the supported list', () => {
      const warn = warnings()
      expect(render(`metricval:${BROKERS}[colour]`)).toBe('<unknown colour>')
      expect(messages(warn)).toEqual([`metricval:${BROKERS}[colour] in modules/manage/pages/example.adoc: 'colour' is not a field metricval: supports. Supported fields: ${Object.keys(metricValues.FIELDS).join(', ')}.`])
      expect(messages(warn)[0]).toContain('Supported fields: description, type, unit, labels, values, endpoint, buckets, category, use-cases, usage, requires, introduced, deprecated, removed, status, see-also, cloud-access.')
    })

    test('no field at all is an unsupported field, with the list', () => {
      const warn = warnings()
      expect(render(`metricval:${BROKERS}[]`)).toBe('<unknown value>')
      expect(messages(warn)[0]).toContain('names no field')
      expect(messages(warn)[0]).toContain('Supported fields: description, type,')
    })

    test('an unknown metric warns with the dataset and a suggestion', () => {
      const warn = warnings()
      expect(render('metricval:redpanda_cluster_broker[type]')).toBe('<unknown type>')
      expect(messages(warn)).toEqual([expect.stringMatching(/^metricval:redpanda_cluster_broker\[type\] in modules\/manage\/pages\/example\.adoc: 'redpanda_cluster_broker' is not in the metrics data this page validates against \(redpanda-metrics-v26\.2\.7\.json from streaming@26\.2\)\..*Did you mean: redpanda_cluster_brokers/)])
    })

    test('a removed name says the release it was removed in, for every field but removed', () => {
      const warn = warnings()
      expect(render('metricval:redpanda_example_removed_total[type]')).toBe('<unknown type>')
      expect(messages(warn)).toEqual([expect.stringContaining("'redpanda_example_removed_total' was removed in v26.2")])
    })

    // The override fields arrive later. Until the data has one, it is a
    // missing field, never a guess. This metric is as the generator wrote it.
    test.each(['category', 'use-cases', 'usage', 'cloud-access', 'requires', 'introduced', 'deprecated', 'status', 'see-also', 'removed'])('negative control: %s is deliberately missing from the fixture entry, so it renders the placeholder', (field) => {
      const warn = warnings()
      expect(SAMPLE.metrics[BYTES]).not.toHaveProperty(field.replace('-', '_'))
      expect(render(`metricval:${BYTES}[${field}]`)).toBe(`<unknown ${field}>`)
      expect(messages(warn)).toEqual([expect.stringContaining(`'${BYTES}' has no ${field} in redpanda-metrics-v26.2.7.json from streaming@26.2`)])
    })

    test.each([
      [`metricval:${BROKERS}[unit]`, 'unit', 'a metric whose name states no unit'],
      [`metricval:${BROKERS}[labels]`, 'labels', 'a metric with no labels'],
      [`metricval:${BROKERS}[buckets]`, 'buckets', 'a metric that is not a histogram'],
      ['metricval:redpanda_cloud_storage_anomalies[description]', 'description', 'a metric the scrape did not see, whose description is empty'],
    ])('%s renders <unknown %s>: %s', (input, field) => {
      const warn = warnings()
      expect(render(input)).toBe(`<unknown ${field}>`)
      expect(warn).toHaveBeenCalledTimes(1)
    })

    test('values needs label=, and the message names the labels', () => {
      const warn = warnings()
      expect(render(`metricval:${LATENCY}[values]`)).toBe('<unknown values>')
      expect(messages(warn)[0]).toContain(`it needs label=<label name>, as in metricval:${LATENCY}[values,label=redpanda_request]`)
    })

    test('values for a label the metric does not have names the labels it has', () => {
      const warn = warnings()
      expect(render(`metricval:${LATENCY}[values,label=redpanda_topic]`)).toBe('<unknown values>')
      expect(messages(warn)[0]).toContain(`'${LATENCY}' has no label 'redpanda_topic'`)
      expect(messages(warn)[0]).toContain('Its labels: redpanda_request.')
    })

    test('values never falls back to the values one scrape saw', () => {
      const warn = warnings()
      const label = SAMPLE.metrics[BYTES].labels.find((item) => item.name === 'redpanda_request')
      expect(label.observed_values).toEqual(['consume', 'follower_consume', 'produce'])
      expect(label.values).toBeUndefined()
      expect(render(`metricval:${BYTES}[values,label=redpanda_request]`)).toBe('<unknown values>')
      expect(messages(warn)[0]).toContain("has no complete list of values for the label 'redpanda_request'")
    })

    test('a text value longer than one paragraph has no inline form', () => {
      const warn = warnings()
      expect(render(`metricval:${LATENCY}[usage]`)).toBe('<unknown usage>')
      expect(messages(warn)[0]).toContain(`Use the block form on a line of its own: metricval::${LATENCY}[usage].`)
    })

    test('the block form inside a sentence says to use the inline form', () => {
      const warn = warnings()
      expect(render(`The type is metricval::${BROKERS}[type].`)).toBe('<unknown type>')
      expect(messages(warn)[0]).toContain(`In a sentence, write metricval:${BROKERS}[type].`)
    })
  })

  describe('block form', () => {
    test('a text value of several paragraphs is parsed into the page', () => {
      const warn = warnings()
      const html = convert(`metricval::${LATENCY}[usage]`, { catalog: streamingCatalog() })
      expect(html).toContain('<div class="openblock metric-value metric-value-usage">')
      expect(html).toContain('<p>Watch the 99th percentile.</p>')
      expect(html).toContain('<p>A rising value means clients wait longer for produce and fetch requests.</p>')
      expect(warn).not.toHaveBeenCalled()
    })

    test('a description renders as a block', () => {
      const html = convert(`metricval::${BROKERS}[description]`, { catalog: streamingCatalog() })
      expect(html).toContain('<div class="openblock metric-value metric-value-description">')
      expect(html).toContain('<p>Number of configured brokers in the cluster</p>')
    })

    test('a short value renders as a paragraph of its own', () => {
      const html = convert(`metricval::${BROKERS}[type]`, { catalog: streamingCatalog() })
      expect(html).toContain(`<p><span class="metric-value" data-metric="${BROKERS}" data-field="type">gauge</span></p>`)
    })

    test('a failure renders the placeholder as a paragraph and warns', () => {
      const warn = warnings()
      const html = convert(`metricval::${BYTES}[usage]`, { catalog: streamingCatalog() })
      expect(html).toContain('&lt;unknown usage&gt;</span></p>')
      expect(messages(warn)[0]).toMatch(/^metricval::redpanda_kafka_request_bytes_total\[usage\]/)
    })
  })

  describe('which data a page reads', () => {
    test('no dataset: the placeholder, the once-per-version warning and one for the call', () => {
      const warn = warnings()
      const catalog = catalogOf([page('streaming', '26.2', 'x.adoc', '= X')])
      expect(render(`metricval:${BROKERS}[type]`, { catalog })).toBe('<unknown type>')
      expect(messages(warn)).toEqual([
        expect.stringContaining('no redpanda-metrics-<tag>.json attachment found'),
        expect.stringContaining('this page has no metrics data to read'),
      ])
    })

    test('a page never borrows another release series\' data', () => {
      const warn = warnings()
      const catalog = catalogOf([...streamingFiles('26.2'), page('streaming', '26.1', 'x.adoc', '= X')])
      expect(render(`metricval:${BROKERS}[type]`, { catalog, version: '26.1' })).toBe('<unknown type>')
      expect(messages(warn)[0]).toContain('streaming@26.1 publishes no redpanda-metrics-v26.1.*.json attachment')
      expect(messages(warn)[1]).toContain('rather than a value from another release')
    })

    test('each version reads its own file', () => {
      const other = JSON.parse(SAMPLE_JSON)
      other.metrics[BROKERS].type = 'counter'
      const catalog = catalogOf([...streamingFiles('26.2'), attachment('streaming', '26.1', 'v26.1.20', JSON.stringify(other))])
      expect(render(`metricval:${BROKERS}[type]`, { catalog, version: '26.1' })).toBe('counter')
      expect(render(`metricval:${BROKERS}[type]`, { catalog, version: '26.2' })).toBe('gauge')
    })
  })

  describe('Cloud audience', () => {
    test('a public metric on the Cloud page renders its value from the newest GA streaming data', () => {
      const warn = warnings()
      expect(valueOf(onCloud(`metricval:${BROKERS}[type]`))).toBe('gauge')
      expect(warn).not.toHaveBeenCalled()
    })

    test.each([
      ['an internal metric', 'vectorized_alien_receive_batch_queue_length', 'it is an internal metric (/metrics), which Redpanda Cloud does not expose'],
      ['a metric whose availability says it is not on Cloud', REFRESHES, 'its availability in the metrics data says it is not on Redpanda Cloud'],
      ['a metric with no reference page in the Cloud component', 'redpanda_kafka_consumer_group_lag_sum', 'cloud@unversioned has no reference page with a heading for it'],
    ])('%s renders the placeholder with a warning', (_what, name, reason) => {
      const warn = warnings()
      expect(valueOf(onCloud(`metricval:${name}[type]`))).toBe('<unknown type>')
      expect(messages(warn)).toEqual([expect.stringContaining(reason)])
      // The same call on a self-managed page renders the value.
      expect(render(`metricval:${name}[type]`)).toMatch(/^(gauge|counter)$/)
    })

    test('on a Serverless page, a metric that is not on Serverless renders the placeholder', () => {
      const warn = warnings()
      expect(valueOf(onCloud(`metricval:${BROKERS}[type]`, { attributes: { 'env-serverless': true } }))).toBe('<unknown type>')
      expect(valueOf(onCloud(`metricval:${LATENCY}[type]`, { attributes: { 'env-serverless': true } }))).toBe('histogram')
      expect(messages(warn)).toEqual([expect.stringContaining('says it is not on Serverless')])
    })
  })

  describe('deprecated metrics', () => {
    test('a value of a deprecated metric warns, and still renders', () => {
      const warn = warnings()
      expect(render('metricval:redpanda_example_deprecated_total[type]')).toBe('counter')
      expect(messages(warn)).toEqual([expect.stringContaining("'redpanda_example_deprecated_total' is deprecated (v26.1)")])
    })

    test('deprecated=ok silences it, and only the literal ok', () => {
      const warn = warnings()
      expect(render('metricval:redpanda_example_deprecated_total[type,deprecated=ok]')).toBe('counter')
      expect(warn).not.toHaveBeenCalled()
      render('metricval:redpanda_example_deprecated_total[type,deprecated=yes]')
      expect(warn).toHaveBeenCalledTimes(1)
    })
  })

  describe('metric-validate', () => {
    const inMode = (mode, input, options = {}) => convert(input, { catalog: streamingCatalog(), attributes: { 'metric-validate': mode }, ...options })

    test('the throw kinds are the authoring errors', () => {
      expect(THROW_KINDS).toEqual(['unknown-metric', 'unsupported-field', 'removed-metric', 'label-required', 'needs-block', 'block-form-inline'])
    })

    test('warn is the default: every failure renders and warns', () => {
      const warn = warnings()
      expect(() => convert(`metricval:nope[type] metricval:${BROKERS}[colour] metricval:redpanda_example_removed_total[type]`, { catalog: streamingCatalog() })).not.toThrow()
      expect(warn).toHaveBeenCalledTimes(3)
    })

    test.each([
      ['unknown-metric', 'metricval:redpanda_cluster_broker[type]', /is not in the metrics data/],
      ['unsupported-field', `metricval:${BROKERS}[colour]`, /is not a field metricval: supports/],
      ['unsupported-field (no field)', `metricval:${BROKERS}[]`, /names no field/],
      ['removed-metric', 'metricval:redpanda_example_removed_total[type]', /was removed in v26\.2/],
      ['label-required', `metricval:${LATENCY}[values]`, /needs label=/],
      ['needs-block', `metricval:${LATENCY}[usage]`, /Use the block form/],
      ['block-form-inline', `x metricval::${BROKERS}[type]`, /is the block form/],
    ])('error fails the build on %s', (_kind, input, message) => {
      expect(() => inMode('error', input)).toThrow(message)
    })

    test('error fails the block form too', () => {
      expect(() => inMode('error', `metricval::${BROKERS}[colour]`)).toThrow(/is not a field metricval: supports/)
    })

    test('error never fails on a data gap: no data, a missing field, an unknown label, or a metric that is not for Cloud', () => {
      const warn = warnings()
      const none = catalogOf([page('streaming', '26.2', 'x.adoc', '= X')])
      expect(valueOf(inMode('error', `metricval:${BROKERS}[type]`, { catalog: none }))).toBe('<unknown type>')
      expect(valueOf(inMode('error', `metricval:${BYTES}[category]`))).toBe('<unknown category>')
      expect(valueOf(inMode('error', `metricval:${BYTES}[values,label=redpanda_request]`))).toBe('<unknown values>')
      expect(valueOf(inMode('error', `metricval:${LATENCY}[values,label=nope]`))).toBe('<unknown values>')
      expect(valueOf(onCloud('metricval:vectorized_alien_receive_batch_queue_length[type]', { attributes: { 'metric-validate': 'error' } }))).toBe('<unknown type>')
      expect(valueOf(onCloud('metricval:redpanda_kafka_consumer_group_lag_sum[type]', { attributes: { 'metric-validate': 'error' } }))).toBe('<unknown type>')
      expect(warn).toHaveBeenCalled()
    })

    test('off still reports a placeholder, because a value has no safe fallback', () => {
      const warn = warnings()
      expect(valueOf(inMode('off', 'metricval:redpanda_cluster_broker[type]'))).toBe('<unknown type>')
      expect(valueOf(inMode('off', `metricval:${BYTES}[category]`))).toBe('<unknown category>')
      expect(warn).toHaveBeenCalledTimes(2)
    })

    test('off silences the warnings for values that render, and the missing-data diagnostic', () => {
      const warn = warnings()
      expect(valueOf(inMode('off', 'metricval:redpanda_example_deprecated_total[type]'))).toBe('counter')
      expect(valueOf(inMode('off', `metricval:${BROKERS}[endpoint,format=json]`))).toBe('/public_metrics')
      expect(warn).not.toHaveBeenCalled()
      inMode('off', `metricval:${BROKERS}[type]`, { catalog: catalogOf([page('streaming', '26.2', 'x.adoc', '= X')]) })
      expect(messages(warn)).toEqual([expect.stringContaining('this page has no metrics data to read')])
    })
  })

  describe('Markdown export', () => {
    const markdown = (html) => convertPageHtml({
      html: `<html><body><article class="doc">${html}</article></body></html>`,
      page: {
        asciidoc: { doctitle: 'Example', attributes: {} },
        pub: { url: '/current/manage/example/' },
        src: { component: 'streaming', version: 'current', path: 'modules/manage/pages/example.adoc' },
        out: { path: 'current/manage/example/index.html' },
      },
      siteUrl: 'https://docs.example.com',
    })

    test('a value exports as plain text', () => {
      const html = convert(`A metricval:${LATENCY}[type] in metricval:${LATENCY}[unit].`, { catalog: streamingCatalog() })
      expect(markdown(html)).toContain('A histogram in seconds.')
    })

    test('a value in backticks exports as code', () => {
      const html = convert(`Buckets: \`metricval:${BROKERS}[endpoint,format=raw]\`.`, { catalog: streamingCatalog() })
      expect(markdown(html)).toContain('Buckets: `public`.')
    })

    test('negative control: a field missing from the fixture exports the placeholder, not a value', () => {
      warnings()
      const exported = markdown(convert(`A metricval:${BYTES}[category] metric.`, { catalog: streamingCatalog() }))
      expect(exported).toContain('unknown category')
      expect(exported).not.toContain('Cluster metrics')
    })
  })
})
