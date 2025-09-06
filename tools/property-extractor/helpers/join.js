/**
 * Handlebars helper to join an array with a separator
 * @param {Array} array - The array to join
 * @param {string} separator - The separator to use
 * @returns {string} The joined string
 */
module.exports = function join(array, separator) {
  if (!Array.isArray(array)) {
    return '';
  }
  
  // Detect and ignore Handlebars options object
  if (separator && typeof separator === 'object' && (separator.hash !== undefined || separator.data !== undefined)) {
    separator = undefined;
  }
  
  return array.join(separator || ', ');
};
