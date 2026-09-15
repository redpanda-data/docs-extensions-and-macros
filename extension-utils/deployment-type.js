'use strict'

/**
 * Derive the deployment type of a page from its AsciiDoc attributes.
 *
 * This is the single source of truth for the mapping. It used to live as four
 * slightly different copies (validate-attributes, generate-index-data, the
 * Algolia indexer, find-related-labs/docs), which disagreed on whether
 * `env-cloud`, `page-cloud`, or `cloud` marked a Cloud page. The union of those
 * checks is kept here so every consumer classifies a page the same way.
 *
 * Precedence follows the historical order: Kubernetes, then Linux, then Docker,
 * then Cloud. A page with none of the markers is unclassified ('').
 *
 * @param {Object} [attributes] - page.asciidoc.attributes (may be undefined)
 * @returns {'Kubernetes'|'Linux'|'Docker'|'Redpanda Cloud'|''}
 */
function getDeploymentType (attributes) {
  if (!attributes || typeof attributes !== 'object') return ''
  if (attributes['env-kubernetes']) return 'Kubernetes'
  if (attributes['env-linux']) return 'Linux'
  if (attributes['env-docker']) return 'Docker'
  if (attributes['env-cloud'] || attributes['page-cloud']) return 'Redpanda Cloud'
  return ''
}

module.exports = { getDeploymentType }
