'use strict';

const { extractMetadata } = require('../metadata-utils.js');

/**
 * Handlebars helper: return the `== Metadata` block extracted from a connector
 * description, or '' when there is none. Used by the metadata partial template.
 * @param {string} description
 * @returns {string}
 */
module.exports = function renderConnectMetadata (description) {
  return extractMetadata(description);
};
