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
 * 'annotated_field', 'examples', and known nested fields are overridden.
 */
function mergeOverrides(target, overrides) {
  if (!overrides || typeof overrides !== 'object') return target;
  if (!target || typeof target !== 'object') {
    throw new Error('Target must be a valid object');
  }

  const scalarKeys = ['description', 'type', 'annotated_field', 'version'];

  for (const key in overrides) {
    // === Handle annotated_options ===
    if (key === 'annotated_options' && Array.isArray(overrides[key]) && Array.isArray(target[key])) {
      const overrideMap = new Map(overrides[key].map(([name, desc]) => [name, desc]));

      target[key] = target[key].map(([name, desc]) => {
        if (overrideMap.has(name)) {
          return [name, overrideMap.get(name)];
        }
        return [name, desc];
      });

      const existingNames = new Set(target[key].map(([name]) => name));
      for (const [name, desc] of overrides[key]) {
        if (!existingNames.has(name)) {
          target[key].push([name, desc]);
        }
      }
      continue;
    }

    // === Handle examples ===
    if (key === 'examples' && Array.isArray(overrides[key]) && Array.isArray(target[key])) {
      const overrideMap = new Map(overrides[key].map(o => [o.title, o]));

      target[key] = target[key].map(example => {
        const override = overrideMap.get(example.title);
        if (override) {
          return {
            ...example,
            ...(override.summary && { summary: override.summary }),
            ...(override.config && { config: override.config }),
          };
        }
        return example;
      });

      const existingTitles = new Set(target[key].map(e => e.title));
      for (const example of overrides[key]) {
        if (!existingTitles.has(example.title)) {
          target[key].push(example);
        }
      }
      continue;
    }

    // === Merge arrays of objects with .name ===
    if (Array.isArray(target[key]) && Array.isArray(overrides[key])) {
      target[key] = target[key].map(item => {
        const overrideItem = overrides[key].find(o => o.name === item.name);
        if (overrideItem) {
          scalarKeys.forEach(field => {
            if (Object.hasOwn(overrideItem, field)) {
              item[field] = overrideItem[field];
            }
          });
          if (Object.hasOwn(overrideItem, 'selfManagedOnly')) {
            item.selfManagedOnly = overrideItem.selfManagedOnly;
          }
          return mergeOverrides(item, overrideItem);
        }
        return item;
      });
      continue;
    }

    // === Merge nested objects ===
    if (
      typeof target[key] === 'object' &&
      typeof overrides[key] === 'object' &&
      !Array.isArray(target[key]) &&
      !Array.isArray(overrides[key])
    ) {
      target[key] = mergeOverrides(target[key], overrides[key]);
      continue;
    }

    // === Overwrite scalar keys ===
    if (scalarKeys.includes(key) && Object.hasOwn(overrides, key)) {
      target[key] = overrides[key];
    }
  }

  return target;
}

/**
 * Generates documentation files for RPCN connectors using Handlebars templates.
 *
 * Depending on the {@link writeFullDrafts} flag, generates either partial documentation files for connector fields and examples, or full draft documentation for each connector component. Supports merging override data and skips draft generation for components marked as deprecated.
 *
 * @param {Object} options - Configuration options for documentation generation.
 * @param {string} options.data - Path to the connector data file (JSON or YAML).
 * @param {string} [options.overrides] - Optional path to a JSON file with override data.
 * @param {string} options.template - Path to the main Handlebars template.
 * @param {string} [options.templateIntro] - Path to the intro partial template (used in full draft mode).
 * @param {string} [options.templateFields] - Path to the fields partial template.
 * @param {string} [options.templateExamples] - Path to the examples partial template.
 * @param {boolean} options.writeFullDrafts - If true, generates full draft documentation; otherwise, generates partials.
 * @returns {Promise<Object>} An object summarizing the number and paths of generated partials and drafts.
 *
 * @throws {Error} If reading or parsing input files fails, or if template rendering fails for a component.
 *
 * @remark
 * When generating full drafts, components with a `status` of `'deprecated'` are skipped.
 */
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

        if (examplesOut.trim() && type !== 'bloblang-functions' && type !== 'bloblang-methods') {
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
