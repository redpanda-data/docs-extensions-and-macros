/**
 * Handlebars helper for logical OR
 * @param {...*} args - Values to check
 * @returns {boolean} True if any value is truthy
 */
module.exports = function or(...args) {
  // Remove the last argument which is the Handlebars options object
  const values = args.slice(0, -1);
  return values.some(val => !!val);
};
