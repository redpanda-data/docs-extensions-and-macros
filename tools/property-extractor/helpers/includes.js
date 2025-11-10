'use strict';

/**
 * Handlebars helper to check if an array includes a value.
 *
 * Usage: {{#if (includes array value)}}...{{/if}}
 *
 * @param {Array} array - The array to search
 * @param {*} value - The value to find
 * @returns {boolean} True if array includes value
 */
module.exports = function(array, value) {
  if (!Array.isArray(array)) {
    return false;
  }
  return array.includes(value);
};
