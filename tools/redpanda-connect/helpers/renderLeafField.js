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
  if (!field || typeof field !== 'object') {
    throw new Error('renderLeafField: field must be an object');
  }
  if (typeof indentLevel !== 'number' || indentLevel < 0) {
    throw new Error('renderLeafField: indentLevel must be a non-negative number');
  }
  if (!field.name || typeof field.name !== 'string') {
    throw new Error('renderLeafField: field.name must be a non-empty string');
  }

  const indent = ' '.repeat(indentLevel);
  const name = field.name;

  // Decide whether optional or required
  const optional = Boolean(field.is_optional);
  const comment = optional
    ? '# No default (optional)'
    : '# No default (required)';

  // If a default is provided, use it:
  if (field.default !== undefined) {
    // Empty array inline
    if (Array.isArray(field.default) && field.default.length === 0) {
      return `${indent}${name}: []`;
    }
    // Empty object inline
    if (
      field.default !== null &&
      typeof field.default === 'object' &&
      !Array.isArray(field.default) &&
      Object.keys(field.default).length === 0
    ) {
      return `${indent}${name}: {}`;
    }

    // Complex object/array: dump as YAML block
    if (typeof field.default === 'object') {
      try {
        const rawYaml = yaml.stringify(field.default).trim();
        const indentedYaml = rawYaml
          .split('\n')
          .map(line => ' '.repeat(indentLevel + 2) + line)
          .join('\n');
        return `${indent}${name}:\n${indentedYaml}`;
      } catch (error) {
        console.warn(`Failed to serialize default for ${field.name}:`, error);
        return `${indent}${name}: {} # Error serializing default`;
      }
    }

    // Primitive default: string, number, boolean
    let value;
    if (typeof field.default === 'string') {
      // Preserve existing quotes
      if (field.default.startsWith('"') && field.default.endsWith('"')) {
        value = field.default;
      } else if (field.default === '') {
        value = '""';
      } else {
        value = field.default;
      }
    } else {
      value = String(field.default);
    }

    return `${indent}${name}: ${value}`;
  }

  // No default → choose representation
  if (field.kind === 'array') {
    return `${indent}${name}: [] ${comment}`;
  } else {
    return `${indent}${name}: "" ${comment}`;
  }
};
