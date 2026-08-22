'use strict'

/**
 * Shared HTML utility functions for extensions and macros
 */

/**
 * Escape the HTML special characters that let a value break out of element
 * content or a double-quoted attribute value.
 * @param {*} text - The value to escape
 * @returns {string} - The escaped string; '' for null or undefined only
 */
function escapeHtml (text) {
  // null and undefined only. A falsy check here blanked 0, false and NaN, so a
  // documented default of 0 rendered as nothing at all.
  if (text === null || text === undefined) return ''
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

module.exports = {
  escapeHtml,
}
