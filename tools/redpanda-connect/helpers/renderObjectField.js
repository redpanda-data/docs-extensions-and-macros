const renderLeafField = require('./renderLeafField');

/**
 * Recursively renders an object‐typed field ( has .children[]) at the given indentation.
 * Skips any sub-field with is_deprecated=true. Even if the parent has no default,
 * the parent node itself is printed without a value (just a “key:”), then children.
 *
 * @param {Object}   field       – one field object of type==="object"
 * @param {number}   indentLevel – number of spaces to indent the “key:”
 * @returns {string[]}           – an array of lines (parent + children)
 */
module.exports = function renderObjectField(field, indentLevel) {
  if (!field || !field.name || !Array.isArray(field.children)) {
    throw new Error('renderObjectField requires a field object with name and children array');
  }
  if (typeof indentLevel !== 'number' || indentLevel < 0) {
    throw new Error('indentLevel must be a non-negative number');
  }
  const lines = [];
  const indent = ' '.repeat(indentLevel);

  // Print the parent heading (no default comment here, because parent is just a namespace)
  lines.push(`${indent}${field.name}:`);

  // Recurse into children at indentLevel + 2
  const childIndent = indentLevel + 2;
  field.children.forEach(child => {
    if (child.is_deprecated) {
      return; // skip entirely
    }
    if (Array.isArray(child.children) && child.children.length > 0) {
      // Nested object → recurse
      lines.push(...renderObjectField(child, childIndent));
    } else {
      // Leaf → render via renderLeafField
      lines.push(renderLeafField(child, childIndent));
    }
  });

  return lines;
}