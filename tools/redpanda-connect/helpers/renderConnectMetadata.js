'use strict';

const { extractMetadata } = require('../metadata-utils.js');
const { normalizeMetadataBlock } = require('../normalize-metadata.js');
const { protectCodeSpans } = require('./renderConnectDescription.js');

/**
 * Handlebars helper: return the `== Metadata` block extracted from a connector
 * description with consistent field-list formatting, or '' when there is none.
 * Used by the metadata partial template.
 * @param {string} description
 * @returns {string}
 */
module.exports = function renderConnectMetadata (description) {
  return protectCodeSpans(normalizeMetadataBlock(extractMetadata(description)));
};
