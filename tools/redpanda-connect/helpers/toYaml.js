const yaml = require('yaml');
	
/**
 * Converts an object to a YAML string.
 *
 * @param {Object} obj - The object to convert.
 * @returns {string} The YAML representation of the object, trimmed.
 */
module.exports = function toYaml(obj) {
  return yaml.stringify(obj).trim();
}