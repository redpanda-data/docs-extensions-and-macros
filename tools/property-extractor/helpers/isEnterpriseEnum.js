'use strict';

/**
 * Handlebars helper to check if an enum value is marked as enterprise.
 *
 * Usage: {{#if (isEnterpriseEnum enumValue x-enum-metadata)}}(Enterprise){{/if}}
 * Usage in template: {{#each enum}}`{{this}}`{{#if (isEnterpriseEnum this ../x-enum-metadata)}} (Enterprise){{/if}}{{/each}}
 *
 * @param {string} enumValue - The enum value to check
 * @param {Object} metadata - The x-enum-metadata object mapping values to {is_enterprise: boolean}
 * @returns {boolean} True if the enum value is enterprise-only
 */
module.exports = function(enumValue, metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return false;
  }

  const valueMetadata = metadata[enumValue];
  if (!valueMetadata || typeof valueMetadata !== 'object') {
    return false;
  }

  return valueMetadata.is_enterprise === true;
};
