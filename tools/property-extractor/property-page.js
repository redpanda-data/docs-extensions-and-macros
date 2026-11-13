'use strict'

/**
 * Which reference page a property is written to: the one rule shared by the
 * property generator (generate-handlebars-docs.js, which writes each
 * property into that page's partial) and the property_catalog macro (which
 * groups the catalog the same way). Keeping it in one module with no
 * dependencies lets the macro load it at build time without the generator's
 * Handlebars setup, and means the two can never disagree.
 */

/**
 * Determines if a property is related to object storage.
 * @param {Object} prop - The property object
 * @returns {boolean} True if the property is object storage related
 */
function isObjectStorageProperty (prop) {
  return Boolean(prop && prop.name && (
    prop.name.includes('cloud_storage') ||
    prop.name.includes('s3_') ||
    prop.name.includes('azure_') ||
    prop.name.includes('gcs_') ||
    prop.name.includes('archival_') ||
    prop.name.includes('remote_') ||
    prop.name.includes('tiered_')
  ))
}

/**
 * Which reference page a property is written to.
 *
 * The one place that decides, so a link's target page cannot disagree with the
 * page the property actually lands on. generatePropertyPartials uses it to pick
 * the partial to append to; applyPropertyLinks uses it to tell a same-page
 * reference from a cross-page one; the property catalog uses it to group cards.
 *
 * Returns null for a property with no scope, which is not rendered at all.
 *
 * @param {Object} prop - The property object.
 * @returns {('cluster'|'topic'|'broker'|'object-storage'|null)}
 */
function propertyPageFor (prop) {
  if (!prop || !prop.config_scope) return null
  switch (prop.config_scope) {
    case 'topic':
      return 'topic'
    case 'broker':
      return 'broker'
    case 'cluster':
      return isObjectStorageProperty(prop) ? 'object-storage' : 'cluster'
    case 'object-storage':
      return 'object-storage'
    default:
      return null
  }
}

module.exports = { isObjectStorageProperty, propertyPageFor }
