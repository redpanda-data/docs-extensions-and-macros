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
        // Preserve explicit quotes or wrap '*' in quotes
        if ((value.startsWith('"') && value.endsWith('"')) || value === '*') {
          // Already quoted or special '*'
        } else {
          value = value;
        }
        out += `  - ${value}\n`;
      } else {
        // Objects/arrays: stringify with indentation
        const snippet = yaml.stringify(item).trim();
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
