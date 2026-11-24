'use strict'

/* The metrics dataset and the field values metricval: renders from it.
 *
 * The data is redpanda-metrics-<tag>.json, an attachment of a reference
 * module, written by doc-tools generate metrics-docs. It has one entry per
 * metric family under `metrics`, keyed by the family name, and a `removed`
 * map of the names earlier releases had.
 *
 * A page picks its dataset exactly as prop: picks property data
 * (extension-utils/attachment-datasets.js): a self-managed page reads its own
 * release series, a Cloud (env-cloud) page reads the newest GA streaming
 * file, and anything else has none.
 *
 * Shared by metric: (macros/metric.js) and metricval: (macros/metricval.js),
 * so a name resolves the same way in both.
 */

const datasets = require('./attachment-datasets')
const { escapeHtml } = require('./html-utils')
const { defineFields } = require('./value-fields')
const { normalizeSeeAlso } = require('../tools/property-extractor/helpers/seeAlsoView')
const logger = require('@antora/logger')('metric-macro')

const { SURFACE_CLOUD, isPlainObject } = datasets

const FORMAT_HUMAN = 'human'
const FORMAT_RAW = 'raw'

const METRICS_JSON_RX = /^redpanda-metrics-(v\d+\.\d+\.\d+(?:-[\w.]+)?)\.json$/

const $metricsRegistry = Symbol('$metricsRegistry')
const $metricsSeriesGap = Symbol('$metricsSeriesGap')

const NOT_OBJECT = "has no usable 'metrics' object"

// The dataset layout these macros read. A file with another version may name
// or shape its fields differently, so it is not read at all.
const SCHEMA_VERSION = 1

function validateDataset (data) {
  if (!isPlainObject(data.metrics)) return NOT_OBJECT
  if (data.schema_version !== SCHEMA_VERSION) {
    const found = data.schema_version === undefined ? 'has no schema_version' : `has schema_version ${JSON.stringify(data.schema_version)}`
    return `${found}, and this release of the metric macros reads schema_version ${SCHEMA_VERSION}`
  }
  return true
}

// The metrics dataset as the shared loader sees it.
const METRICS_KIND = {
  name: 'metrics',
  module: 'reference',
  rx: METRICS_JSON_RX,
  filePrefix: 'redpanda-metrics-',
  label: 'metrics data',
  regenerate: "'npx doc-tools generate metrics-docs'",
  borrowWhen: ['env-cloud'],
  lenders: ['streaming', 'ROOT'],
  cacheSymbol: $metricsRegistry,
  gapSymbol: $metricsSeriesGap,
  keyPrefix: 'metrics:',
  invalidKey: 'nometrics',
  // Must be a plain object of name -> entry. A string, number, or array
  // parses fine and would then make every metric: target look like a typo.
  validate: validateDataset,
  notObjectReason: NOT_OBJECT,
  decorate: (registry) => {
    registry.metrics = registry.data.metrics
    registry.removed = isPlainObject(registry.data.removed) ? registry.data.removed : {}
  },
  logger,
  text: {
    log: 'metric macro',
    macro: 'metric:',
    attachment: 'metrics attachment',
    releaseNoun: 'metrics',
    effect: (where) => `metric: targets${where} are therefore not validated and their tooltips carry no data`,
    generateSeries: (series) => `'npx doc-tools generate metrics-docs --tag v${series}.<patch>'`,
    noData: (component, version) =>
      `metric macro: no redpanda-metrics-<tag>.json attachment found in any component's reference module for ${component || 'unknown component'}@${version || 'unversioned'}; ` +
      'metric: targets are not validated and their tooltips carry no data. Publish the metrics JSON as a reference-module attachment in this component or in streaming.',
  },
}

/**
 * The metrics data for one page's component and version, or undefined.
 */
function loadMetricsFor (contentCatalog, component, version) {
  return datasets.loadDatasetFor(contentCatalog, component, version, METRICS_KIND)
}

