'use strict';

/**
 * data_template macro for Asciidoctor.js
 *
 * This module defines a [data_template] block macro that leverages Handlebars templates to allow us to reference data in JSON or YAML files directly inside Asciidoc pages.
 * It processes external or local data sources (in JSON, YAML, or raw text), compiles a Handlebars template
 * provided within the block, and then parses the resulting content as AsciiDoc using Asciidoctor.
 */

// This global Opal object is available because Antora uses Asciidoctor.js (compiled using Opal) to convert AsciiDoc into HTML.
const loggerLib = require('@antora/logger');
loggerLib.configure({
  format: 'pretty',
  level: 'error'
});
const path = require('path').posix;
const logger = loggerLib.getLogger('data-template');
const handlebars = require('handlebars');
const loadAsciiDoc = require('@antora/asciidoc-loader')
const jsonpath = require('jsonpath-plus');
const yaml = require('yaml');
// For synchronous HTTP fetching.
const request = require('sync-request');
const computeOut = require('../extension-utils/compute-out.js');
const createAsciiDocFile = require('../extension-utils/create-asciidoc-file.js');

// In-memory cache for external resources (avoid repeated network calls)
const externalCache = new Map();

// ========= Handlebars helpers =============

/**
 * Converts a string to uppercase.
 *
 * @param {string} str - The string to convert.
 * @returns {string} The uppercase version of the input string.
 */
function uppercase(str) {
  return String(str).toUpperCase();
}

/**
 * Checks if two values are equal.
 *
 * @param {*} a - The first value.
 * @param {*} b - The second value.
 * @returns {string} True if the values are equal.
 */
function eq(a, b) {
  if (a === b) {
    return true;
  }
  return false;
}

/**
 * Checks if two values are not equal.
 *
 * @param {*} a - The first value.
 * @param {*} b - The second value.
 * @returns {string} False if the values are not equal.
 */
function ne(a, b) {
  if (a !== b) {
    return true;
  }
  return false;
}

/**
 * Renders the children of a configuration object.
 *
 * @param {Array<Object>} children - An array of child objects.
 * @returns {string} The rendered string containing the configuration details.
 */
