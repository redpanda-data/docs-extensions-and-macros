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

    // Normalize types
    let displayType;
    const isArrayTitle = typeof child.name === 'string' && child.name.endsWith('[]');
    if (isArrayTitle) {
      displayType = 'array<object>';
    } else if (child.type === 'string' && child.kind === 'array') {
      displayType = 'array';
    } else if (child.type === 'unknown' && child.kind === 'map') {
      displayType = 'object';
    } else if (child.type === 'unknown' && child.kind === 'array') {
      displayType = 'array';
    } else if (child.type === 'unknown' && child.kind === 'list') {
      displayType = 'array';
    } else {
      displayType = child.type;
    }

    let block = '';
    const isArray = child.kind === 'array';
    // Only append [] if kind is array and name does not already end with []
    const nameWithArray = (typeof child.name === 'string' && isArray && !child.name.endsWith('[]'))
      ? `${child.name}[]`
      : child.name;
    const currentPath = prefix
      ? `${prefix}.${nameWithArray}`
      : `${nameWithArray}`;

    block += `=== \`${currentPath}\`\n\n`;

    // --- Beta badge logic (now uses is_beta) ---
    let desc = child.description || '';
    if (child.is_beta) {
      // Remove any leading "BETA:" label (case-insensitive, trims leading whitespace)
      desc = 'badge::[label=Beta, size=large, tooltip={page-beta-text}]\n\n' + desc.replace(/^\s*BETA:\s*/i, '');
    }

    // --- Interpolation support notice ---
    const interpolationNotice = 'This field supports xref:configuration:interpolation.adoc#bloblang-queries[interpolation functions].';
    if (child.interpolated === true) {
      // Only add if not already present (case-insensitive)
      const descLower = desc.toLowerCase();
      if (!descLower.includes('interpolation functions')) {
        desc = desc.trim() + (desc.trim() ? '\n\n' : '') + interpolationNotice;
      }
    } else {
      // If interpolation is not true, remove the notice if present
      desc = desc.replace(new RegExp(interpolationNotice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '').replace(/\n{2,}/g, '\n\n');
    }

    if (desc) {
      block += `${desc}\n\n`;
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
        const defYaml = yaml.stringify(child.default, {
          defaultStringType: 'PLAIN',
          defaultKeyType: 'PLAIN',
          lineWidth: 0,
          simpleKeys: false
        }).trim();
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
        child.examples.forEach((example, exampleIndex) => {
          if (Array.isArray(example)) {
            // Check if array contains any objects
            const hasObjects = example.some(item => typeof item === 'object' && item !== null);

            // Always use block style for arrays
            if (hasObjects) {
              // Arrays of objects
              block += renderYamlList(child.name, [example]);
            } else {
              // Arrays of primitives - use block style
              block += `${child.name}:\n`;
              example.forEach(item => {
                let value;
                if (typeof item === 'string') {
                  // Check if already quoted (starts and ends with quotes)
                  const alreadyQuoted = item.startsWith('"') && item.endsWith('"');

                  if (alreadyQuoted) {
                    // Already quoted, return as-is
                    value = item;
                  } else {
                    // Check if quoting is needed
                    const needsQuoting = item === '' ||
                                         item === '*' ||
                                         /^(true|false|null|yes|no|on|off)$/i.test(item) ||
                                         /^[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$/.test(item) ||
                                         /[:\[\]\{\},&>|%@`"]/.test(item) ||
                                         /\s/.test(item); // any whitespace

                    if (needsQuoting) {
                      // Escape backslashes first, then double quotes
                      const escaped = item.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                      value = `"${escaped}"`;
                    } else {
                      value = item;
                    }
                  }
                } else {
                  // For primitives (numbers, booleans, etc.), convert to string
                  const strValue = String(item);
                  // Check if the stringified value needs quoting
                  if (/[:\[\]\{\},&>|%@`"]/.test(strValue) || /\s/.test(strValue)) {
                    const escaped = strValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                    value = `"${escaped}"`;
                  } else {
                    value = strValue;
                  }
                }
                block += `  - ${value}\n`;
              });
            }
          } else {
            // Fallback for non-array examples (shouldn't happen for array fields)
            block += `${child.name}: ${example}\n`;
          }

          // Add separator between examples, but not after the last one
          if (exampleIndex < child.examples.length - 1) {
            block += `\n# ---\n\n`;
          }
        });
      } else {
        child.examples.forEach((example, exampleIndex) => {
          if (typeof example === 'object') {
            const snippet = yaml.stringify(example, {
              defaultStringType: 'PLAIN',
              defaultKeyType: 'PLAIN',
              lineWidth: 0,
              simpleKeys: false
            }).trim();
            block += `${child.name}:\n`;
            block += snippet.split('\n').map(line => '  ' + line).join('\n') + '\n';
          } else if (typeof example === 'string' && example.includes('\n')) {
            block += `${child.name}: |-\n`;
            block += example.split('\n').map(line => '  ' + line).join('\n') + '\n';
          } else {
            // Primitive values
            block += `${child.name}: ${example}\n`;
          }

          // Add separator between examples, but not after the last one
          if (exampleIndex < child.examples.length - 1) {
            block += `\n# ---\n\n`;
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
