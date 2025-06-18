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

    // Normalize type: arrays and unknown-map as object
    let displayType;
    if (child.type === 'string' && child.kind === 'array') {
      displayType = 'array';
    } else if (child.type === 'unknown' && child.kind === 'map') {
      displayType = 'object';
    } else {
      displayType = child.type;
    }

    let block = '';
    const isArray = child.kind === 'array';
    const currentPath = prefix
      ? `${prefix}.${child.name}${isArray ? '[]' : ''}`
      : `${child.name}${isArray ? '[]' : ''}`;

    block += `=== \`${currentPath}\`\n\n`;

    if (child.description) {
      block += `${child.description}\n\n`;
    }
    if (child.is_secret) {
      block += `include::redpanda-connect:components:partial$secret_warning.adoc[]\n\n`;
    }
    if (child.version) {
      block += `ifndef::env-cloud[]\nRequires version ${child.version} or later.\nendif::[]\n\n`;
    }

    block += `*Type*: \`${displayType}\`\n\n`;

    // Default value
    if (child.default !== undefined) {
      // Empty array
      if (Array.isArray(child.default) && child.default.length === 0) {
        block += `*Default*: \`[]\`\n\n`;
      }
      // Empty object
      else if (
        child.default !== null &&
        typeof child.default === 'object' &&
        !Array.isArray(child.default) &&
        Object.keys(child.default).length === 0
      ) {
        block += `*Default*: \`{}\`\n\n`;
      }
      // Complex object/array
      else if (typeof child.default === 'object') {
        const defYaml = yaml.stringify(child.default).trim();
        block += `*Default*:\n[source,yaml]\n----\n${defYaml}\n----\n\n`;
      }
      // Primitive
      else {
        const display = typeof child.default === 'string'
          ? (child.default.startsWith('"') && child.default.endsWith('"')
              ? child.default
              : child.default === ''
              ? '""'
              : child.default)
          : String(child.default);
        block += `*Default*: \`${display}\`\n\n`;
      }
    }

    // Annotated options table
    if (child.annotated_options && child.annotated_options.length) {
      block += `[cols="1m,2a"]\n|===\n|Option |Summary\n\n`;
      child.annotated_options.forEach(([opt, summary]) => {
        block += `|${opt}\n|${summary}\n\n`;
      });
      block += `|===\n\n`;
    }

    // Simple options list
    if (child.options && child.options.length) {
      block += `*Options*: ${child.options.map(opt => `\`${opt}\``).join(', ')}\n\n`;
    }

    // Examples
    if (child.examples && child.examples.length) {
      block += `[source,yaml]\n----\n# Examples:\n`;
      if (child.kind === 'array') {
        block += renderYamlList(child.name, child.examples);
      } else {
        child.examples.forEach(example => {
          if (typeof example === 'object') {
            const snippet = yaml.stringify(example).trim();
            block += `${child.name}:\n`;
            block += snippet.split('\n').map(line => '  ' + line).join('\n') + '\n';
          } else if (typeof example === 'string' && example.includes('\n')) {
            block += `${child.name}: |-\n`;
            block += example.split('\n').map(line => '  ' + line).join('\n') + '\n';
          } else {
            // Primitive values
            block += `${child.name}: ${example}\n`;
          }
        });
      }
      block += `----\n\n`;
    }

    // Nested children
    if (child.children && child.children.length) {
      block += renderConnectFields(child.children, currentPath);
    }

    // Cloud guard
    if (child.selfManagedOnly) {
      output += `ifndef::env-cloud[]\n${block}endif::[]\n\n`;
    } else {
      output += block;
    }
  });

  return new handlebars.SafeString(output);
};