/**
 * Which metrics JSON a page was checked against, named in every warning.
 */
function describeDataset (registry) {
  return datasets.describeDataset({ kind: METRICS_KIND, ...registry })
}

const own = (object, key) => Boolean(object) && Object.prototype.hasOwnProperty.call(object, key)

// The series a histogram exposes beside its family name.
const SERIES_SUFFIXES = ['_bucket', '_count', '_sum']

/**
 * Resolve a metric name as written to its family in the data.
 *
 * In order: the exact family name; a histogram series name
 * (<family>_bucket, _count or _sum) whose family has a histogram in the
 * data; a name an earlier release had; else unknown. The suffix alone never
 * decides: redpanda_kafka_consumer_group_lag_sum is a gauge family of its
 * own, and matches exactly.
 *
 * @returns {{ok: true, family: string, entry: object, series?: string} |
 *   {ok: false, kind: 'removed-metric', removed: object} |
 *   {ok: false, kind: 'unknown-metric', suggestions: string[]}}
 */
function resolveMetricName (registry, name) {
  const metrics = registry.metrics
  if (own(metrics, name) && isPlainObject(metrics[name])) return { ok: true, family: name, entry: metrics[name] }
  for (const suffix of SERIES_SUFFIXES) {
    if (!name.endsWith(suffix)) continue
    const family = name.slice(0, -suffix.length)
    if (own(metrics, family) && isPlainObject(metrics[family]) && isPlainObject(metrics[family].histogram)) {
      return { ok: true, family, entry: metrics[family], series: suffix }
    }
  }
  if (own(registry.removed, name)) {
    return { ok: false, kind: 'removed-metric', removed: isPlainObject(registry.removed[name]) ? registry.removed[name] : {} }
  }
  return { ok: false, kind: 'unknown-metric', suggestions: datasets.suggest(name, Object.keys(metrics)) }
}

/**
 * The sentence for a name that did not resolve, without the call.
 */
function unresolvedSentence (registry, name, resolved) {
  if (resolved.kind === 'removed-metric') {
    const release = typeof resolved.removed.removed === 'string' && resolved.removed.removed
    return `'${name}' was removed in ${release || 'an earlier release'}, so it is not in the metrics data this page validates against (${describeDataset(registry)}). Remove the mention, or move it to content for a release that has the metric.`
  }
  const hint = resolved.suggestions.length ? ` Did you mean: ${resolved.suggestions.join(', ')}?` : ''
  return `'${name}' is not in the metrics data this page validates against (${describeDataset(registry)}). Either the name is misspelled or the metric does not exist in that release.${hint}`
}

const NOT_ON_SERVERLESS = 'its availability in the metrics data says it is not on Serverless, and this page sets env-serverless'

/**
 * Why a metric is not for the readers of a Cloud page, or undefined when it
 * is, or when the page is not a Cloud page.
 *
 * @param {boolean} [serverless] - The page sets env-serverless.
 */
function cloudUnavailableReason (registry, entry, { serverless = false } = {}) {
  if (registry.surface !== SURFACE_CLOUD) return undefined
  if (entry.endpoint === 'internal') return 'it is an internal metric (/metrics), which Redpanda Cloud does not expose'
  const availability = entry.availability
  if (!isPlainObject(availability)) return undefined
  if (['dedicated', 'byoc', 'serverless'].every((key) => availability[key] === false)) return 'its availability in the metrics data says it is not on Redpanda Cloud'
  if (serverless && availability.serverless === false) return NOT_ON_SERVERLESS
  return undefined
}

/**
 * What to do about a metric that is not for a Cloud page's readers. The fix
 * depends on the cause.
 *
 * @param {string} unavailable - The reason, from resolveMetric.
 * @param {string} unavailableKind - 'unavailable' or 'cloud-no-page'.
 * @param {boolean} [page] - The macro takes page=, as metric: does.
 */
