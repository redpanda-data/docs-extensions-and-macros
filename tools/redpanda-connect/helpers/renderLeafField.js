const yaml = require('yaml');

/**
 * Renders a single “leaf” field (scalar or array) at the given indentation.
 * If `field.default` is present, prints that. Otherwise prints an empty-string
 * or empty-array plus an inline comment (# No default (optional/required)).
 *
 * @param {Object}   field       – one field object from “children”
 * @param {number}   indentLevel – number of spaces to indent
 * @returns {string}             – one line, including comment if needed
 */
module.exports = function renderLeafField(field, indentLevel) {
  const indent = ' '.repeat(indentLevel);
  const name = field.name;

  // Decide whether optional or required
  const optional = Boolean(field.is_optional);
  const comment = optional
    ? '# No default (optional)'
    : '# No default (required)';

  // If a default is provided, use it:
  if (field.default !== undefined) {
    // If default is itself an object or array → dump as YAML block
    if (typeof field.default === 'object') {
      // Turn the object/array into a YAML string. We also need to indent that block
      const rawYaml = yaml.stringify(field.default).trim();
      // Indent each line of rawYaml by (indentLevel + 2) spaces:
      const indentedYaml = rawYaml
        .split('\n')
        .map(line => ' '.repeat(indentLevel + 2) + line)
        .join('\n');
      // Print:
      return `${indent}${name}:\n${indentedYaml}`;
    }

    // Otherwise, default is a primitive (string/number/bool)
    if (field.type === 'string') {
      return `${indent}${name}: "${field.default}"`;
    }
    return `${indent}${name}: ${field.default}`;
  }

  // No default → choose representation based on kind
  if (field.kind === 'array') {
    return `${indent}${name}: [] ${comment}`;
  } else {
    return `${indent}${name}: "" ${comment}`;
  }
}