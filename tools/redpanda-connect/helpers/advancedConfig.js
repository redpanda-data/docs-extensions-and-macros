const buildConfigYaml = require('./buildConfigYaml.js');
const handlebars = require('handlebars');

/**
 * Handlebars helper “advancedConfig”.  Omits only deprecated.
 *
 * Usage in template:
 *   {{advancedConfig this.type this.name this.config.children}}
 */
module.exports = function advancedConfig(type, connectorName, children) {
  if (typeof type !== 'string' || typeof connectorName !== 'string' || !Array.isArray(children)) {
    return '';
  }

  const yamlText = buildConfigYaml(type, connectorName, children, /*includeAdvanced=*/ true);
  return new handlebars.SafeString(yamlText);
}