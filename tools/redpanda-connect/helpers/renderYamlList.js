const yaml = require('yaml');

/**
 * Renders a list of objects or scalar items as a YAML list
 *
 * @param {string} name - The field name to use as the YAML key.
 * @param {Array<Object>|Array<string>} exampleGroups - An array of example groups.
 * @returns {string} The rendered YAML list string.
 */
module.exports = function renderYamlList(name, exampleGroups) {
  let out = `${name}:\n`;
  exampleGroups.forEach(group => {
    if (Array.isArray(group)) {
      group.forEach(item => {
        const snippet = yaml.stringify(item).trim();
        const lines = snippet.split('\n');
        out += lines
          .map((line, idx) => (idx === 0 ? `  - ${line}` : `    ${line}`))
          .join('\n') + '\n';
      });
    } else {
      const snippet = yaml.stringify(group).trim();
      const lines = snippet.split('\n');
      out += lines
        .map((line, idx) => (idx === 0 ? `  - ${line}` : `    ${line}`))
        .join('\n') + '\n';
    }
    out += '\n';
  });
  return out;
}