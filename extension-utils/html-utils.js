'use strict'

/**
 * Shared HTML utility functions for extensions and macros
 */

/**
 * Escape the HTML special characters that let a value break out of element
 * content or a double-quoted attribute value.
 * @param {*} text - The value to escape
 * @returns {string} - The escaped string, or '' for a falsy value
 */
function escapeHtml (text) {
  if (!text) return ''
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

module.exports = {
  escapeHtml,
}
