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
    if (child.is_deprecated || !child.name) return;

    // Normalize type: string-array becomes true 'array'
    const displayType =
      child.type === 'string' && child.kind === 'array'
        ? 'array'
        : child.type;

    // Build the AsciiDoc block for this field
    let block = '';
    const isArray = child.kind === 'array';
    const currentPath = prefix
      ? `${prefix}.${child.name}${isArray ? '[]' : ''}`
      : `${child.name}${isArray ? '[]' : ''}`;

    block += `=== \`${currentPath}\`\n\n`;

    if (child.description) {
      block += `${child.description}\n\n`;
    }

    if (child.is_secret === true) {
      block += `include::redpanda-connect:components:partial$secret_warning.adoc[]\n\n`;
    }

    if (child.version) {
      block += `ifndef::env-cloud[]\nRequires version ${child.version} or later.\nendif::[]\n\n`;
    }

    block += `*Type*: \`${displayType}\`\n\n`;

    if (child.type !== 'object' && child.default !== undefined) {
      if (typeof child.default !== 'object') {
        const display = child.default === '' ? '""' : String(child.default);
        block += `*Default*: \`${display}\`\n\n`;
      } else {
        const defYaml = yaml.stringify(child.default).trim();
        block += `*Default*:\n[source,yaml]\n----\n${defYaml}\n----\n\n`;
      }
    }

    if (
      child.annotated_options &&
      Array.isArray(child.annotated_options) &&
      child.annotated_options.length > 0
    ) {
      block += '[cols="1m,2a"]\n';
      block += '|===\n';
      block += '|Option |Summary\n\n';
      child.annotated_options.forEach(optionPair => {
        if (Array.isArray(optionPair) && optionPair.length >= 2) {
          block += `|${optionPair[0]}\n|${optionPair[1]}\n\n`;
        }
      });
      block += '|===\n\n';
    }

    if (child.options && Array.isArray(child.options) && child.options.length > 0) {
      block += `*Options*: ${child.options.map(opt => `\`${opt}\``).join(', ')}\n\n`;
    }

    if (child.examples && child.examples.length) {
      block += '[source,yaml]\n----\n';
      block += '# Examples:\n';

      // ...examples rendering logic unchanged...
      if (child.type === 'string') {
        if (child.kind === 'array') {
          block += renderYamlList(child.name, child.examples);
        } else {
          child.examples.forEach(example => {
            if (typeof example === 'string' && example.includes('\n')) {
              block += `${child.name}: |-\n`;
              const indented = example.split('\n').map(line => '  ' + line).join('\n');
              block += `${indented}\n`;
            } else {
              block += `${child.name}: ${example}\n`;
            }
          });
          block += '\n';
        }
      } else if (child.type === 'processor') {
        if (child.kind === 'array') {
          block += renderYamlList(child.name, child.examples);
        } else {
          child.examples.forEach(example => {
            block += `${child.name}: ${example}\n`;
          });
          block += '\n';
        }
      } else if (child.type === 'object') {
        if (child.kind === 'array') {
          block += renderYamlList(child.name, child.examples);
        } else {
          child.examples.forEach(example => {
            if (typeof example === 'object') {
              const snippet = yaml.stringify(example).trim();
              const formatted = snippet
                .split('\n')
                .map(line => '  ' + line)
                .join('\n');
              block += `${child.name}:\n${formatted}\n`;
            } else {
              block += `${child.name}: ${example}\n`;
            }
          });
          block += '\n';
        }
      } else {
        child.examples.forEach(example => {
          block += `${child.name}: ${example}\n`;
        });
        block += '\n';
      }

      block += '----\n\n';
    }

    // Render nested children
    if (child.children && Array.isArray(child.children) && child.children.length > 0) {
      block += renderConnectFields(child.children, currentPath);
    }

    // Wrap in cloud-guard if selfManagedOnly
    if (child.selfManagedOnly) {
      output += `ifndef::env-cloud[]\n${block}endif::[]\n\n`;
    } else {
      output += block;
    }
  });

  return new handlebars.SafeString(output);
};