function renderConnectFields(children, prefix = '') {
  if (!children || !Array.isArray(children) || children.length === 0) {
    return '';
  }

  let output = '';
  prefix = typeof prefix === 'string' ? prefix : '';

  children.forEach(child => {
    const isArray = child.kind === 'array';
    if (!child.name) return;
    const currentPath = prefix ? `${prefix}.${child.name}${isArray ? '[]' : ''}` : `${child.name}${isArray ? '[]' : ''}`;

    // Section header for the field.
    output += `=== \`${currentPath}\`\n\n`;

    // Append description if available.
    if (child.description) {
      output += `${child.description}\n\n`;
    }

    // Inject admonition if the config is secret.
    if (child.is_secret === true) {
      output += `include::redpanda-connect:components:partial$secret_warning.adoc[]\n\n`;
    }

    // Insert version requirement if a version is provided.
    if (child.version) {
      output += `Requires version ${child.version} or later.\n\n`;
    }

    // Append type.
    output += `*Type*: \`${child.type}\`\n\n`;

    // For non-object types, output the default value if present.
    if (child.type !== 'object' && child.default !== undefined) {
      if (child.default === "") {
        output += `*Default*: \`""\`\n\n`;
      } else {
        output += `*Default*: \`${child.default}\`\n\n`;
      }
    }

    // If annotated_options is present, build the AsciiDoc table.
    if (child.annotated_options && Array.isArray(child.annotated_options) && child.annotated_options.length > 0) {
      output += "[cols=\"1m,2a\"]\n";
      output += "|===\n";
      output += "|Option |Summary\n\n";
      child.annotated_options.forEach(optionPair => {
        // Ensure each optionPair is an array with at least two items:
        if (Array.isArray(optionPair) && optionPair.length >= 2) {
          output += `|${optionPair[0]}\n|${optionPair[1]}\n\n`;
        }
      });
      output += "|===\n\n";
    }

    if (child.options && Array.isArray(child.options) && child.options.length > 0) {
      output += `*Options*: ${child.options.map(option => `\`${option}\``).join(', ')}\n\n`;
    }
    

    // If examples are provided, add a fenced YAML block.
    if (child.examples) {
      output += "```yaml\n";
      output += "# Examples:\n";

      // Branch for string fields.
      if (child.type === 'string') {
        // If the field is an array of strings.
        if (child.kind === 'array') {
          child.examples.forEach(exampleGroup => {
            output += `${child.name}:\n`;
            if (Array.isArray(exampleGroup)) {
              exampleGroup.forEach(exampleValue => {
                if (typeof exampleValue === 'string' && exampleValue.includes('\n')) {
                  // Use literal block syntax for multi-line strings.
                  output += `  - |-\n`;
                  let indentedLines = exampleValue
                    .split('\n')
                    .map(line => '      ' + line)
                    .join('\n');
                  output += `${indentedLines}\n`;
                } else {
                  output += `  - ${exampleValue}\n`;
                }
              });
            } else {
              // Fallback for single value example group.
              if (typeof exampleGroup === 'string' && exampleGroup.includes('\n')) {
                output += `  - |-\n`;
                let indentedLines = exampleGroup
                  .split('\n')
                  .map(line => '      ' + line)
                  .join('\n');
                output += `${indentedLines}\n`;
              } else {
                output += `  - ${exampleGroup}\n`;
              }
            }
            output += "\n";
          });
        } else {
          // For non-array string examples, output them as key/value pairs.
          child.examples.forEach(example => {
            if (example.includes('\n')) {
              output += `${child.name}: |-\n`;
              let indentedLines = example.split('\n').map(line => '  ' + line).join('\n');
              output += `${indentedLines}\n`;
            } else {
              output += `${child.name}: ${example}\n`;
            }
          });
        }
      }
      // Branch for processor fields.
      else if (child.type === 'processor') {
        if (child.kind === 'array') {
          child.examples.forEach(exampleGroup => {
            output += `${child.name}:\n`;
            if (Array.isArray(exampleGroup)) {
              exampleGroup.forEach(exampleObj => {
                let yamlSnippet = yaml.stringify(exampleObj).trim();
                let lines = yamlSnippet.split('\n');
                let formattedLines = lines.map((line, idx) => {
                  return idx === 0 ? "  - " + line : "    " + line;
                }).join('\n');
                output += formattedLines + "\n";
              });
            } else {
              let yamlSnippet = yaml.stringify(exampleGroup).trim();
              let lines = yamlSnippet.split('\n');
              let formattedLines = lines.map((line, idx) => {
                return idx === 0 ? "  - " + line : "    " + line;
              }).join('\n');
              output += formattedLines + "\n";
            }
            output += "\n";
          });
        } else {
          child.examples.forEach(example => {
            output += `${child.name}: ${example}\n`;
          });
        }
      }
      // Branch for object fields.
      else if (child.type === 'object') {
        // If this object is actually an array of objects.
        if (child.kind === 'array') {
          child.examples.forEach(exampleGroup => {
            output += `${child.name}:\n`;
            if (Array.isArray(exampleGroup)) {
              exampleGroup.forEach(exampleObj => {
                let yamlSnippet = yaml.stringify(exampleObj).trim();
                let lines = yamlSnippet.split('\n');
                let formattedLines = lines.map((line, idx) => {
                  return idx === 0 ? "  - " + line : "    " + line;
                }).join('\n');
                output += formattedLines + "\n";
              });
            } else {
              let yamlSnippet = yaml.stringify(exampleGroup).trim();
              let lines = yamlSnippet.split('\n');
              let formattedLines = lines.map((line, idx) => {
                return idx === 0 ? "  - " + line : "    " + line;
              }).join('\n');
              output += formattedLines + "\n";
            }
            output += "\n";
          });
        } else {
          // Fallback for non-array object examples.
          child.examples.forEach(example => {
            if (typeof example === 'object') {
              let yamlSnippet = yaml.stringify(example).trim();
              let lines = yamlSnippet.split('\n');
              let formattedLines = lines.map((line, idx) => idx === 0 ? line : "  " + line).join('\n');
              output += `${child.name}:\n${formattedLines}\n`;
            } else {
              output += `${child.name}: ${example}\n`;
            }
          });
        }
      }
      // Fallback for any other field types.
      else {
        child.examples.forEach(example => {
          output += `${child.name}: ${example}\n`;
        });
      }

      output += "```\n\n";
    }

    // Recursively render any nested children.
    if (child.children && Array.isArray(child.children) && child.children.length > 0) {
      output += renderConnectFields(child.children, currentPath);
    }
  });

  // Return a SafeString so that Handlebars doesn't escape special characters.
  return new handlebars.SafeString(output);
}

