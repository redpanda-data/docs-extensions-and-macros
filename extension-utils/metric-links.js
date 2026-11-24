'use strict'

/* Where a metric is documented, and whether a page may name it.
 *
 * metric:[link=true] links the reference page in the page's own component
 * and version whose headings include the metric name. The page is found with
 * the index prop: uses for property headings (buildPageIndex in
 * macros/prop.js), with two additions a metrics page needs: a Cloud stub
 * includes the whole self-managed page by tag, and that page wraps the
 * headings Cloud does not have in ifndef::env-cloud[].
 *
 * Nothing is linked across components: a Cloud page links only Cloud pages.
 */

const metricValues = require('./metric-values')

const $metricPageIndex = Symbol('$metricPageIndex')

// What the shared page index scans for (see PROPERTY_PAGES in macros/prop.js).
const METRIC_PAGES = {
  symbol: $metricPageIndex,
  log: 'metric macro',
  noun: 'metric',
  plural: 'metrics',
  pageIncludes: true,
  conditionals: true,
  logger: metricValues.logger,
}

/**
 * The metric family -> page index for one component version.
 *
 * @returns {Map<string, {page: string, url?: string}>} Family name -> page
 *   path without .adoc, and its published URL.
 */
function buildMetricPageIndex (contentCatalog, component, metrics, version) {
  // Required here, not at the top: macros/prop.js registers the metric
  // macros, so it is still loading when this module is first required.
  const { buildPageIndex } = require('../macros/prop')
  return buildPageIndex(contentCatalog, component, metrics, version, METRIC_PAGES)
}

/**
 * The anchor of a metric's heading: the family name. The docs set
 * idprefix to '', and every character of a metric name is valid in an ID.
 */
const metricAnchor = (family) => family

/**
 * Resolve the name in one metric: or metricval: call for the page it renders
 * on: the family, the reference page that documents it in this component
 * version, and why it is not for this page's readers, when it is not.
 *
 * On a Cloud page a metric is unavailable when it is internal, when its
 * availability says so, or when the Cloud component has no reference page
 * for it (unless page= names one).
 *
 * @param {object} opts
 * @param {object} opts.registry - From loadMetricsFor.
 * @param {string} opts.name - The name as written.
 * @param {boolean} [opts.serverless] - The page sets env-serverless.
 * @param {boolean} [opts.pageGiven] - The call sets page=.
 * @returns {object} resolveMetricName's result, plus for a resolved name
 *   `page` ({page, url} or undefined) and, when unavailable, `unavailable`
 *   (the reason) and `unavailableKind` ('unavailable' or 'cloud-no-page').
 */
function resolveMetric ({ contentCatalog, registry, name, component, version, serverless = false, pageGiven = false }) {
  const resolved = metricValues.resolveMetricName(registry, name)
  if (!resolved.ok) return resolved
  const cloud = registry.surface === 'cloud'
  let unavailable = metricValues.cloudUnavailableReason(registry, resolved.entry, { serverless })
  let unavailableKind = unavailable ? 'unavailable' : undefined
  const page = unavailable ? undefined : buildMetricPageIndex(contentCatalog, component, registry.metrics, version).get(resolved.family)
  if (cloud && !unavailable && !page && !pageGiven) {
    unavailable = `${component || 'this component'}@${version || 'unversioned'} has no reference page with a heading for it, and a Cloud page links only Cloud pages`
    unavailableKind = 'cloud-no-page'
  }
  return { ...resolved, page, unavailable, unavailableKind }
}

module.exports = {
  METRIC_PAGES,
  buildMetricPageIndex,
  metricAnchor,
  resolveMetric,
}
