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
      // Simple string example - wrap it
      exampleContent = `.Example\n[,yaml]\n----\n${property.name}: ${property.example}\n----`;
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
    // Fallback: JSON stringify the example
    exampleContent = `.Example\n[,yaml]\n----\n${property.name}: ${JSON.stringify(property.example, null, 2)}\n----`;
  }

  return new handlebars.SafeString('\n' + exampleContent + '\n');
};
