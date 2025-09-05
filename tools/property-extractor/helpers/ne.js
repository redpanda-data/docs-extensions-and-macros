/**
 * Handlebars helper for inequality comparison
 * @param {*} a - First value
 * @param {*} b - Second value
 * @returns {boolean} True if values are not equal
 */
module.exports = function ne(a, b) {
  return a !== b;
};