function cloudAdvice (unavailable, unavailableKind, { page = false } = {}) {
  if (unavailableKind === 'cloud-no-page') {
    return `If Redpanda Cloud has the metric, add its heading to the Cloud reference page${page ? ', or set page=' : ''}. If it does not, put the sentence in an ifndef::env-cloud[] block.`
  }
  if (unavailable === NOT_ON_SERVERLESS) return 'Put the sentence in an ifndef::env-serverless[] block, so that Dedicated and BYOC readers still see it.'
  return 'Put the sentence in an ifndef::env-cloud[] block.'
}

// Every field metricval: supports. `rich` marks text values (AsciiDoc),
// which the inline form renders only when they are one paragraph.
const FIELD_SET = defineFields('metricval:', {
  description: { rich: true },
  type: {},
  unit: {},
  labels: {},
  values: {},
  endpoint: {},
  buckets: {},
  category: {},
  'use-cases': {},
  usage: { rich: true },
  requires: { rich: true },
  introduced: {},
  deprecated: {},
  removed: {},
  status: {},
  'see-also': { rich: true },
  'cloud-access': {},
}, {
  availability: 'cloud-access',
  use_cases: 'use-cases',
  units: 'unit',
})
const { FIELDS } = FIELD_SET
const normalizeField = FIELD_SET.normalizeField

// The fields the generator writes. Every other field, and the complete list
// of a label's values, is curated in the overrides file.
const GENERATED_FIELDS = ['description', 'type', 'unit', 'labels', 'endpoint', 'buckets']
const OVERRIDES_FILE = 'docs-data/metric-overrides.json'
// Release history is worked out by comparing releases, never typed by hand.
const HISTORY_FIELDS = ['introduced', 'deprecated', 'removed', 'status']

const ENDPOINT_PATHS = { public: '/public_metrics', internal: '/metrics' }
const DEPLOYMENTS = [['self_managed', 'Self-Managed'], ['dedicated', 'Dedicated'], ['byoc', 'BYOC'], ['serverless', 'Serverless']]

const plain = (text) => ({ ok: true, text: String(text) })
const missing = () => ({ ok: false, reason: 'missing' })
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
const richText = (value) => ({ ok: true, text: value, rich: { kind: 'text', text: value, format: 'asciidoc' } })
const richList = (items) => ({ ok: true, text: items.join(', '), rich: { kind: 'list', items, format: 'asciidoc' } })
// Each item in its own code element, comma-separated.
const codeList = (items, raw) => (raw
  ? plain(JSON.stringify(items))
  : { ok: true, text: items.join(', '), html: items.map((item) => `<code>${escapeHtml(item)}</code>`).join(', ') })
const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : [])

/**
 * The value of one field of one metric entry.
 *
 * @param {object} entry - One value of the JSON's metrics object.
 * @param {string} field - A field name or alias.
 * @param {object} [opts]
 * @param {'human'|'raw'} [opts.format] - human (default) or the stored value.
 * @param {string} [opts.label] - The label whose values the values field reads.
 * @param {boolean} [opts.cloud] - The page renders for Cloud, which decides
 *   which see-also items apply.
 * @returns {{ok: true, text: string, html?: string, rich?: object} |
 *   {ok: false, reason: 'unsupported'|'missing'|'label-required'|'unknown-label', labels?: string[]}}
 */
