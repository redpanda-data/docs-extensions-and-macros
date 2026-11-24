'use strict'

// metric: through Antora's own AsciiDoc loader and HTML converter, which turn
// the macro's xref node into a link exactly as they do for xref:[] in the
// source. No logger mock here: the loader needs the real one.

const loadAsciiDoc = require('@antora/asciidoc-loader')
const { cloudFiles } = require('../helpers/metrics-catalog')

function build (component, version, attributes = {}) {
  const files = cloudFiles()
  const asked = []
  const versions = { streaming: '26.2', cloud: '' }
  const catalog = {
    findBy: (query) => files.filter((file) => Object.entries(query).every(([key, value]) => file.src[key] === value)),
    getComponent: (name) => {
      if (!(name in versions)) return undefined
      const entry = { version: versions[name], asciidoc: { attributes: name === 'cloud' ? { 'env-cloud': true } : {} } }
      return { name, versions: [entry], latest: entry }
    },
    resolveResource: (spec, context) => {
      asked.push(spec)
      return files.find((file) => file.src.family === 'page' && file.src.component === context.component && file.src.version === context.version && `${file.src.module}:${file.src.relative}` === spec)
    },
  }
  const file = {
    contents: Buffer.from('= Example\n\nWatch metric:redpanda_cluster_brokers[link=true] and metric:redpanda_kafka_request_latency_seconds_bucket[link=true].'),
    src: { component, version, module: 'manage', family: 'page', relative: 'example.adoc', path: 'modules/manage/pages/example.adoc' },
    pub: { url: component === 'cloud' ? '/redpanda-cloud/manage/example/' : '/current/manage/example/', moduleRootPath: '..' },
  }
  const html = loadAsciiDoc(file, catalog, { extensions: [require('../../macros/prop')], attributes }).convert()
  return { html, asked }
}

test('Antora resolves the metric: link to the reference page of the page\'s own component version, with the family anchor', () => {
  const { html, asked } = build('streaming', '26.2')
  expect(asked).toEqual(['reference:public-metrics-reference.adoc', 'reference:public-metrics-reference.adoc'])
  expect(html).toContain('<a href="../../reference/public-metrics-reference/#redpanda_cluster_brokers" class="xref page"><code class="metric-ref" data-metric-name="redpanda_cluster_brokers" data-doc-url="/current/reference/public-metrics-reference/#redpanda_cluster_brokers">redpanda_cluster_brokers</code></a>')
  expect(html).toContain('<a href="../../reference/public-metrics-reference/#redpanda_kafka_request_latency_seconds" class="xref page">')
  expect(html).toContain('>redpanda_kafka_request_latency_seconds_bucket</code></a>')
})

test('on a Cloud page the link is the Cloud stub that includes the self-managed page', () => {
  const { html } = build('cloud', '')
  expect(html).toContain('<a href="../../reference/public-metrics-reference/#redpanda_cluster_brokers" class="xref page"><code class="metric-ref" data-metric-name="redpanda_cluster_brokers" data-doc-url="/redpanda-cloud/reference/public-metrics-reference/#redpanda_cluster_brokers">')
  expect(html).not.toContain('/current/')
})
