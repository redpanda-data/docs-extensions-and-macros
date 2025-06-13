'use strict';

const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');
const yaml = require('yaml');
const helpers = require('./helpers');

// Register each helper under handlebars, verifying that it’s a function
Object.entries(helpers).forEach(([name, fn]) => {
  if (typeof fn !== 'function') {
    console.error(`❌ Helper "${name}" is not a function`);
    process.exit(1);
  }
  handlebars.registerHelper(name, fn);
});

// Default “main” template (connector.hbs) which invokes partials {{> intro}}, {{> fields}}, {{> examples}}
const DEFAULT_TEMPLATE = path.resolve(__dirname, './templates/connector.hbs');

/**
 * Reads a file at `filePath` and registers it as a Handlebars partial called `name`.
 * Throws if the file cannot be read.
 */
function registerPartial(name, filePath) {
  const resolved = path.resolve(filePath);
  let source;
  try {
    source = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new Error(`Unable to read "${name}" template at ${resolved}: ${err.message}`);
  }
  handlebars.registerPartial(name, source);
}

/**
 * Deep-merge `overrides` into `target`. Only 'description', 'type',
 * plus nested array/object entries get overridden; other keys remain intact.
 */
function mergeOverrides(target, overrides) {
  if (!overrides || typeof overrides !== 'object') return target;
  if (!target || typeof target !== 'object') {
    throw new Error('Target must be a valid object');
  }
  for (const key in overrides) {
    if (Array.isArray(target[key]) && Array.isArray(overrides[key])) {
      // Merge two parallel arrays by matching items on `.name`
      target[key] = target[key].map(item => {
        const overrideItem = overrides[key].find(o => o.name === item.name);
        if (overrideItem) {
          // Overwrite description/type if present
          ['description', 'type'].forEach(field => {
            if (Object.hasOwn(overrideItem, field)) {
              item[field] = overrideItem[field];
            }
          });
          // Recurse for nested children
          item = mergeOverrides(item, overrideItem);
        }
        return item;
      });
    } else if (
      typeof target[key] === 'object' &&
      typeof overrides[key] === 'object' &&
      !Array.isArray(target[key]) &&
      !Array.isArray(overrides[key])
    ) {
      // Deep-merge plain objects
      target[key] = mergeOverrides(target[key], overrides[key]);
    } else if (['description', 'type'].includes(key) && Object.hasOwn(overrides, key)) {
      // Overwrite the primitive
      target[key] = overrides[key];
    }
  }
  return target;
}

async function generateRpcnConnectorDocs(options) {
  const {
    data,
    overrides,
    template,            // main Handlebars template (for full-draft mode)
    templateIntro,
    templateFields,
    templateExamples,
    writeFullDrafts
  } = options;

  // Read connector index (JSON or YAML)
  const raw = fs.readFileSync(data, 'utf8');
  const ext = path.extname(data).toLowerCase();
  const dataObj = ext === '.json' ? JSON.parse(raw) : yaml.parse(raw);

  // Apply overrides if provided
  if (overrides) {
    const ovRaw = fs.readFileSync(overrides, 'utf8');
    const ovObj = JSON.parse(ovRaw);
    mergeOverrides(dataObj, ovObj);
  }

  // Compile the “main” template (used when writeFullDrafts = true)
  const compiledTemplate = handlebars.compile(fs.readFileSync(template, 'utf8'));

  // Determine which templates to use for “fields” and “examples”
  // If templateFields is not provided, fall back to the single `template`.
  // If templateExamples is not provided, skip examples entirely.
  const fieldsTemplatePath   = templateFields   || template;
  const examplesTemplatePath = templateExamples || null;

  // Register partials
  if (!writeFullDrafts) {
    if (fieldsTemplatePath) {
      registerPartial('fields', fieldsTemplatePath);
    }
    if (examplesTemplatePath) {
      registerPartial('examples', examplesTemplatePath);
    }
  } else {
    registerPartial('intro', templateIntro);
  }

  const outputRoot     = path.resolve(process.cwd(), 'modules/components/partials');
  const fieldsOutRoot   = path.join(outputRoot, 'fields');
  const examplesOutRoot = path.join(outputRoot, 'examples');
  const draftsRoot      = path.join(outputRoot, 'drafts');

  if (!writeFullDrafts) {
    fs.mkdirSync(fieldsOutRoot,   { recursive: true });
    fs.mkdirSync(examplesOutRoot, { recursive: true });
  }

  let partialsWritten = 0;
  let draftsWritten   = 0;
  const partialFiles  = [];
  const draftFiles    = [];

  for (const [type, items] of Object.entries(dataObj)) {
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      if (!item.name) continue;
      const name = item.name;

      if (!writeFullDrafts) {
        // Render fields using the registered “fields” partial
        const fieldsOut = handlebars
          .compile('{{> fields children=config.children}}')(item);

        // Render examples only if an examples template was provided
        let examplesOut = '';
        if (examplesTemplatePath) {
          examplesOut = handlebars
            .compile('{{> examples examples=examples}}')(item);
        }

        if (fieldsOut.trim()) {
          const fPath = path.join(fieldsOutRoot, type, `${name}.adoc`);
          fs.mkdirSync(path.dirname(fPath), { recursive: true });
          fs.writeFileSync(fPath, fieldsOut);
          partialsWritten++;
          partialFiles.push(path.relative(process.cwd(), fPath));
        }

        if (examplesOut.trim()) {
          const ePath = path.join(examplesOutRoot, type, `${name}.adoc`);
          fs.mkdirSync(path.dirname(ePath), { recursive: true });
          fs.writeFileSync(ePath, examplesOut);
          partialsWritten++;
          partialFiles.push(path.relative(process.cwd(), ePath));
        }
      }

      if (writeFullDrafts) {
        if (String(item.status || '').toLowerCase() === 'deprecated') {
          console.log(`Skipping draft for deprecated component: ${type}/${name}`);
          continue;
        }
        let content;
        try {
          content = compiledTemplate(item);
        } catch (err) {
          throw new Error(`Template render failed for component "${name}": ${err.message}`);
        }

        const draftSubdir = name === 'gateway'
          ? path.join(draftsRoot, 'cloud-only')
          : draftsRoot;

        const destFile = path.join(draftSubdir, `${name}.adoc`);
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.writeFileSync(destFile, content, 'utf8');
        draftsWritten++;
        draftFiles.push(path.relative(process.cwd(), destFile));
      }
    }
  }

  return {
    partialsWritten,
    draftsWritten,
    partialFiles,
    draftFiles
  };
}

module.exports = {
  generateRpcnConnectorDocs,
  mergeOverrides
};