/**
 * Renders a list of examples.
 *
 * @param {Array<Object>} examples - An array of example objects.
 * @returns {string} The rendered string containing the examples.
 */
function renderConnectExamples(examples) {
  // If there are no examples, return an empty string.
  if (!examples || !Array.isArray(examples) || examples.length === 0) {
    return '';
  }
  // Start with a level-2 heading for all examples.
  let output = '';
  // Iterate over each example.
  examples.forEach(example => {
    // Render the example title as a level-3 heading.
    if (example.title) {
      output += `=== ${example.title}\n\n`;
    }

    // Render the summary if provided.
    if (example.summary) {
      output += `${example.summary}\n\n`;
    }

    // Render the example config inside an AsciiDoc code block.
    // Using a [source,yaml] block and "----" as delimiters.
    if (example.config) {
      output += `[source,yaml]\n----\n`;
      output += example.config.trim() + "\n";
      output += "----\n\n";
    }
  });
  // Return as a SafeString so that Handlebars doesn't escape markup.
  return new handlebars.SafeString(output);
}

/**
 * Selects data from a JSON object using a JSONPath expression.
 *
 * @param {Object} context - The JSON object to query.
 * @param {string} pathExpression - The JSONPath expression to use for selection.
 * @param {Object} options - Handlebars options object.
 * @returns {string} The rendered string containing the selected data.
 */

function selectByJsonPath(context, pathExpression, options) {
  // Query the context with the provided JSONPath expression.
  pathExpression = (typeof pathExpression === 'string' && pathExpression !== '') ? pathExpression : "$";
  const results = jsonpath.JSONPath({ path: pathExpression, json: context });
  // If no results are found, render the inverse block.
  if (!results || results.length === 0) {
    return options.inverse ? options.inverse(this) : '';
  }

  // If exactly one result is found, use that as the context.
  if (results.length === 1) {
    return options.fn(results[0]);
  }

  // Otherwise, if multiple results are found, iterate over them.
  let resultString = '';
  results.forEach(result => {
    resultString += options.fn(result);
  });
  return resultString;
}

// Register all helpers with Handlebars
handlebars.registerHelper('uppercase', uppercase);
handlebars.registerHelper('eq', eq);
handlebars.registerHelper('ne', ne);
handlebars.registerHelper('renderConnectFields', renderConnectFields);
handlebars.registerHelper('renderConnectExamples', renderConnectExamples);
handlebars.registerHelper('selectByJsonPath', selectByJsonPath);



// ============= End of helpers ===========================


/**
 * Recursively merges properties from the `overrides` object into the `target` object.
 *
 * - If both `target[key]` and `overrides[key]` are arrays, it matches each item in `target` with an item in `overrides`
 *   that has the same `name` property, then merges selected fields and also recursively processes nested objects.
 * - If both `target[key]` and `overrides[key]` are plain objects, it merges them recursively.
 * - Otherwise, it simply replaces `target[key]` with `overrides[key]`.
 *
 * @param {Object} target   The object into which overrides will be merged.
 * @param {Object} overrides The object containing override properties.
 * @returns {Object}        The updated `target` object.
 */
