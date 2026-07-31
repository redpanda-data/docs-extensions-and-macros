'use strict';

/**
 * Handlebars helper: flatten a connector summary into a single-line value
 * suitable for the `:description:` page attribute. Attribute values cannot
 * span lines, and a few connector summaries contain hard line breaks.
 * @param {string} summary
 * @returns {string}
 */
module.exports = function summaryAttribute (summary) {
  if (!summary) return '';
  return String(summary).replace(/\s+/g, ' ').trim();
};
