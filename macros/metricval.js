'use strict'

/* Inline macro for one value of a Redpanda metric, read from the published
 * metrics data instead of typed by hand:
 *
 *   metricval:redpanda_cluster_brokers[type]                            -> gauge
 *   metricval:redpanda_kafka_request_latency_seconds[unit]              -> seconds
 *   metricval:redpanda_kafka_request_latency_seconds[labels]            -> redpanda_request
 *   metricval:redpanda_kafka_request_latency_seconds[values,label=redpanda_request]
 *   metricval:redpanda_cluster_brokers[endpoint]                        -> /public_metrics
 *   metricval:redpanda_cluster_brokers[endpoint,format=raw]             -> public
 *
 * The target is the metric name and the first attribute is the field, named
 * as every value macro names it (extension-utils/value-fields.js). A
 * histogram series name reads its family.
 *
 * Text longer than one paragraph renders only in the block form, on a line
 * of its own:
 *
 *   metricval::redpanda_cluster_brokers[description]
 *
 * The data, the name resolution and the Cloud rules are metric:'s
 * (macros/metric.js). Whenever no verified value exists the macro renders
 * <unknown FIELD> and says why, according to metric-validate (warn, error or
 * off). See macros/REFERENCE.adoc.
 *
 * Registered by macros/prop, so every playbook that registers prop: has it.
 */

const datasets = require('../extension-utils/attachment-datasets')
const valueDescriptions = require('../extension-utils/value-descriptions')
const metricValues = require('../extension-utils/metric-values')
const metricLinks = require('../extension-utils/metric-links')

const logger = metricValues.logger

// Kinds that fail the build in error mode: authoring errors. Data gaps
// (no-data, missing-field, unknown-label) and a metric that is not for
// Cloud readers never do.
const THROW_KINDS = ['unknown-metric', 'unsupported-field', 'removed-metric', 'label-required', 'needs-block', 'block-form-inline']

/**
 * Resolve one metricval: or metricval:: call on a page, the part the inline
 * and block forms share.
 */
function metricvalCall (config, parent, target, attributes, { block = false } = {}) {
  const document = parent.getDocument()
  const mode = String(document.getAttribute('metric-validate', 'warn')).trim().toLowerCase()
  const src = (config && config.file && config.file.src) || {}
  const filePath = src.path
  const component = src.component || ''
  const version = src.version || ''
  const where = filePath ? ` in ${filePath}` : ''
  const written = String(target).trim()
  const requested = String(attributes.field == null ? '' : attributes.field).trim()
  const label = attributes.label == null ? undefined : String(attributes.label).trim()
  let format = String(attributes.format || metricValues.FORMAT_HUMAN).trim().toLowerCase()
  if (format !== metricValues.FORMAT_HUMAN && format !== metricValues.FORMAT_RAW) {
    if (mode !== 'off') logger.warn(`metricval:${written}[${requested}]${where}: format=${format} is not supported; use format=raw for the stored value. Rendering the human-readable value.`)
    format = metricValues.FORMAT_HUMAN
  }
  // metricval::x[] inside a sentence reaches the inline macro with the
  // second colon at the start of the target.
  if (!block && written.startsWith(':')) {
    const name = written.slice(1)
    const field = metricValues.normalizeField(requested) || requested
    return { mode, name, result: { ok: false, kind: 'block-form-inline', field, message: `metricval:${written}[${requested}]${where}: metricval:: is the block form, which renders only on a line of its own. In a sentence, write metricval:${name}[${requested}].` } }
  }
  const name = written

  const contentCatalog = config && config.contentCatalog
  const registry = contentCatalog ? metricValues.loadMetricsFor(contentCatalog, component, version) : undefined
  if (!registry && contentCatalog && mode !== 'off') {
    // The same once-per-component-version diagnostic metric: emits.
    datasets.warnDatasetMissing(contentCatalog, component, version, metricValues.METRICS_KIND)
  }
  const resolved = registry
    ? metricLinks.resolveMetric({
      contentCatalog,
      registry,
      name,
      component,
      version,
      serverless: datasets.isAttributeSet(document.getAttribute('env-serverless')),
    })
    : undefined
  const result = metricValues.resolveMetricValue({
    registry,
    name,
    field: requested,
    format,
    label,
    filePath,
    block,
    resolved,
    unavailable: resolved && resolved.unavailable,
    unavailableKind: resolved && resolved.unavailableKind,
  })
  // A deprecated metric warns on every mention, value or name.
  if (resolved && resolved.ok && metricValues.isDeprecated(resolved.entry) && !metricValues.deprecationAcknowledged(attributes) && mode !== 'off') {
    logger.warn(`metricval${block ? '::' : ':'}${name}[${requested}]${where}: ${metricValues.deprecationSentence(resolved.family, resolved.entry)}`)
  }
  return { mode, name: (result.family || name), result }
}

// A placeholder is reported even in off mode: a value cannot fall back to
// anything, and a silent <unknown type> would reach readers unnoticed.
function report (mode, result) {
  if (mode === 'error' && THROW_KINDS.includes(result.kind)) throw new Error(result.message)
  logger.warn(result.message)
}

function metricvalInlineMacro (config) {
  return function () {
    const self = this
    self.named('metricval')
    self.positionalAttributes(['field'])
    self.process(function (parent, target, attributes) {
      const { mode, name, result } = metricvalCall(config, parent, target, attributes)
      const content = (extra) => self.createInline(parent, 'quoted', metricValues.buildMetricvalContent({ name, field: result.field, ...extra }))
      if (result.ok && result.rich) {
        // A text value renders inline only when it is one paragraph.
        const html = valueDescriptions.richInlineHtml(parent, result.rich)
        if (html !== undefined) return content({ html })
        report(mode, { kind: 'needs-block', message: `${result.call}: the ${result.field} value of '${name}' is more than one paragraph, which has no inline form, so it renders <unknown ${result.field}>. Use the block form on a line of its own: metricval::${name}[${result.field}].` })
        return content({ unknown: true })
      }
      if (result.ok) return content({ text: result.text, html: result.html })
      report(mode, result)
      return content({ unknown: true })
    })
  }
}

/**
 * metricval::<name>[<field>], the block form, for a value longer than one
 * paragraph, such as a description or usage text. A text value is parsed
 * into the page as AsciiDoc; any other value renders as a paragraph.
 */
function metricvalBlockMacro (config) {
  return function () {
    const self = this
    self.named('metricval')
    self.positionalAttributes(['field'])
    self.process(function (parent, target, attributes) {
      const { mode, name, result } = metricvalCall(config, parent, target, attributes, { block: true })
      const html = (extra) => metricValues.buildMetricvalContent({ name, field: result.field, ...extra })
      if (result.ok && result.rich) return valueDescriptions.richBlock(self, parent, result.rich, `${metricValues.VALUE_ROLE} ${metricValues.VALUE_ROLE}-${result.field}`)
      if (result.ok) return valueDescriptions.htmlParagraph(self, parent, html({ text: result.text, html: result.html }))
      report(mode, result)
      return valueDescriptions.htmlParagraph(self, parent, html({ unknown: true }))
    })
  }
}

module.exports.metricvalInlineMacro = metricvalInlineMacro
module.exports.metricvalBlockMacro = metricvalBlockMacro
module.exports.THROW_KINDS = THROW_KINDS