function fieldValue (entry, field, { format = FORMAT_HUMAN, label, cloud = false } = {}) {
  const name = normalizeField(field)
  if (!name) return { ok: false, reason: 'unsupported' }
  const raw = format === FORMAT_RAW
  const labels = (Array.isArray(entry.labels) ? entry.labels : []).filter((item) => isPlainObject(item) && text(item.name))

  switch (name) {
    case 'description': {
      // The text for every reader, then the text for this page's audience
      // only: Cloud on a Cloud page, Self-Managed on any other. The audience
      // text continues the last paragraph, so adding it to the data never
      // turns a one-paragraph description into one that needs the block form.
      const audience = strings(cloud ? entry.description_cloud_only : entry.description_self_managed_only)
      const parts = [text(entry.description), ...audience.map(text)].filter(Boolean)
      return parts.length ? richText(parts.join(' ')) : missing()
    }
    case 'usage':
      return text(entry[name]) ? richText(text(entry[name])) : missing()
    case 'type':
    case 'unit':
    case 'category':
    case 'introduced':
    case 'removed':
      return text(entry[name]) ? plain(text(entry[name])) : missing()
    case 'labels': {
      const names = labels.map((item) => item.name)
      if (names.length) return codeList(names, raw)
      // An empty list is a fact for a metric the scrape saw. For one it did
      // not see, the labels are not known.
      if (entry.observed === false) return missing()
      return plain(raw ? '[]' : 'none')
    }
    case 'values': {
      // The complete list only. observed_values is what one scrape saw, so
      // it is never offered as the set of values.
      const wanted = text(label)
      const names = labels.map((item) => item.name)
      if (!wanted) return { ok: false, reason: 'label-required', labels: names }
      const found = labels.find((item) => item.name === wanted)
      if (!found) return { ok: false, reason: 'unknown-label', labels: names }
      const values = strings(found.values)
      return values.length ? codeList(values, raw) : missing()
    }
    case 'endpoint': {
      if (!own(ENDPOINT_PATHS, entry.endpoint)) return missing()
      if (raw) return plain(entry.endpoint)
      const path = ENDPOINT_PATHS[entry.endpoint]
      return { ok: true, text: path, html: `<code>${escapeHtml(path)}</code>` }
    }
    case 'buckets': {
      const buckets = isPlainObject(entry.histogram) ? strings(entry.histogram.buckets) : []
      if (!buckets.length) return missing()
      return plain(raw ? JSON.stringify(buckets) : buckets.join(', '))
    }
    case 'use-cases': {
      const cases = strings(entry.use_cases)
      if (!cases.length) return missing()
      return plain(raw ? JSON.stringify(cases) : cases.join(', '))
    }
    case 'requires': {
      // A list of {property, value} and {condition} items, or text. A
      // condition is a sentence about cluster state that no property sets,
      // such as "The cluster has a shadow link."
      if (text(entry.requires)) return richText(text(entry.requires))
      const items = (Array.isArray(entry.requires) ? entry.requires : [])
        .filter((item) => isPlainObject(item) && (text(item.property) || text(item.condition)))
      if (!items.length) return missing()
      if (raw) return plain(JSON.stringify(items))
      // A link, not only a tooltip: a reader who is missing the metric needs
      // the property's page to turn it on. prop: checks the name against the
      // property data for the page's release and finds the page.
      const property = (item) => (item.value === undefined ? `prop:${item.property}[link=true]` : `prop:${item.property}[link=true] is \`${String(item.value)}\``)
      // Conditions are sentences, so with any of them the whole value reads
      // as sentences. Property values alone stay a comma-separated list.
      if (items.every((item) => text(item.property))) return richList(items.map(property))
      return richText(items.map((item) => (text(item.property) ? `${property(item)}.` : text(item.condition))).join(' '))
    }
    case 'deprecated': {
      // A release or a note counts as deprecated. null says it is not.
      if (!own(entry, 'deprecated') || entry.deprecated === undefined) return missing()
      if (raw) return plain(entry.deprecated === null ? 'false' : String(entry.deprecated))
      return plain(entry.deprecated ? 'yes' : 'no')
    }
    case 'status': {
      if (text(entry.status)) return plain(text(entry.status))
      if (!own(entry, 'deprecated') || entry.deprecated === undefined) return missing()
      return plain(entry.deprecated ? 'deprecated' : 'stable')
    }
    case 'see-also': {
      const properties = strings(entry.related_properties).map((property) => `prop:${property}[link=true]`)
      const topics = normalizeSeeAlso(entry).filter((item) => (cloud ? !item.selfManagedOnly : !item.cloudOnly)).map((item) => item.content)
      const items = [...properties, ...topics]
      return items.length ? richList(items) : missing()
    }
    case 'cloud-access': {
      const availability = entry.availability
      if (!isPlainObject(availability)) return missing()
      if (raw) return plain(JSON.stringify(availability))
      const where = DEPLOYMENTS.filter(([key]) => availability[key] === true).map(([, title]) => title)
      return plain(where.length ? where.join(', ') : 'not available')
    }
    default:
      return { ok: false, reason: 'unsupported' }
  }
}

