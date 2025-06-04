const buildConfigYaml = require('./buildConfigYaml.js');
const handlebars = require('handlebars');

/**
 * Handlebars helper “commonConfig”.  Omits deprecated + advanced.
 *
 * Usage in template:
 *   {{commonConfig this.type this.name this.config.children}}
 */
module.exports = function commonConfig(type, connectorName, children) {
  if (typeof type !== 'string' || typeof connectorName !== 'string' || !Array.isArray(children)) {
    return '';
  }

  const yamlText = buildConfigYaml(type, connectorName, children, /*includeAdvanced=*/ false);
  return new handlebars.SafeString(yamlText);
}