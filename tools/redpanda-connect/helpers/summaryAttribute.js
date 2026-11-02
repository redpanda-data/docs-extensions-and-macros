'use strict';

const { flattenToAttributeValue } = require('../metadata-utils.js');

/**
 * Handlebars helper: flatten a connector summary into a single-line, plain-text
 * value suitable for the `:description:` page attribute (and therefore for the
 * page's `<meta name="description">`).
 *
 * Delegates to the shared flattener so the description partial's meta region
 * and `backfillPageDescriptions` publish the same text for the same summary.
 * Collapsing whitespace alone is not enough: summaries carry xrefs, link
 * macros and inline code, and an unflattened value ships raw
 * `xref:guides:bloblang/about.adoc[Bloblang mapping]` markup into search
 * snippets and link previews (verified in a real Antora build).
 *
 * @param {string} summary
 * @returns {string}
 */
module.exports = function summaryAttribute (summary) {
  return flattenToAttributeValue(summary);
};
