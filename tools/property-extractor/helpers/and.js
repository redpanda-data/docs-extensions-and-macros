/**
 * Handlebars helper for logical AND
 * @param {...*} args - Values to check
 * @returns {boolean} True if all values are truthy per JavaScript semantics
 */
module.exports = function and(...args) {
  // Remove the last argument which is the Handlebars options object
  const values = args.slice(0, -1);
  return values.every(val => Boolean(val));
};