/**
 * Resolve one metricval: call to its value, or to the reason there is none.
 *
 * @param {object} opts
 * @param {object} [opts.registry] - From loadMetricsFor.
 * @param {string} opts.name - The metric name as written.
 * @param {string} opts.field - The field as written.
 * @param {string} [opts.unavailable] - Why the metric is not for this page's
 *   readers (see metric-links.js), when it is not.
 * @param {string} [opts.unavailableKind]
 * @returns {{ok: true, text: string, html?: string, rich?: object, field: string, family: string, entry: object, call: string} |
 *   {ok: false, kind: string, message: string, field: string}}
 */
function resolveMetricValue ({ registry, name, field: requested, format = FORMAT_HUMAN, label, filePath, block = false, resolved, unavailable, unavailableKind = 'unavailable' }) {
  const field = normalizeField(requested)
  const attrs = [requested, ...(label ? [`label=${label}`] : [])].join(',')
  const call = `metricval${block ? '::' : ':'}${name}[${attrs}]${filePath ? ` in ${filePath}` : ''}`
  if (!String(requested).trim()) {
    // A metric has no field that stands for it, as default does for a property.
    return { ok: false, kind: 'unsupported-field', field: 'value', message: `${call}: names no field, so it renders <unknown value>. Write one, as in metricval:${name}[type]. Supported fields: ${Object.keys(FIELDS).join(', ')}.` }
  }
  if (!field) {
    return { ok: false, kind: 'unsupported-field', field: requested, message: FIELD_SET.unsupportedMessage(call, requested) }
  }
  if (!registry) {
    return { ok: false, kind: 'no-data', field, message: `${call}: this page has no metrics data to read '${field}' from (see the metric macro warning for this component version), so it renders <unknown ${field}> rather than a value from another release.` }
  }
  const found = resolved || resolveMetricName(registry, name)
  if (!found.ok) {
    // The release a name was removed in is the one thing the data still
    // says about it.
    if (found.kind === 'removed-metric' && field === 'removed' && text(found.removed.removed)) {
      return { ok: true, field, family: name, entry: found.removed, text: text(found.removed.removed), call }
    }
    return { ok: false, kind: found.kind, field, message: `${call}: ${unresolvedSentence(registry, name, found)}` }
  }
  if (unavailable) {
    return { ok: false, kind: unavailableKind, field, family: found.family, entry: found.entry, message: `${call}: '${found.family}' is not for readers of this Cloud page: ${unavailable}. No value is shown, so it renders <unknown ${field}>. ${cloudAdvice(unavailable, unavailableKind)}` }
  }
  const value = fieldValue(found.entry, field, { format, label, cloud: registry.surface === SURFACE_CLOUD })
  const base = { field, family: found.family, entry: found.entry }
  if (!value.ok && value.reason === 'label-required') {
    if (!value.labels.length) {
      return { ok: false, kind: 'label-required', ...base, message: `${call}: the values field reads one label's values, and '${found.family}' has no labels in ${describeDataset(registry)}, so it has no label values. Remove the call.` }
    }
    return { ok: false, kind: 'label-required', ...base, message: `${call}: the values field reads one label's values, so it needs label=<label name>, as in metricval:${name}[values,label=${value.labels[0]}]. The labels of '${found.family}': ${value.labels.join(', ')}.` }
  }
  if (!value.ok && value.reason === 'unknown-label') {
    const labels = value.labels.length ? `Its labels: ${value.labels.join(', ')}.` : 'It has no labels in the data.'
    return { ok: false, kind: 'unknown-label', ...base, message: `${call}: '${found.family}' has no label '${label}' in ${describeDataset(registry)}, so it renders <unknown ${field}>. ${labels}` }
  }
  if (!value.ok) {
    const what = field === 'values'
      ? `no complete list of values for the label '${label}' (values seen in a scrape are not a complete list, so they are never rendered)`
      : `no ${field}`
    // Labels are missing only for a metric the scrape did not see.
    const source = field === 'labels'
      ? 'The scrape did not see this metric, so its labels are not known.'
      : (GENERATED_FIELDS.includes(field)
          ? 'The generator writes it only when the metric has one.'
          : HISTORY_FIELDS.includes(field)
            ? 'The generator works it out by comparing releases, and this data has no release history yet.'
            : `Curated fields come from ${OVERRIDES_FILE}.`)
    return { ok: false, kind: 'missing-field', ...base, message: `${call}: '${found.family}' has ${what} in ${describeDataset(registry)}, so it renders <unknown ${field}>. The field is not in the data for this metric. ${source}` }
  }
  return { ok: true, ...base, text: value.text, html: value.html, rich: value.rich, call }
}

