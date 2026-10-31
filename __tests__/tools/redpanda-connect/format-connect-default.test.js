'use strict'

// renderConnectFields now takes its *Type*: and inline *Default*: text from
// formatConnectDefault.js, which connectval: shares. This proves the refactor
// changed no output: every component in a real Connect dataset renders
// byte-identically with the pre-refactor function, kept here frozen as it was
// on origin/main 328a2e4.

const fs = require('fs')
const path = require('path')
const renderConnectFields = require('../../../tools/redpanda-connect/helpers/renderConnectFields')
const { formatConnectDefault, connectDisplayType } = require('../../../tools/redpanda-connect/helpers/formatConnectDefault')
const helpers = require('../../../tools/redpanda-connect/helpers')

const frozenRenderConnectFields = (() => {
  const module = { exports: {} }
  // eslint-disable-next-line no-unused-vars
  const require = (name) => {
    const base = path.join(__dirname, '..', '..', '..', 'tools', 'redpanda-connect', 'helpers')
    if (name === 'yaml' || name === 'handlebars') return jest.requireActual(name)
    return jest.requireActual(path.join(base, name))
  }
  const yaml = require('yaml');
  const renderYamlList = require('./renderYamlList');
  const handlebars = require('handlebars');
  const { connectFieldName } = require('./flattenConnectFields');
  const { escapePlaceholderBraces } = require('./renderConnectDescription');
  
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
      } else if (child.kind === 'map') {
        // Maps always render as `object`, regardless of value type.
        displayType = 'object';
      } else if (child.kind === 'array' || child.kind === 'list' || child.kind === '2darray') {
        // Arrays render as `array<element>` when the element type is known,
        // for example `array<string>`. 2D arrays nest the element type, for
        // example `array<array<string>>`. Unknown element types render as
        // plain `array`. A `type` of `array` (used by some overrides to force
        // the old plain-array display) is treated as unknown so the field
        // renders as `array` rather than the degenerate `array<array>`.
        const elementType = (typeof child.type === 'string' && child.type !== '' && child.type !== 'unknown' && child.type !== 'array')
          ? child.type
          : null;
        if (elementType) {
          displayType = child.kind === '2darray'
            ? `array<array<${elementType}>>`
            : `array<${elementType}>`;
        } else {
          displayType = 'array';
        }
      } else {
        displayType = child.type;
      }
  
      let block = '';
      // Only append [] if kind is array and name does not already end with [].
      // Shared with the delta report and the fields-only table so all three
      // producers agree on what a field path looks like.
      const nameWithArray = connectFieldName(child);
      const currentPath = prefix
        ? `${prefix}.${nameWithArray}`
        : `${nameWithArray}`;
  
      block += `=== \`${currentPath}\`\n\n`;
  
      // --- Beta badge logic (now uses is_beta) ---
      // Escaped before the badge is prepended, not after: the badge's own
      // tooltip={page-beta-text} is a real attribute reference and must survive.
      let desc = escapePlaceholderBraces(child.description || '');
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
        block += `include::connect:components:partial$secret_warning.adoc[]\n\n`;
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
            defaultStringType: 'QUOTE_DOUBLE',
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
  return module.exports
})()

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'rpcn-connector-docs', 'docs-data', 'connect-4.53.0.json'), 'utf8'))

const components = []
for (const [key, list] of Object.entries(DATA)) {
  if (!Array.isArray(list)) continue
  for (const entry of list) {
    if (entry && entry.config && Array.isArray(entry.config.children)) components.push([`${key}/${entry.name}`, entry.config.children])
  }
}

describe('renderConnectFields after the formatConnectDefault extraction', () => {
  test('the fixture has components to compare', () => {
    expect(components.length).toBeGreaterThan(100)
  })

  test.each(components)('%s renders byte-identically', (_name, children) => {
    expect(String(renderConnectFields(children))).toBe(String(frozenRenderConnectFields(children)))
  })

  test('the helpers index exports both functions', () => {
    expect(helpers.formatConnectDefault).toBe(formatConnectDefault)
    expect(helpers.connectDisplayType).toBe(connectDisplayType)
  })
})

describe('formatConnectDefault', () => {
  test.each([
    [{ default: 'benthos' }, { ok: true, text: 'benthos' }],
    [{ default: '' }, { ok: true, text: '""' }],
    [{ default: '"quoted"' }, { ok: true, text: '"quoted"' }],
    [{ default: 1024 }, { ok: true, text: '1024' }],
    [{ default: -1 }, { ok: true, text: '-1' }],
    [{ default: false }, { ok: true, text: 'false' }],
    [{ default: [] }, { ok: true, text: '[]' }],
    [{ default: {} }, { ok: true, text: '{}' }],
    [{ default: ['a'] }, { ok: false, reason: 'complex' }],
    [{ default: { stdin: {} } }, { ok: false, reason: 'complex' }],
    [{ default: null }, { ok: false, reason: 'missing' }],
    [{}, { ok: false, reason: 'missing' }],
    [{ default: 2 ** 64 }, { ok: false, reason: 'imprecise' }],
  ])('%j -> %j', (field, expected) => {
    expect(formatConnectDefault(field)).toEqual(expected)
  })

  test('a string default that is already quoted keeps its quotes, as the reference prints it', () => {
    // Real: the reference prints *Default*: `"\n"` style values verbatim.
    expect(formatConnectDefault({ default: '"' }).text).toBe('"')
  })
})

describe('connectDisplayType', () => {
  test.each([
    [{ name: 'topics', type: 'string', kind: 'array' }, 'array<string>'],
    [{ name: 'x', type: 'string', kind: '2darray' }, 'array<array<string>>'],
    [{ name: 'x', type: 'string', kind: 'map' }, 'object'],
    [{ name: 'x', type: 'unknown', kind: 'array' }, 'array'],
    [{ name: 'x[]', type: 'object', kind: 'scalar' }, 'array<object>'],
    [{ name: 'x', type: 'int', kind: 'scalar' }, 'int'],
  ])('%j -> %s', (field, expected) => {
    expect(connectDisplayType(field)).toBe(expected)
  })
})
