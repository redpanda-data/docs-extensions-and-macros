'use strict'

/**
 * Shared HTML utility functions for extensions and macros.
 */

/**
 * Escape a value for safe inclusion in HTML text or inside a double-quoted
 * attribute. Escaping `&` first is what keeps the result idempotent-safe for a
 * single pass; escaping `"` is what stops an author-supplied string from ending
 * the attribute it sits in.
 *
 * @param {*} value - Value to escape. `null` and `undefined` become ''.
 * @returns {string} The escaped string.
 */
function escapeHtml (value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

module.exports = {
  escapeHtml,
}
