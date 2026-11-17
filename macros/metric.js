'use strict'

/* Inline macro for naming a Redpanda metric in prose:
 *
 *   metric:redpanda_cluster_brokers[]              -> code with tooltip data, no link
 *   metric:redpanda_cluster_brokers[link=true]     -> linked to its reference entry
 *   metric:redpanda_cluster_brokers[text=broker count]
 *   metric:redpanda_cluster_brokers[link=true,page=public-metrics-reference]
 *   metric:redpanda_old_metric[deprecated=ok]
 *
 * The name is checked against redpanda-metrics-<tag>.json, picked as prop:
 * picks property data: a self-managed page reads its own release series, a
 * Cloud (env-cloud) page reads the newest GA streaming file, and anything
 * else has none. A histogram series name (<family>_bucket, _count, _sum)
 * renders as written and reads and links its family.
 *
 * With link=true the metric links the reference page in the page's own
 * component and version whose headings include it. page= names the page
 * instead. Nothing is linked across components.
 *
 * On a Cloud page, an internal metric, one the data says is not on Cloud,
 * and one with no Cloud reference page render as plain code with a warning.
 *
 * An unknown or removed name renders as plain code and says why, according
 * to metric-validate (warn, error or off). A deprecated metric warns on
 * every mention unless the call sets deprecated=ok. See macros/REFERENCE.adoc.
 *
 * Registered by macros/prop, so every playbook that registers prop: has it.
 */

const { escapeHtml } = require('../extension-utils/html-utils')
const datasets = require('../extension-utils/attachment-datasets')
const metricValues = require('../extension-utils/metric-values')
const metricLinks = require('../extension-utils/metric-links')

const logger = metricValues.logger

// Kinds that fail the build in error mode: authoring errors. No data, no
// page and a metric that is not for Cloud readers are gaps in the build, and
// plain code still reads correctly.
const THROW_KINDS = ['unknown-metric', 'removed-metric']

const ROLE = 'metric-ref'

/**
 * The AsciiDoc content emitted for one metric: instance.
 *
 * @param {object} opts
 * @param {string} opts.name - The name as written, which is what renders.
 * @param {string} [opts.family] - The metric family the name resolved to.
 * @param {string} [opts.series] - The histogram series suffix, when the name
 *   is a series name.
 * @param {string} [opts.text] - Display text override, already escaped.
 * @param {string} [opts.docUrl] - The published URL of the reference entry.
 * @param {boolean} [opts.plain] - Render unmarked code: no tooltip, no link.
 */
function buildMetricContent ({ name, family, series, text, docUrl, plain = false }) {
  const display = text || escapeHtml(name)
  if (plain) return `<code>${display}</code>`
  const seriesAttr = series ? ` data-metric-series="${escapeHtml(series)}"` : ''
  const docAttr = docUrl ? ` data-doc-url="${escapeHtml(docUrl)}"` : ''
  return `<code class="${ROLE}" data-metric-name="${escapeHtml(family)}"${seriesAttr}${docAttr}>${display}</code>`
}

function metricInlineMacro (config) {
  return function () {
    const self = this
    self.named('metric')
    self.process(function (parent, target, attributes) {
      const document = parent.getDocument()
      const name = String(target).trim()
      const mode = String(document.getAttribute('metric-validate', 'warn')).trim().toLowerCase()
      const src = (config && config.file && config.file.src) || {}
      const component = src.component || ''
      const version = src.version || ''
      const where = src.path ? ` in ${src.path}` : ''
      const linkRequested = attributes.link === 'true' || attributes.link === true
      const call = `metric:${name}[${linkRequested ? 'link=true' : ''}]${where}`
      // link takes true or false. Anything else is a typo that would
      // silently render no link.
      const bareLink = Array.isArray(attributes.$positional) && attributes.$positional.includes('link')
      const linkWritten = bareLink ? 'link' : (attributes.link === undefined || linkRequested || attributes.link === 'false' ? undefined : `link=${attributes.link}`)
      if (linkWritten && mode !== 'off') {
        logger.warn(`metric:${name}[${linkWritten}]${where}: ${linkWritten} is not a value link accepts, so the metric renders without a link. Write link=true.`)
      }

      // Anything the build could not verify renders as plain inline code: no
      // marker, so the docs UI adds no tooltip.
      const plain = (message, kind) => {
        if (message) {
          if (mode === 'error' && THROW_KINDS.includes(kind)) throw new Error(message)
          if (mode !== 'off') logger.warn(message)
        }
        return self.createInline(parent, 'quoted', buildMetricContent({ name, text: attributes.text, plain: true }))
      }

      const contentCatalog = config && config.contentCatalog
      if (!contentCatalog) return plain()
      const registry = metricValues.loadMetricsFor(contentCatalog, component, version)
      if (!registry) {
        // No dataset covers this page. Say so once and render plain.
        if (mode !== 'off') datasets.warnDatasetMissing(contentCatalog, component, version, metricValues.METRICS_KIND)
        return plain()
      }

      const resolved = metricLinks.resolveMetric({
        contentCatalog,
        registry,
        name,
        component,
        version,
        serverless: datasets.isAttributeSet(document.getAttribute('env-serverless')),
        pageGiven: Boolean(attributes.page),
      })
      if (!resolved.ok) return plain(`${call}: ${metricValues.unresolvedSentence(registry, name, resolved)}`, resolved.kind)

      if (metricValues.isDeprecated(resolved.entry) && !metricValues.deprecationAcknowledged(attributes) && mode !== 'off') {
        logger.warn(`${call}: ${metricValues.deprecationSentence(resolved.family, resolved.entry)}`)
      }
      if (resolved.unavailable) {
        return plain(`${call}: '${resolved.family}' is not for readers of this Cloud page: ${resolved.unavailable}. It renders as plain code, with no link and no tooltip. ${metricValues.cloudAdvice(resolved.unavailable, resolved.unavailableKind, { page: true })}`, resolved.unavailableKind)
      }

      // page= overrides discovery and is not verified, as in prop:.
      const pagePath = attributes.page || (resolved.page && resolved.page.page)
      if (linkRequested && !pagePath && mode !== 'off') {
        logger.warn(`${call}: '${resolved.family}' is in ${metricValues.describeDataset(registry)} but no reference page in ${component || 'this component'}@${version || 'unversioned'} has a heading for it, so it keeps its tooltip and renders without a link. Add the metric to the reference page, set page=, or drop link=true.`)
      }
      const linked = linkRequested && Boolean(pagePath)
      const anchor = metricLinks.metricAnchor(resolved.family)
      // The same page= forms as prop:, resolved by prop:'s own function.
      const { resolvePageTarget } = require('./prop')
      const content = buildMetricContent({
        name,
        family: resolved.family,
        series: resolved.series,
        text: attributes.text,
        docUrl: !attributes.page && resolved.page && resolved.page.url ? `${resolved.page.url}#${anchor}` : undefined,
      })
      if (!linked) return self.createInline(parent, 'quoted', content)
      // An xref node around the code, as rpkcmd: emits: Antora's converter
      // resolves the path attribute to the page's URL, exactly as it
      // resolves xref:[] in the source, and the Markdown export keeps the
      // link, which it drops for a link inside a code element.
      const path = `${resolvePageTarget(pagePath)}.adoc`
      return self.createInline(parent, 'anchor', content, {
        type: 'xref',
        target: `${path}#${anchor}`,
        attributes: { path, fragment: anchor },
      })
    })
  }
}

module.exports.metricInlineMacro = metricInlineMacro
module.exports.buildMetricContent = buildMetricContent
module.exports.THROW_KINDS = THROW_KINDS