/**
 * Whether the data marks a metric deprecated: a release, a note, or true.
 */
const isDeprecated = (entry) => Boolean(entry && entry.deprecated)

/**
 * The warning for a mention of a deprecated metric, without the call.
 */
function deprecationSentence (family, entry) {
  const since = text(entry.deprecated) ? ` (${text(entry.deprecated)})` : ''
  return `'${family}' is deprecated${since}. Name the metric that replaces it, or add deprecated=ok when the page mentions it on purpose.`
}

// Whether a macro call acknowledges that it names something deprecated:
// deprecated=ok, and only the exact value ok, so a typo such as
// deprecated=true is not taken as an acknowledgement.
// TODO: switch to deprecationAcknowledged in extension-utils/deprecation-ack.js
// when that shared helper lands on main. This matches its behavior.
function deprecationAcknowledged (attributes) {
  if (!attributes) return false
  const value = attributes.deprecated
  return typeof value === 'string' && value.trim().toLowerCase() === 'ok'
}

const VALUE_ROLE = 'metric-value'
const UNKNOWN_VALUE_ROLE = 'metric-value-unknown'

/**
 * The HTML emitted for one metricval: instance.
 *
 * @param {object} opts
 * @param {string} opts.name - The metric family, or the name as written when
 *   it did not resolve.
 * @param {string} opts.field - Canonical (or as-written, for a placeholder) field.
 * @param {string} [opts.text] - The value, as plain text.
 * @param {string} [opts.html] - Pre-escaped markup, used instead of text.
 * @param {boolean} [opts.unknown] - Render the placeholder instead.
 */
function buildMetricvalContent ({ name, field, text: value, html, unknown = false }) {
  const attrs = `data-metric="${escapeHtml(name)}" data-field="${escapeHtml(field)}"`
  if (unknown) {
    return `<span class="${VALUE_ROLE} ${UNKNOWN_VALUE_ROLE}" ${attrs}>${escapeHtml(`<unknown ${field}>`)}</span>`
  }
  return `<span class="${VALUE_ROLE}" ${attrs}>${html !== undefined ? html : escapeHtml(value)}</span>`
}

module.exports = {
  METRICS_KIND,
  METRICS_JSON_RX,
  SERIES_SUFFIXES,
  FIELD_SET,
  FIELDS,
  FORMAT_HUMAN,
  FORMAT_RAW,
  VALUE_ROLE,
  normalizeField,
  loadMetricsFor,
  describeDataset,
  resolveMetricName,
  unresolvedSentence,
  cloudUnavailableReason,
  cloudAdvice,
  GENERATED_FIELDS,
  fieldValue,
  resolveMetricValue,
  isDeprecated,
  deprecationSentence,
  deprecationAcknowledged,
  buildMetricvalContent,
  logger,
}
