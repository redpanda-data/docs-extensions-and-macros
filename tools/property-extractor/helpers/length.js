/**
 * Handlebars helper to get the length of an array
 * @param {Array} arr - The array
 * @returns {number} The length of the array
 */
module.exports = function length(arr) {
  if (!arr) return 0;
  if (Array.isArray(arr)) return arr.length;
  if (typeof arr === 'object' && arr.length !== undefined) return arr.length;
  return 0;
};
