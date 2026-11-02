const handlebars = require('handlebars');

/**
 * Renders an example for a property based on its format
 * @param {Object} property - The property object containing example data
 * @returns {handlebars.SafeString} Formatted example block
 */
module.exports = function renderPropertyExample(property) {
  if (!property.example) {
    return new handlebars.SafeString('');
  }

  let exampleContent = '';

  // Handle different example formats
  if (typeof property.example === 'string') {
    // Check if it's already a complete AsciiDoc example
    if (property.example.includes('.Example') || property.example.includes('[,yaml]')) {
      exampleContent = property.example;
    } else {
      // Wrap simple string examples in backticks for inline code formatting
      exampleContent = `\`${property.example}\``;
    }
  } else if (Array.isArray(property.example)) {
    // Multiline array example
    exampleContent = property.example.join('\n');
  } else if (typeof property.example === 'object' && property.example.title) {
    // Structured example with title and content
    exampleContent = `.${property.example.title}\n`;
    if (property.example.description) {
      exampleContent += `${property.example.description}\n\n`;
    }
    if (property.example.config) {
      exampleContent += `[,yaml]\n----\n${JSON.stringify(property.example.config, null, 2)}\n----`;
    }
  } else {
    // Fallback: JSON stringify and wrap in backticks for inline code
    const jsonStr = JSON.stringify(property.example, null, 2);
    exampleContent = `\`${jsonStr}\``;
  }

  return new handlebars.SafeString(exampleContent);
};
