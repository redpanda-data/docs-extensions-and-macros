const yaml = require('yaml');

/**
 * Converts an object to a YAML string using block style for arrays.
 *
 * @param {Object} obj - The object to convert.
 * @returns {string} The YAML representation of the object, trimmed.
 */
module.exports = function toYaml(obj) {
  return yaml.stringify(obj, {
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
    lineWidth: 0,  // Disable line wrapping to prevent flow style
    simpleKeys: false
  }).trim();
}