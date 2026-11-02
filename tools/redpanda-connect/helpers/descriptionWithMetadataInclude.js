'use strict';

const { descriptionWithMetadataInclude } = require('../metadata-utils.js');

/**
 * Handlebars helper: render a connector description with its inline
 * `== Metadata` block replaced by an include of the regenerated metadata
 * partial, so newly drafted pages pick up metadata changes automatically.
 * Falls back to the unchanged description when no metadata section exists.
 * @param {object} item connector data (needs description, type/typeDir, name)
 * @returns {string}
 */
module.exports = function descriptionWithMetadataIncludeHelper (item) {
  return descriptionWithMetadataInclude(item);
};
