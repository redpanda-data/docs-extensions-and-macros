const handlebars = require('handlebars');

/**
 * Renders a list of examples.
 *
 * @param {Array<Object>} examples - An array of example objects.
 * @returns {handlebars.SafeString} The rendered SafeString containing the examples.
 */
module.exports = function renderConnectExamples(examples) {
  if (!examples || !Array.isArray(examples) || examples.length === 0) {
    return '';
  }
  let output = '';
  examples.forEach(example => {
    if (example.title) {
      output += `=== ${example.title}\n\n`;
    }
    if (example.summary) {
      output += `${example.summary}\n\n`;
    }
    if (example.config) {
      output += '[source,yaml]\n----\n';
      output += example.config.trim() + '\n';
      output += '----\n\n';
    }
  });
  return new handlebars.SafeString(output);
}