'use strict';

const yaml = require('yaml');
const renderYamlList = require('./renderYamlList');
const handlebars = require('handlebars');


/**
 * Renders the children of a configuration object into AsciiDoc.
 *
 * @param {Array<Object>} children - An array of child objects.
 * @param {string} [prefix=''] - The prefix path for nested fields.
 * @returns {handlebars.SafeString} The rendered SafeString containing the configuration details.
 */
module.exports = function renderConnectFields(children, prefix = '') {
  if (!children || !Array.isArray(children) || children.length === 0) {
    return '';
  }

  const sorted = [...children].sort((a, b) => {
    const an = a.name || '';
    const bn = b.name || '';
    return an.localeCompare(bn, undefined, { sensitivity: 'base' });
  });

  let output = '';
  prefix = typeof prefix === 'string' ? prefix : '';

  sorted.forEach(child => {
    if (child.is_deprecated) {
      return;
    }
    const isArray = child.kind === 'array';
    if (!child.name) return;
    const currentPath = prefix
      ? `${prefix}.${child.name}${isArray ? '[]' : ''}`
      : `${child.name}${isArray ? '[]' : ''}`;

    output += `=== \`${currentPath}\`\n\n`;

    if (child.description) {
      output += `${child.description}\n\n`;
    }

    if (child.is_secret === true) {
      output += `include::redpanda-connect:components:partial$secret_warning.adoc[]\n\n`;
    }

    if (child.version) {
      output += `ifndef::env-cloud[]\nRequires version ${child.version} or later.\nendif::[]\n\n`;
    }

    output += `*Type*: \`${child.type}\`\n\n`;

    if (child.type !== 'object' && child.default !== undefined) {
      if (typeof child.default !== 'object') {
        const display = child.default === '' ? '""' : String(child.default);
        output += `*Default*: \`${display}\`\n\n`;
      } else {
        const defYaml = yaml.stringify(child.default).trim();
        output += `*Default*:\n[source,yaml]\n----\n${defYaml}\n----\n\n`;
      }
    }

    if (
      child.annotated_options &&
      Array.isArray(child.annotated_options) &&
      child.annotated_options.length > 0
    ) {
      output += '[cols="1m,2a"]\n';
      output += '|===\n';
      output += '|Option |Summary\n\n';
      child.annotated_options.forEach(optionPair => {
        if (Array.isArray(optionPair) && optionPair.length >= 2) {
          output += `|${optionPair[0]}\n|${optionPair[1]}\n\n`;
        }
      });
      output += '|===\n\n';
    }

    if (child.options && Array.isArray(child.options) && child.options.length > 0) {
      output += `*Options*: ${child.options.map(opt => `\`${opt}\``).join(', ')}\n\n`;
    }

    if (child.examples && child.examples.length) {
      output += '[source,yaml]\n----\n';
      output += '# Examples:\n';

      if (child.type === 'string') {
        if (child.kind === 'array') {
          output += renderYamlList(child.name, child.examples);
        } else {
          child.examples.forEach(example => {
            if (typeof example === 'string' && example.includes('\n')) {
              output += `${child.name}: |-\n`;
              const indentedLines = example.split('\n').map(line => '  ' + line).join('\n');
              output += `${indentedLines}\n`;
            } else {
              output += `${child.name}: ${example}\n`;
            }
          });
          output += '\n';
        }
      } else if (child.type === 'processor') {
        if (child.kind === 'array') {
          output += renderYamlList(child.name, child.examples);
        } else {
          child.examples.forEach(example => {
            output += `${child.name}: ${example}\n`;
          });
          output += '\n';
        }
      } else if (child.type === 'object') {
        if (child.kind === 'array') {
          output += renderYamlList(child.name, child.examples);
        } else {
          child.examples.forEach(example => {
            if (typeof example === 'object') {
              const snippet = yaml.stringify(example).trim();
              const lines = snippet.split('\n');
              // Prefix two spaces to every line
              const formattedLines = lines.map(line => '  ' + line).join('\n');
              output += `${child.name}:\n${formattedLines}\n`;
            } else {
              output += `${child.name}: ${example}\n`;
            }
          });
          output += '\n';
        }
      } else {
        child.examples.forEach(example => {
          output += `${child.name}: ${example}\n`;
        });
        output += '\n';
      }

      output += '----\n\n';
    }

    if (child.children && Array.isArray(child.children) && child.children.length > 0) {
      output += renderConnectFields(child.children, currentPath);
    }
  });

  return new handlebars.SafeString(output);
}