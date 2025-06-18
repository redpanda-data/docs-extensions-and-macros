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

    // Normalize type
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

    // Default
    if (child.type !== 'object' && child.default !== undefined) {
      if (typeof child.default !== 'object') {
        const display = child.default === '' ? '""' : String(child.default);
        block += `*Default*: \`${display}\`\n\n`;
      } else {
        const defYaml = yaml.stringify(child.default).trim();
        block += `*Default*:\n[source,yaml]\n----\n${defYaml}\n----\n\n`;
      }
    }

    // Annotated options
    if (child.annotated_options && child.annotated_options.length) {
      block += `[cols=\"1m,2a\"]\n|===\n|Option |Summary\n\n`;
      child.annotated_options.forEach(([opt, summary]) => {
        block += `|${opt}\n|${summary}\n\n`;
      });
      block += `|===\n\n`;
    }

    // Options list
    if (child.options && child.options.length) {
      block += `*Options*: ${child.options.map(opt => `\`${opt}\``).join(', ')}\n\n`;
    }

    // Examples
    if (child.examples && child.examples.length) {
      block += `[source,yaml]\n----\n# Examples:\n`;
      if (child.type === 'string') {
        if (child.kind === 'array') {
          block += renderYamlList(child.name, child.examples);
        } else {
          child.examples.forEach(example => {
            if (typeof example === 'string' && example.includes('\n')) {
              block += `${child.name}: |-\n`;
              block += example.split('\n').map(line => '  ' + line).join('\n') + '\n';
            } else {
              block += `${child.name}: \`${example}\`\n`;
            }
          });
          block += '\n';
        }
      } else if (child.type === 'processor') {
        if (child.kind === 'array') {
          block += renderYamlList(child.name, child.examples);
        } else {
          child.examples.forEach(example => {
            block += `${child.name}: \`${String(example)}\`\n`;
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
              block += `${child.name}:\n`;
              block += snippet.split('\n').map(line => '  ' + line).join('\n') + '\n';
            } else {
              block += `${child.name}: \`${String(example)}\`\n`;
            }
          });
          block += '\n';
        }
      } else {
        child.examples.forEach(example => {
          block += `${child.name}: \`${String(example)}\`\n`;
        });
        block += '\n';
      }
      block += `----\n\n`;
    }

    // Nested
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
