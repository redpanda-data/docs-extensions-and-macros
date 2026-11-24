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
  cloudFiles,
  catalogOf,
  streamingCatalog,
  cloudCatalog,
  convert,
  onCloud,
} = require('../helpers/metrics-catalog')
const { buildMetricContent, THROW_KINDS } = require('../../macros/metric')
const metricValues = require('../../extension-utils/metric-values')
const { buildMetricPageIndex } = require('../../extension-utils/metric-links')
const { convertPageHtml } = require('../../extensions/convert-to-markdown')

const warnings = () => jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})
const messages = (warn) => warn.mock.calls.map((call) => call[0])

const BROKERS = '<code class="metric-ref" data-metric-name="redpanda_cluster_brokers" data-doc-url="/current/reference/public-metrics-reference/#redpanda_cluster_brokers">redpanda_cluster_brokers</code>'
const LINKED_BROKERS = `<a href="reference:public-metrics-reference.adoc#redpanda_cluster_brokers">${BROKERS}</a>`

describe('metric macro', () => {
  afterEach(() => jest.restoreAllMocks())

  describe('rendering', () => {
    test('a known metric renders code with tooltip data and no link', () => {
      const warn = warnings()
      const html = convert('See metric:redpanda_cluster_brokers[].', { catalog: streamingCatalog() })
      expect(html).toContain(`See ${BROKERS}.`)
      expect(html).not.toContain('<a ')
      expect(warn).not.toHaveBeenCalled()
    })

    test('link=true links the reference entry in the page\'s own component, at the family anchor', () => {
      const warn = warnings()
      expect(convert('metric:redpanda_cluster_brokers[link=true]', { catalog: streamingCatalog() })).toContain(LINKED_BROKERS)
      expect(warn).not.toHaveBeenCalled()
    })

    test('the page is found by its headings, so an internal metric links the internal page', () => {
      const html = convert('metric:vectorized_alien_receive_batch_queue_length[link=true]', { catalog: streamingCatalog() })
      expect(html).toContain('<a href="reference:internal-metrics-reference.adoc#vectorized_alien_receive_batch_queue_length"><code class="metric-ref"')
    })

    test('text= replaces the name, and keeps the tooltip data', () => {
      const html = convert('metric:redpanda_cluster_brokers[text=broker count]', { catalog: streamingCatalog() })
      expect(html).toContain('data-metric-name="redpanda_cluster_brokers"')
      expect(html).toContain('>broker count</code>')
    })

    test.each([
      ['metrics/public', 'reference:metrics/public.adoc'],
      ['monitor:metrics', 'monitor:metrics.adoc'],
      ['cloud:reference:public-metrics-reference', 'cloud:reference:public-metrics-reference.adoc'],
    ])('page=%s overrides the discovered page, as in prop:', (target, href) => {
      const warn = warnings()
      const html = convert(`metric:redpanda_cluster_brokers[link=true,page=${target}]`, { catalog: streamingCatalog() })
      expect(html).toContain(`<a href="${href}#redpanda_cluster_brokers"><code class="metric-ref" data-metric-name="redpanda_cluster_brokers">redpanda_cluster_brokers</code></a>`)
      // The discovered page's URL is not the page= target's, so it is left out.
      expect(html).not.toContain('data-doc-url')
      expect(warn).not.toHaveBeenCalled()
    })

    test.each([
      ['link=yes', 'link=yes'],
      ['link=True', 'link=True'],
      ['link', 'link'],
      ['link=', 'link='],
    ])('%s is not link=true: no link, and one warning that names the accepted value', (written, named) => {
      const warn = warnings()
      const html = convert(`metric:redpanda_cluster_brokers[${written}]`, { catalog: streamingCatalog() })
      expect(html).toContain(BROKERS)
      expect(html).not.toContain('<a ')
      expect(messages(warn)).toEqual([`metric:redpanda_cluster_brokers[${named}] in modules/manage/pages/example.adoc: ${named} is not a value link accepts, so the metric renders without a link. Write link=true.`])
    })

    test('link=true, link=false and no link at all do not warn', () => {
      const warn = warnings()
      convert('metric:redpanda_cluster_brokers[link=true] metric:redpanda_cluster_brokers[link=false] metric:redpanda_cluster_brokers[] metric:redpanda_cluster_brokers[text=link]', { catalog: streamingCatalog() })
      expect(warn).not.toHaveBeenCalled()
      convert('metric:redpanda_cluster_brokers[link=yes]', { catalog: streamingCatalog(), attributes: { 'metric-validate': 'off' } })
      expect(warn).not.toHaveBeenCalled()
    })

    test('link=true with no page that documents the metric keeps the tooltip, renders no link and warns (no-page)', () => {
      const warn = warnings()
      const html = convert('metric:redpanda_kafka_request_bytes_total[link=true]', { catalog: streamingCatalog() })
      expect(html).toContain('<code class="metric-ref" data-metric-name="redpanda_kafka_request_bytes_total">redpanda_kafka_request_bytes_total</code>')
      expect(messages(warn)).toEqual([expect.stringContaining('no reference page in streaming@26.2 has a heading for it')])
    })

    test('without link=true a metric no page documents does not warn', () => {
      const warn = warnings()
      convert('metric:redpanda_kafka_request_bytes_total[]', { catalog: streamingCatalog() })
      expect(warn).not.toHaveBeenCalled()
    })

    test('every interpolated attribute value is escaped', () => {
      expect(buildMetricContent({ name: 'a"b', family: 'a"b', docUrl: '/x"y' })).toBe('<code class="metric-ref" data-metric-name="a&quot;b" data-doc-url="/x&quot;y">a&quot;b</code>')
    })
  })

  describe('name resolution', () => {
    test.each(['_bucket', '_count', '_sum'])('a histogram series name (%s) renders as written and links its family', (suffix) => {
      const warn = warnings()
      const html = convert(`metric:redpanda_kafka_request_latency_seconds${suffix}[link=true]`, { catalog: streamingCatalog() })
      expect(html).toContain(`data-metric-name="redpanda_kafka_request_latency_seconds" data-metric-series="${suffix}"`)
      expect(html).toContain('<a href="reference:public-metrics-reference.adoc#redpanda_kafka_request_latency_seconds">')
      expect(html).toContain(`>redpanda_kafka_request_latency_seconds${suffix}</code></a>`)
      expect(warn).not.toHaveBeenCalled()
    })

    test('a gauge whose name ends in _sum is its own family, not a series', () => {
      const html = convert('metric:redpanda_kafka_consumer_group_lag_sum[]', { catalog: streamingCatalog() })
      expect(html).toContain('data-metric-name="redpanda_kafka_consumer_group_lag_sum"')
      expect(html).not.toContain('data-metric-series')
      const registry = metricValues.loadMetricsFor(streamingCatalog(), 'streaming', '26.2')
      expect(metricValues.resolveMetricName(registry, 'redpanda_kafka_consumer_group_lag_sum')).toEqual({ ok: true, family: 'redpanda_kafka_consumer_group_lag_sum', entry: SAMPLE.metrics.redpanda_kafka_consumer_group_lag_sum })
    })

    test('a series suffix on a family that is not a histogram is unknown, never guessed', () => {
      const warn = warnings()
      const html = convert('metric:redpanda_cluster_brokers_count[]', { catalog: streamingCatalog() })
      expect(html).toContain('<code>redpanda_cluster_brokers_count</code>')
      expect(messages(warn)[0]).toContain("'redpanda_cluster_brokers_count' is not in the metrics data")
    })

    test('an unknown name renders plain code and warns with the dataset and a suggestion', () => {
      const warn = warnings()
      const html = convert('metric:redpanda_cluster_broker[]', { catalog: streamingCatalog() })
      expect(html).toContain('<code>redpanda_cluster_broker</code>')
      expect(html).not.toContain('metric-ref')
      expect(messages(warn)).toEqual([expect.stringMatching(/^metric:redpanda_cluster_broker\[\] in modules\/manage\/pages\/example\.adoc: 'redpanda_cluster_broker' is not in the metrics data this page validates against \(redpanda-metrics-v26\.2\.7\.json from streaming@26\.2\)\..*Did you mean: redpanda_cluster_brokers/)])
    })

    test('a removed name renders plain code and says the release it was removed in', () => {
      const warn = warnings()
      const html = convert('metric:redpanda_example_removed_total[link=true]', { catalog: streamingCatalog() })
      expect(html).toContain('<code>redpanda_example_removed_total</code>')
      expect(messages(warn)).toEqual([expect.stringContaining("'redpanda_example_removed_total' was removed in v26.2")])
    })

    test('own keys only: toString and constructor are not metrics', () => {
      const warn = warnings()
      expect(convert('metric:toString[] metric:constructor[]', { catalog: streamingCatalog() })).not.toContain('metric-ref')
      expect(warn).toHaveBeenCalledTimes(2)
    })
  })

  describe('which data a page reads', () => {
    test('no content catalog: plain code, no warning', () => {
      const warn = warnings()
      expect(convert('metric:redpanda_cluster_brokers[]')).toContain('<code>redpanda_cluster_brokers</code>')
      expect(warn).not.toHaveBeenCalled()
    })

    test('no dataset anywhere: plain code and one warning per component version', () => {
      const warn = warnings()
      const html = convert('metric:redpanda_cluster_brokers[] metric:redpanda_cluster_brokers[]', { catalog: catalogOf([page('streaming', '26.2', 'x.adoc', '= X')]) })
      expect(html).not.toContain('metric-ref')
      expect(messages(warn)).toEqual([expect.stringContaining('no redpanda-metrics-<tag>.json attachment found')])
    })

    test('a page never borrows another release series\' data', () => {
      const warn = warnings()
      // 26.1 publishes no file of its own; the component has 26.2 data.
      const catalog = catalogOf([...streamingFiles('26.2'), page('streaming', '26.1', 'x.adoc', '= X')])
      const html = convert('metric:redpanda_cluster_brokers[]', { catalog, version: '26.1' })
      expect(html).toContain('<code>redpanda_cluster_brokers</code>')
      expect(html).not.toContain('metric-ref')
      expect(messages(warn)).toEqual([expect.stringContaining('streaming@26.1 publishes no redpanda-metrics-v26.1.*.json attachment')])
    })

    test('a page reads the newest patch of its own series', () => {
      const older = JSON.stringify({ ...SAMPLE, metrics: {} })
      const catalog = catalogOf([attachment('streaming', '26.2', 'v26.2.3', older), ...streamingFiles('26.2', 'v26.2.7')])
      expect(metricValues.loadMetricsFor(catalog, 'streaming', '26.2').tag).toBe('v26.2.7')
    })

    test('Cloud reads the newest GA streaming file, never a release candidate', () => {
      const rc = JSON.stringify({ ...SAMPLE, metrics: { redpanda_rc_only: { name: 'redpanda_rc_only', endpoint: 'public' } } })
      const catalog = catalogOf([...cloudFiles(), attachment('streaming', '26.3', 'v26.3.1-rc1', rc)], { cloud: { 'env-cloud': true } })
      const registry = metricValues.loadMetricsFor(catalog, 'cloud', '')
      expect([registry.tag, registry.surface]).toEqual(['v26.2.7', 'cloud'])
    })

    test('a component that is neither self-managed nor Cloud has no metrics data', () => {
      const catalog = catalogOf([...streamingFiles(), page('connect', '', 'x.adoc', '= X')])
      expect(metricValues.loadMetricsFor(catalog, 'connect', '')).toBeUndefined()
    })

    test('a file whose metrics is not an object is ignored, with a warning that names it', () => {
      const warn = warnings()
      const catalog = catalogOf([attachment('streaming', '26.2', 'v26.2.7', JSON.stringify({ metrics: [] }))])
      expect(convert('metric:redpanda_cluster_brokers[]', { catalog })).not.toContain('metric-ref')
      expect(messages(warn)[0]).toContain("redpanda-metrics-v26.2.7.json in streaming@26.2 has no usable 'metrics' object")
    })
  })

  describe('Cloud audience', () => {
    test('a public metric the Cloud stub includes links the Cloud page, never the self-managed one', () => {
      const warn = warnings()
      const html = onCloud('metric:redpanda_cluster_brokers[link=true]')
      expect(html).toContain('data-doc-url="/redpanda-cloud/reference/public-metrics-reference/#redpanda_cluster_brokers"')
      expect(html).toContain('<a href="reference:public-metrics-reference.adoc#redpanda_cluster_brokers">')
      expect(html).not.toContain('streaming')
      expect(warn).not.toHaveBeenCalled()
    })

    test('an internal metric renders plain code with a warning', () => {
      const warn = warnings()
      const html = onCloud('metric:vectorized_alien_receive_batch_queue_length[link=true]')
      expect(html).toContain('<code>vectorized_alien_receive_batch_queue_length</code>')
      expect(html).not.toContain('<a ')
      expect(messages(warn)).toEqual([expect.stringContaining('it is an internal metric (/metrics), which Redpanda Cloud does not expose')])
    })

    test('a metric whose availability says it is not on Cloud renders plain code with a warning', () => {
      const warn = warnings()
      // The Cloud stub would include its heading without the conditional;
      // availability alone decides here.
      const html = onCloud('metric:redpanda_cluster_health_refreshes_total[link=true]')
      expect(html).toContain('<code>redpanda_cluster_health_refreshes_total</code>')
      expect(messages(warn)).toEqual([expect.stringContaining('its availability in the metrics data says it is not on Redpanda Cloud')])
    })

    test('a metric with no reference page in the Cloud component renders plain code with a warning', () => {
      const warn = warnings()
      // Its heading is inside ifndef::env-cloud[] on the page the stub includes.
      const html = onCloud('metric:redpanda_kafka_consumer_group_lag_sum[link=true]')
      expect(html).toContain('<code>redpanda_kafka_consumer_group_lag_sum</code>')
      expect(html).not.toContain('<a ')
      expect(messages(warn)).toEqual([expect.stringContaining('cloud@unversioned has no reference page with a heading for it, and a Cloud page links only Cloud pages')])
    })

    test('the same metric links on the self-managed page that has the heading', () => {
      expect(convert('metric:redpanda_kafka_consumer_group_lag_sum[link=true]', { catalog: cloudCatalog() })).toContain('<a href="reference:public-metrics-reference.adoc#redpanda_kafka_consumer_group_lag_sum">')
    })

    test('page= names a Cloud page for a metric the index did not find', () => {
      const warn = warnings()
      const html = onCloud('metric:redpanda_kafka_consumer_group_lag_sum[link=true,page=monitor-cloud]')
      expect(html).toContain('<a href="reference:monitor-cloud.adoc#redpanda_kafka_consumer_group_lag_sum">')
      expect(warn).not.toHaveBeenCalled()
    })

    test('on a Serverless page, a metric that is not on Serverless renders plain code', () => {
      const warn = warnings()
      const html = onCloud('metric:redpanda_cluster_brokers[] metric:redpanda_kafka_request_latency_seconds[]', { attributes: { 'env-serverless': true } })
      expect(html).toContain('<code>redpanda_cluster_brokers</code>')
      expect(html).toContain('<code class="metric-ref" data-metric-name="redpanda_kafka_request_latency_seconds"')
      expect(messages(warn)).toEqual([expect.stringContaining('says it is not on Serverless, and this page sets env-serverless')])
    })

    test('each warning ends with the fix for its cause', () => {
      const warn = warnings()
      onCloud('metric:vectorized_alien_receive_batch_queue_length[]')
      onCloud('metric:redpanda_cluster_health_refreshes_total[]')
      onCloud('metric:redpanda_cluster_brokers[]', { attributes: { 'env-serverless': true } })
      onCloud('metric:redpanda_kafka_consumer_group_lag_sum[]')
      const [internal, notCloud, notServerless, noPage] = messages(warn)
      expect(internal).toMatch(/Put the sentence in an ifndef::env-cloud\[\] block\.$/)
      expect(notCloud).toMatch(/Put the sentence in an ifndef::env-cloud\[\] block\.$/)
      expect(notServerless).toMatch(/Put the sentence in an ifndef::env-serverless\[\] block, so that Dedicated and BYOC readers still see it\.$/)
      expect(notServerless).not.toContain('env-cloud[]')
      expect(noPage).toMatch(/If Redpanda Cloud has the metric, add its heading to the Cloud reference page, or set page=\. If it does not, put the sentence in an ifndef::env-cloud\[\] block\.$/)
    })

    test('the index reads the stub\'s include by tag and the conditionals of the included page', () => {
      const catalog = cloudCatalog()
      const cloud = buildMetricPageIndex(catalog, 'cloud', SAMPLE.metrics, '')
      expect([...cloud.keys()].sort()).toEqual(['redpanda_cluster_brokers', 'redpanda_example_deprecated_total', 'redpanda_kafka_request_latency_seconds'])
      expect(cloud.get('redpanda_cluster_brokers')).toEqual({ page: 'public-metrics-reference', url: '/redpanda-cloud/reference/public-metrics-reference/' })
      const streaming = buildMetricPageIndex(catalog, 'streaming', SAMPLE.metrics, '26.2')
      expect(streaming.has('redpanda_kafka_consumer_group_lag_sum')).toBe(true)
      expect(streaming.get('vectorized_alien_receive_batch_queue_length').page).toBe('internal-metrics-reference')
    })

    test('a conditional that wraps one fence of a block stays in step with the block', () => {
      // One opening fence per audience and a shared closing fence. The
      // preprocessor reads conditionals inside blocks too, so the self-managed
      // page closes the block at the last fence and renders the heading.
      const source = [
        '= Monitoring',
        '',
        'ifndef::env-cloud[]',
        '[source,bash]',
        '----',
        'curl http://localhost:9644/public_metrics',
        'endif::[]',
        'ifdef::env-cloud[]',
        '[source,bash]',
        '----',
        'curl https://example.com/public_metrics',
        'endif::[]',
        '----',
        '',
        '== redpanda_cluster_brokers',
        '',
      ].join('\n')
      const catalog = catalogOf([page('streaming', '26.2', 'monitoring.adoc', source)], { streaming: {} })
      expect([...buildMetricPageIndex(catalog, 'streaming', SAMPLE.metrics, '26.2').keys()]).toEqual(['redpanda_cluster_brokers'])
    })

    test('a stub that includes another tag indexes nothing', () => {
      const files = [...streamingFiles(), page('cloud', '', 'public-metrics-reference.adoc', '= Public Metrics\n\ninclude::streaming:reference:public-metrics-reference.adoc[tag=other]\n')]
      const catalog = catalogOf(files, { cloud: { 'env-cloud': true } })
      expect(buildMetricPageIndex(catalog, 'cloud', SAMPLE.metrics, '').size).toBe(0)
    })
  })

  describe('deprecated metrics', () => {
    test('a deprecated metric warns on every mention, and still renders marked', () => {
      const warn = warnings()
      const html = convert('metric:redpanda_example_deprecated_total[] metric:redpanda_example_deprecated_total[link=true]', { catalog: streamingCatalog() })
      expect(html.match(/class="metric-ref"/g)).toHaveLength(2)
      expect(messages(warn)).toEqual([
        expect.stringContaining("'redpanda_example_deprecated_total' is deprecated (v26.1)"),
        expect.stringContaining("'redpanda_example_deprecated_total' is deprecated (v26.1)"),
      ])
    })

    test('deprecated=ok silences it', () => {
      const warn = warnings()
      expect(convert('metric:redpanda_example_deprecated_total[deprecated=ok]', { catalog: streamingCatalog() })).toContain('metric-ref')
      expect(warn).not.toHaveBeenCalled()
    })

    test('only the literal ok counts', () => {
      const warn = warnings()
      convert('metric:redpanda_example_deprecated_total[deprecated=true]', { catalog: streamingCatalog() })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(metricValues.deprecationAcknowledged({ deprecated: ' OK ' })).toBe(true)
      expect(metricValues.deprecationAcknowledged({ deprecated: 'yes' })).toBe(false)
      expect(metricValues.deprecationAcknowledged({})).toBe(false)
      expect(metricValues.deprecationAcknowledged(undefined)).toBe(false)
    })

    test('deprecated: null in the data is not deprecated', () => {
      const warn = warnings()
      convert('metric:redpanda_cluster_brokers[]', { catalog: streamingCatalog() })
      expect(warn).not.toHaveBeenCalled()
    })
  })

  describe('metric-validate', () => {
    const attributes = (mode) => ({ 'metric-validate': mode })

    test('the throw kinds are the authoring errors', () => {
      expect(THROW_KINDS).toEqual(['unknown-metric', 'removed-metric'])
    })

    test.each([
      ['an unknown name', 'metric:redpanda_cluster_broker[]', /is not in the metrics data/],
      ['a removed name', 'metric:redpanda_example_removed_total[]', /was removed in v26\.2/],
    ])('error fails the build on %s', (_what, input, message) => {
      expect(() => convert(input, { catalog: streamingCatalog(), attributes: attributes('error') })).toThrow(message)
    })

    test('error never fails on a data gap: no data, no page, or a metric that is not for Cloud', () => {
      warnings()
      const none = catalogOf([page('streaming', '26.2', 'x.adoc', '= X')])
      expect(() => convert('metric:redpanda_cluster_brokers[]', { catalog: none, attributes: attributes('error') })).not.toThrow()
      expect(() => convert('metric:redpanda_kafka_request_bytes_total[link=true]', { catalog: streamingCatalog(), attributes: attributes('error') })).not.toThrow()
      expect(() => onCloud('metric:vectorized_alien_receive_batch_queue_length[] metric:redpanda_kafka_consumer_group_lag_sum[]', { attributes: attributes('error') })).not.toThrow()
    })

    test('error does not fail on a deprecated metric', () => {
      const warn = warnings()
      expect(() => convert('metric:redpanda_example_deprecated_total[]', { catalog: streamingCatalog(), attributes: attributes('error') })).not.toThrow()
      expect(warn).toHaveBeenCalledTimes(1)
    })

    test('off silences every warning, and the output is the same', () => {
      const warn = warnings()
      const input = 'metric:redpanda_cluster_broker[] metric:redpanda_example_removed_total[] metric:redpanda_example_deprecated_total[] metric:redpanda_kafka_request_bytes_total[link=true]'
      const html = convert(input, { catalog: streamingCatalog(), attributes: attributes('off') })
      expect(warn).not.toHaveBeenCalled()
      expect(html).toContain('<code>redpanda_cluster_broker</code>')
      convert('metric:redpanda_cluster_brokers[]', { catalog: catalogOf([page('streaming', '26.2', 'x.adoc', '= X')]), attributes: attributes('off') })
      onCloud('metric:vectorized_alien_receive_batch_queue_length[]', { attributes: attributes('off') })
      expect(warn).not.toHaveBeenCalled()
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

    test('an unlinked metric exports as a backticked name', () => {
      const html = convert('Watch metric:redpanda_cluster_brokers[] closely.', { catalog: streamingCatalog() })
      expect(markdown(html)).toContain('Watch `redpanda_cluster_brokers` closely.')
    })

    test('a linked metric exports as a backticked name with its link', () => {
      // As Antora writes the link: an href relative to the page.
      const html = convert('Watch metric:redpanda_cluster_brokers[link=true] closely.', { catalog: streamingCatalog() })
        .replace('reference:public-metrics-reference.adoc#', '../../reference/public-metrics-reference/#')
      expect(markdown(html)).toContain('Watch [`redpanda_cluster_brokers`](https://docs.example.com/current/reference/public-metrics-reference/#redpanda_cluster_brokers) closely.')
    })

    // Negative control: the export assertions must be able to fail.
    test('negative control: text that is not a metric: output is not backticked', () => {
      expect(markdown('<div class="paragraph"><p>Watch redpanda_cluster_brokers closely.</p></div>')).not.toContain('`redpanda_cluster_brokers`')
    })
  })

  // Negative control for the whole file: the fixture has no heading for this
  // metric and no such name, so asserting a link or a marker must fail.
  describe('negative control', () => {
    test('a name deliberately missing from the fixture is never marked or linked', () => {
      warnings()
      expect(SAMPLE.metrics.redpanda_not_in_fixture).toBeUndefined()
      const html = convert('metric:redpanda_not_in_fixture[link=true]', { catalog: streamingCatalog() })
      expect(html).toContain('<code>redpanda_not_in_fixture</code>')
      expect(html).not.toContain('metric-ref')
      expect(html).not.toContain('<a ')
    })

    test('a dataset without the metric changes the result for a name that otherwise resolves', () => {
      warnings()
      const without = JSON.parse(SAMPLE_JSON)
      delete without.metrics.redpanda_cluster_brokers
      const catalog = catalogOf([attachment('streaming', '26.2', 'v26.2.7', JSON.stringify(without))])
      expect(convert('metric:redpanda_cluster_brokers[]', { catalog })).not.toContain('metric-ref')
      expect(convert('metric:redpanda_cluster_brokers[]', { catalog: streamingCatalog() })).toContain('metric-ref')
    })
  })
})
