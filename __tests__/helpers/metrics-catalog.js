'use strict'

// A content catalog with metrics data and reference pages, for the metric:
// and metricval: tests.

const fs = require('fs')
const path = require('path')

// A hand-trimmed subset of a real redpanda-metrics-v26.2.7.json: one gauge,
// one counter, one histogram, one labeled gauge, a gauge whose name ends in
// _sum, one internal metric and two the scrape did not see (observed:
// false). The generator's fields are as it wrote them. These were added by
// hand, as the overrides file will supply them:
//
//   redpanda_cluster_brokers                 category, use_cases, usage,
//                                            availability (not Serverless),
//                                            introduced, deprecated: null,
//                                            related_properties, related_topics
//   redpanda_kafka_request_latency_seconds   a label description and complete
//                                            values, a two-paragraph usage,
//                                            availability
//   redpanda_cluster_health_refreshes_total  requires, availability (not Cloud)
//   redpanda_example_deprecated_total        made up, with deprecated
//   removed.redpanda_example_removed_total   made up
//
// redpanda_kafka_request_bytes_total has no hand-added field, so every
// override field on it must render the placeholder.
const SAMPLE_PATH = path.join(__dirname, '..', 'fixtures', 'metrics', 'redpanda-metrics-v26.2.7-sample.json')
const SAMPLE = JSON.parse(fs.readFileSync(SAMPLE_PATH, 'utf8'))
const SAMPLE_JSON = JSON.stringify(SAMPLE)

function attachment (component, version, tag, json = SAMPLE_JSON) {
  return {
    src: { component, version, module: 'reference', family: 'attachment', relative: `redpanda-metrics-${tag}.json` },
    contents: Buffer.from(json),
  }
}

function page (component, version, relative, contents, url) {
  return {
    src: { component, version, module: 'reference', family: 'page', relative },
    contents: Buffer.from(contents),
    pub: url ? { url } : undefined,
  }
}

// The self-managed reference page, shaped like the real one: the whole page
// in one tag, and the metrics Cloud does not have in ifndef::env-cloud[].
const PUBLIC_PAGE = [
  '= Public Metrics',
  '// tag::single-source[]',
  '',
  '== Cluster metrics',
  '',
  '=== redpanda_cluster_brokers',
  '',
  'Text.',
  '',
  'ifndef::env-cloud[]',
  '=== redpanda_cluster_health_refreshes_total',
  '',
  'Text.',
  '',
  '=== redpanda_kafka_consumer_group_lag_sum',
  '',
  'Text.',
  'endif::[]',
  '',
  '=== redpanda_kafka_request_latency_seconds',
  '',
  '=== redpanda_example_deprecated_total',
  '',
  '// end::single-source[]',
].join('\n')

const INTERNAL_PAGE = '= Internal Metrics\n\n=== vectorized_alien_receive_batch_queue_length\n\nText.\n'

// The Cloud stub: the self-managed page, included by tag.
const CLOUD_STUB = '= Public Metrics\n\ninclude::streaming:reference:public-metrics-reference.adoc[tag=single-source]\n'

const streamingFiles = (version = '26.2', tag = 'v26.2.7') => [
  attachment('streaming', version, tag),
  page('streaming', version, 'public-metrics-reference.adoc', PUBLIC_PAGE, '/current/reference/public-metrics-reference/'),
  page('streaming', version, 'internal-metrics-reference.adoc', INTERNAL_PAGE, '/current/reference/internal-metrics-reference/'),
]

const cloudFiles = () => [
  ...streamingFiles(),
  page('cloud', '', 'public-metrics-reference.adoc', CLOUD_STUB, '/redpanda-cloud/reference/public-metrics-reference/'),
]

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

const streamingCatalog = () => catalogOf(streamingFiles())
const cloudCatalog = () => catalogOf(cloudFiles(), { cloud: { 'env-cloud': true } })

function convert (input, { catalog, attributes = {}, component = 'streaming', version = '26.2' } = {}) {
  const { register } = require('../../macros/prop')
  const Asciidoctor = require('@asciidoctor/core')()
  const registry = Asciidoctor.Extensions.create()
  register(registry, catalog && {
    contentCatalog: catalog,
    file: { src: { path: 'modules/manage/pages/example.adoc', component, version, module: 'manage' } },
  })
  return Asciidoctor.convert(input, { extension_registry: registry, attributes })
}

const onCloud = (input, options = {}) => convert(input, { catalog: cloudCatalog(), component: 'cloud', version: '', ...options })

module.exports = {
  SAMPLE,
  SAMPLE_JSON,
  PUBLIC_PAGE,
  CLOUD_STUB,
  attachment,
  page,
  streamingFiles,
  cloudFiles,
  catalogOf,
  streamingCatalog,
  cloudCatalog,
  convert,
  onCloud,
}
