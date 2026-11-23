'use strict'

/**
 * Fetches the published versions of the redpanda Helm chart from the public
 * Helm repository index at charts.redpanda.com.
 *
 * The index needs no GitHub token, so it works on every Antora site. The
 * operator-enterprise repository, which holds the chart source and its tags, is
 * private, so the GitHub lookups only work with a token that can read it.
 *
 * @param {Object} [options]
 * @param {string} [options.url] - Index URL (defaults to the public Redpanda Helm repo)
 * @param {string} [options.chart] - Chart name in the index (defaults to "redpanda")
 * @param {number} [options.timeoutMs] - Request timeout in milliseconds
 * @param {Object} [options.logger] - Optional Antora logger instance
 * @returns {Promise<string[]|null>} Every published version of the chart, or null when the index cannot be read
 */
const fetchChartEntries = async ({
  url = 'https://charts.redpanda.com/index.yaml',
  chart = 'redpanda',
  timeoutMs = 30000,
  logger = null,
} = {}) => {
  const yaml = require('js-yaml')
  const warn = (message) => (logger ? logger.warn(message) : console.warn(message))
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) {
      warn(`Could not read the Helm chart index at ${url}: HTTP ${response.status}`)
      return null
    }
    const index = yaml.load(await response.text())
    const entries = index?.entries?.[chart]
    if (!Array.isArray(entries)) {
      warn(`The Helm chart index at ${url} has no "${chart}" chart`)
      return null
    }
    return entries
      .filter((entry) => typeof entry?.version === 'string')
      .map((entry) => ({ version: entry.version, appVersion: entry.appVersion == null ? null : String(entry.appVersion) }))
  } catch (error) {
    warn(`Could not read the Helm chart index at ${url}: ${error.message || error}`)
    return null
  }
}

module.exports = async (options = {}) => {
  const entries = await fetchChartEntries(options)
  return entries ? entries.map((entry) => entry.version) : null
}

/**
 * Fetches the published entries of a chart from the Helm repository index,
 * with the application version each chart version deploys by default.
 *
 * @param {Object} [options] - The same options as the default export
 * @returns {Promise<Array<{version: string, appVersion: string|null}>|null>} Every published entry of the chart, or null when the index cannot be read
 */
module.exports.fetchChartEntries = fetchChartEntries