function mergeOverrides(target, overrides) {
  if (!overrides || typeof overrides !== 'object') return target;

  for (let key in overrides) {
    // Handle arrays by matching items on 'name'
    if (Array.isArray(target[key]) && Array.isArray(overrides[key])) {
      target[key] = target[key].map(item => {
        const overrideItem = overrides[key].find(o => o.name === item.name);
        if (overrideItem) {
          // Only override allowed fields if they are explicitly defined
          ['description', 'type'].forEach(field => {
            if (overrideItem.hasOwnProperty(field)) {
              item[field] = overrideItem[field];
            }
          });

          // Recursively handle nested children
          item = mergeOverrides(item, overrideItem);
        }
        return item;
      });

    // Recurse into nested objects
    } else if (
      typeof target[key] === 'object' &&
      typeof overrides[key] === 'object' &&
      !Array.isArray(target[key]) &&
      !Array.isArray(overrides[key])
    ) {
      target[key] = mergeOverrides(target[key], overrides[key]);

    // Only override top-level description/type if defined in overrides
    } else if (['description', 'type'].includes(key) && overrides.hasOwnProperty(key)) {
      target[key] = overrides[key];
    }
  }
  return target;
}


function processData_TemplateBlock(parent, reader, attrs, config, extensionRef) {
  const catalog = config.contentCatalog;
  if (!catalog) {
    logger.error('[data_template] Error: content catalog not found');
    return extensionRef.createBlock(parent, 'paragraph', 'Error: content catalog not found', attrs);
  }

  // The dataPath may be an Antora resource ID (for local files)
  // or an external URL (like https://example.com/data.json)
  const resourceId = attrs.dataPath;
  if (!resourceId) {
    const msg = '[data_template] Error: No data resource ID provided.';
    return extensionRef.createBlock(parent, 'paragraph', msg, attrs);
  }

  let contentStr;
  let ext = '';

  if (resourceId.startsWith('http://') || resourceId.startsWith('https://')) {
    // Handle external resource
    try {
      if (externalCache.has(resourceId)) {
        contentStr = externalCache.get(resourceId);
      } else {
        const res = request('GET', resourceId, { timeout: 5000 });
        contentStr = res.getBody('utf8');
        externalCache.set(resourceId, contentStr);
      }
      // Determine file extension from the URL’s pathname.
      try {
        const urlObj = new URL(resourceId);
        const pathname = urlObj.pathname;
        ext = pathname.substring(pathname.lastIndexOf('.')).toLowerCase();
      } catch (err) {
        ext = '';
      }
    } catch (err) {
      const msg = `[data_template] Error fetching external resource: ${err}`;
      return extensionRef.createBlock(parent, 'paragraph', msg, attrs);
    }
  } else {
    // Handle local resource using Antora's content catalog.
    const fileSrc = config.file && config.file.src;
    const resourceFile = catalog.resolveResource(resourceId, fileSrc);
    if (!resourceFile) {
      const msg = `[data_template] Could not resolve resource: ${resourceId}`;
      return extensionRef.createBlock(parent, 'paragraph', msg, attrs);
    }
    try {
      contentStr = resourceFile.contents.toString();
      ext = resourceFile.src.extname.toLowerCase();
    } catch (err) {
      const msg = `[data_template] Error reading local resource: ${err}`;
      return extensionRef.createBlock(parent, 'paragraph', msg, attrs);
    }
  }

  // Load and parse the data from the resource.
  let dataObj = null;
  try {
    if (ext === '.json') {
      dataObj = JSON.parse(contentStr);
    } else if (ext === '.yaml' || ext === '.yml') {
      dataObj = yaml.parse(contentStr);
    } else {
      // Fallback: try JSON first, then yaml, then default to raw text.
      try {
        dataObj = JSON.parse(contentStr);
      } catch (jsonErr) {
        try {
          dataObj = yaml.parse(contentStr);
        } catch (yamlErr) {
          dataObj = { text: contentStr };
        }
      }
    }
  } catch (err) {
    const msg = `[data_template] Error parsing data: ${err}`;
    return extensionRef.createBlock(parent, 'paragraph', msg, attrs);
  }

  if (attrs.overrides) {
    try {
      const overridesFile = catalog.resolveResource(attrs.overrides, config.file.src);
      if (overridesFile) {
        const overridesStr = overridesFile.contents.toString();
        const overridesObj = JSON.parse(overridesStr);
        dataObj = mergeOverrides(dataObj, overridesObj);
      }
    } catch (err) {
      logger.error(`[data_template] Error applying overrides: ${err}`);
    }
  }
  dataObj.__rawYAML = contentStr;

  // Compile the Handlebars template from the block’s content.
  let templateSource = reader.getLines().join('\n');
  templateSource = templateSource.replace(/@@tab-content@@/g, '--')
  let compiledText = '';
  try {
    const template = handlebars.compile(templateSource);
    compiledText = template(dataObj);
  } catch (err) {
    const msg = `[data_template] Handlebars error: ${err}`;
    return extensionRef.createBlock(parent, 'paragraph', msg, attrs);
  }

  // The following block takes the Handlebars-generated AsciiDoc content (`compiledText`)
  // and parses it in the context of the parent document (`doc`). This is important
  // because it allows Antora’s custom include logic and other extensions to be applied
  // to the content as if it were part of the original AsciiDoc source. After parsing
  // and converting the new document, we append the resulting blocks back into the
  // parent node, merging the dynamically generated content into the final
  // output. Any errors during parsing are caught and reported as a paragraph block.
  try {
    const sourceFile = config.file?.src;
    const baseDir = sourceFile?.relative ? path.dirname(sourceFile.relative) : 'fragments';
    const uniqueName = `data_template-${Date.now()}.adoc`;
    const relativePath = path.join(baseDir, uniqueName);
    const doc = parent.getDocument();
    const attributes = doc.getAttributes()

    const file = {
      contents: Buffer.from(`${compiledText}`),
      src: {
        component: attributes['page-component-name'],
        version: attributes['page-component-version'],
        module: attributes['page-module'],
        family: 'page',
        relative: relativePath,
      },
    };
    try {
      file.out = computeOut.call(config.contentCatalog, file.src)
      const outFile = createAsciiDocFile(config.contentCatalog, file);
      const newDoc = loadAsciiDoc(outFile, config.contentCatalog, {
        ...doc.getOptions(),
        relativizeResourceRefs: true,
        attributes: {
          ...(doc.getOptions().attributes || {}),
          ...(attributes || {}),
        },
      });
      newDoc.getBlocks().forEach((b) => {
        parent.append(b);
      });
      return null;
    } catch (err) {
      console.warn('❌ loadAsciiDoc threw:', err);
      return extensionRef.createBlock(parent, 'paragraph', `[data_template] loadAsciiDoc error: ${err.message}`, attrs);
    }
  } catch (err) {
    const msg = `[data_template] Error parsing compiled template as AsciiDoc: ${err}`;
    return extensionRef.createBlock(parent, 'paragraph', msg, attrs);
  }
}

module.exports.register = (registry, context) => {
  if (!registry && context) return;

  const toProc = (fn) => Object.defineProperty(fn, '$$arity', { value: fn.length });

  function createExtensionGroup({ contentCatalog, file }) {
    return function () {
      this.block('data_template', function () {
        this.positionalAttributes(['dataPath', 'overrides']);
        this.onContext('open');
        this.process((parent, reader, attrs) => {
          return processData_TemplateBlock(parent, reader, attrs, { contentCatalog, file }, this);
        });
      });
    };
  }

  registry.$groups().$store('data-template-ext', toProc(createExtensionGroup(context)));
  return registry
};

