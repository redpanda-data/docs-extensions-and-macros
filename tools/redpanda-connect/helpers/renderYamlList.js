const yaml = require('yaml');

/**
 * Renders a list of objects or scalar items as a YAML list
 *
 * @param {string} name - The field name to use as the YAML key.
 * @param {Array<Object|string|Array>} exampleGroups - An array of example groups.
 * @returns {string} The rendered YAML list string.
 */
module.exports = function renderYamlList(name, exampleGroups) {
  let out = `${name}:\n`;
  exampleGroups.forEach(group => {
    const items = Array.isArray(group) ? group : [group];
    items.forEach(item => {
      // Scalars
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        let value = String(item);
        // Quote when needed: already-quoted scalars stay as-is; otherwise quote `*`
        // and any value containing YAML-special characters.
        if (!(value.startsWith('"') && value.endsWith('"'))) {
          if (value === '*' || /[:\[\]\{\},&>|%@`]/.test(value)) {
            value = `"${value}"`;
          }
        }
        out += `  - ${value}\n`;
      } else {
        // Objects/arrays: stringify with indentation using block style
        const snippet = yaml.stringify(item, {
          defaultStringType: 'PLAIN',
          defaultKeyType: 'PLAIN',
          lineWidth: 0,
          simpleKeys: false
        }).trim();
        const lines = snippet.split('\n');
        out += lines
          .map((line, idx) => (idx === 0 ? `  - ${line}` : `    ${line}`))
          .join('\n') + '\n';
      }
    });
    out += '\n';
  });
  return out;
};
