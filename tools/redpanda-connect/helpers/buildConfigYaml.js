const renderLeafField = require('./renderLeafField');
const renderObjectField = require('./renderObjectField');

/**
 * Builds either “Common” or “Advanced” YAML for one connector.
 *
 * - type            = “input” or “output” (or whatever type)
 * - connectorName   = such as “amqp_1”
 * - children        = the array of field‐definitions (entry.config.children)
 * - includeAdvanced = if false → only fields where is_advanced !== true
 *                      if true  → all fields (except deprecated)
 *
 * Structure produced:
 *
 *   type:
 *     label: ""
 *     connectorName:
 *       ...child fields (with comments for “no default”)
 */
module.exports = function buildConfigYaml(type, connectorName, children, includeAdvanced) {
  const lines = [];

  // “type:” top‐level
  lines.push(`${type}:`);

  // Two‐space indent for “label”
  lines.push(`  label: ""`);

  // Two‐space indent for connectorName heading
  lines.push(`  ${connectorName}:`);

  // Four‐space indent for children
  const baseIndent = 4;
  children.forEach(field => {
    if (field.is_deprecated) {
      return; // skip deprecated fields
    }
    if (!includeAdvanced && field.is_advanced) {
      return; // skip advanced fields in “common” mode
    }

    if (field.type === 'object' && Array.isArray(field.children)) {
      // Render nested object
      const nestedLines = renderObjectField(field, baseIndent);
      lines.push(...nestedLines);
    } else {
      // Render a scalar or array leaf
      lines.push(renderLeafField(field, baseIndent));
    }
  });

  return lines.join('\n');
}