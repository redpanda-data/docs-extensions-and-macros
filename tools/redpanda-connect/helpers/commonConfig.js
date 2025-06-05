const buildConfigYaml = require('./buildConfigYaml.js');
const handlebars = require('handlebars');

/**
 * Handlebars helper “commonConfig”.  Omits deprecated + advanced.
 *
 * Usage in template:
 *   {{commonConfig this.type this.name this.config.children}}
 */
module.exports = function commonConfig(type, connectorName, children) {
  if (typeof type !== 'string' || !type.trim()) {
    console.warn('commonConfig: type must be a non-empty string');
    return '';
  }
  if (typeof connectorName !== 'string' || !connectorName.trim()) {
    console.warn('commonConfig: connectorName must be a non-empty string');
    return '';
  }
  if (!Array.isArray(children)) {
    console.warn('commonConfig: children must be an array');
    return '';
  }

  try {
    const yamlText = buildConfigYaml(type, connectorName, children, /*includeAdvanced=*/ false);
    return new handlebars.SafeString(yamlText);
  } catch (error) {
    console.error('Error in commonConfig helper:', error);
    return new handlebars.SafeString('<!-- Error generating configuration -->');
  }
}