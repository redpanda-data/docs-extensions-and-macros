'use strict';

/**
 * data_template macro for Asciidoctor.js
 *
 * This module defines a [data_template] block macro that leverages Handlebars templates to allow us to reference data in JSON or YAML files directly inside Asciidoc pages.
 * It processes external or local data sources (in JSON, YAML, or raw text), compiles a Handlebars template
 * provided within the block, and then parses the resulting content as AsciiDoc using Asciidoctor.
 */

// This global Opal object is available because Antora uses Asciidoctor.js (compiled using Opal) to convert AsciiDoc into HTML.
const asciidoctor = global.Opal && global.Opal.Asciidoctor;
const logger = global.Opal.Asciidoctor.Logging.getLogger();
const handlebars = require('handlebars');
const yaml = require('yaml');
// For synchronous HTTP fetching.
const request = require('sync-request');
// In-memory cache for external resources (avoid repeated network calls)
const externalCache = new Map();

// ========= Handlebars helpers =============

/**
 * Looks for a field with a matching name in an array of field objects.
 *
 * @param {Array<Object>} children - An array of objects. Each object is expected to have a "name" property.
 * @param {string} fieldName - The name of the field to search for.
 * @param {Object} options - The Handlebars options object, which provides the methods `fn` and `inverse` for block rendering.
 * @returns {string} The rendered block using the found field as context if the field is found; otherwise, the inverse block.
 */
function findByName(children, fieldName, options) {
  if (!Array.isArray(children)) {
    return options.inverse(this); // if not an array, execute the else block
  }
  const field = children.find(f => f.name === fieldName);
  if (!field) {
    return options.inverse(this); // if the name is not found, use the {{else}} block
  }
  return options.fn(field); // render the block with the found name as context
}

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

// Register all helpers with Handlebars
handlebars.registerHelper('findByName', findByName);
handlebars.registerHelper('uppercase', uppercase);
handlebars.registerHelper('eq', eq);
handlebars.registerHelper('ne', ne);

// ============= End of helpers ===========================


// Defines a [data_template] block that uses Handlebars.
function registerData_TemplateExtension(registry, config) {
  registry.block('data_template', function () {
    const self = this;
    self.positionalAttributes(['dataPath']);
    self.onContext('open');
    self.process((parent, reader, attrs) => {
      return processData_TemplateBlock(parent, reader, attrs, config, self);
    });
  });
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

  dataObj.__rawYAML = contentStr;

  // Compile the Handlebars template from the block’s content.
  const templateSource = reader.getLines().join('\n');
  let compiledText = '';
  try {
    const template = handlebars.compile(templateSource);
    compiledText = template(dataObj);
  } catch (err) {
    const msg = `[data_template] Handlebars error: ${err}`;
    return extensionRef.createBlock(parent, 'paragraph', msg, attrs);
  }

  // Parse the compiled text as AsciiDoc using the global Asciidoctor instance.
  try {
    const doc = asciidoctor.load(compiledText);
    doc.getBlocks().forEach((b) => {
      parent.append(b);
    });
  } catch (err) {
    const msg = `[data_template] Error parsing compiled template as AsciiDoc: ${err}`;
    return extensionRef.createBlock(parent, 'paragraph', msg, attrs);
  }

  // Return an empty block so that we don’t render duplicate content.
  return extensionRef.createBlock(parent, 'paragraph', '');
}

module.exports = {
  register: registerData_TemplateExtension,
};
