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
    if (key === 'examples' && Array.isArray(overrides[key])) {
      // If target[key] is not an array, initialize it
      if (!Array.isArray(target[key])) {
        target[key] = [];
      }
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
 * Resolves $ref references in an object by replacing them with their definitions.
 * Supports JSON Pointer style references like "#/definitions/client_certs".
 * 
 * @param {Object} obj - The object to resolve references in
 * @param {Object} root - The root object containing definitions
 * @returns {Object} The object with references resolved
 */
function resolveReferences(obj, root) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => resolveReferences(item, root));
  }

  const result = {};
  
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$ref' && typeof value === 'string') {
      // Handle JSON Pointer style references
      if (value.startsWith('#/')) {
        const path = value.substring(2).split('/');
        let resolved = root;
        
        try {
          for (const segment of path) {
            resolved = resolved[segment];
          }
          
          if (resolved === undefined) {
            throw new Error(`Reference path not found: ${value}`);
          }
          
          // Merge the resolved object, but don't process $ref in the resolved object
          // to avoid infinite recursion
          Object.assign(result, resolved);
        } catch (err) {
          throw new Error(`Failed to resolve reference "${value}": ${err.message}`);
        }
      } else {
        throw new Error(`Unsupported reference format: ${value}. Only JSON Pointer references starting with '#/' are supported.`);
      }
    } else {
      // Recursively resolve references in nested objects
      result[key] = resolveReferences(value, root);
    }
  }
  
  return result;
}

/**
 * Generates documentation files for RPCN connectors using Handlebars templates.
 *
 * Depending on the {@link writeFullDrafts} flag, generates either partial documentation files for connector fields and examples, or full draft documentation for each connector component. Supports merging override data with $ref references and skips draft generation for components marked as deprecated.
 *
 * @param {Object} options - Configuration options for documentation generation.
 * @param {string} options.data - Path to the connector data file (JSON or YAML).
 * @param {string} [options.overrides] - Optional path to a JSON file with override data. Supports $ref references in JSON Pointer format (e.g., "#/definitions/client_certs").
 * @param {string} options.template - Path to the main Handlebars template.
 * @param {string} [options.templateIntro] - Path to the intro partial template (used in full draft mode).
 * @param {string} [options.templateFields] - Path to the fields partial template.
 * @param {string} [options.templateExamples] - Path to the examples partial template.
 * @param {boolean} options.writeFullDrafts - If true, generates full draft documentation; otherwise, generates partials.
 * @returns {Promise<Object>} An object summarizing the number and paths of generated partials and drafts.
 *
 * @throws {Error} If reading or parsing input files fails, if template rendering fails for a component, or if $ref references cannot be resolved.
 *
 * @remark
 * When generating full drafts, components with a `status` of `'deprecated'` are skipped.
 */
async function generateRpcnConnectorDocs(options) {
  // Recursively mark is_beta on any field/component with description starting with BETA:
  function markBeta(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach(markBeta);
      return;
    }
    if (typeof obj.description === 'string' && obj.description.trim().startsWith('BETA:')) {
      obj.is_beta = true;
    }
    // Recurse into children/config/fields
    if (Array.isArray(obj.children)) obj.children.forEach(markBeta);
    if (obj.config && Array.isArray(obj.config.children)) obj.config.children.forEach(markBeta);
    // For connector/component arrays
    for (const key of Object.keys(obj)) {
      if (Array.isArray(obj[key])) obj[key].forEach(markBeta);
    }
  }

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
  // Mark beta fields/components before overrides
  markBeta(dataObj);

  // Apply overrides if provided
  if (overrides) {
    const ovRaw = fs.readFileSync(overrides, 'utf8');
    const ovObj = JSON.parse(ovRaw);
    // Resolve any $ref references in the overrides
    const resolvedOverrides = resolveReferences(ovObj, ovObj);
    mergeOverrides(dataObj, resolvedOverrides);

    // Special: merge bloblang_methods and bloblang_functions from overrides into main data
    for (const [overrideKey, mainKey] of [
      ['bloblang_methods', 'bloblang-methods'],
      ['bloblang_functions', 'bloblang-functions']
    ]) {
      if (Array.isArray(resolvedOverrides[overrideKey])) {
        if (!Array.isArray(dataObj[mainKey])) dataObj[mainKey] = [];
        // Merge by name
        const mainArr = dataObj[mainKey];
        const overrideArr = resolvedOverrides[overrideKey];
        for (const overrideItem of overrideArr) {
          if (!overrideItem.name) continue;
          const idx = mainArr.findIndex(i => i.name === overrideItem.name);
          if (idx !== -1) {
            mainArr[idx] = { ...mainArr[idx], ...overrideItem };
          } else {
            mainArr.push(overrideItem);
          }
        }
      }
    }
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
  const configExamplesRoot = path.resolve(process.cwd(), 'modules/components/examples');

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

  // Bloblang function/method partials (only if includeBloblang is true)
  if (options.includeBloblang) {
    const bloblangTypes = [
      { key: 'bloblang-functions', folder: 'bloblang/functions' },
      { key: 'bloblang-methods', folder: 'bloblang/methods' }
    ];
    for (const { key, folder } of bloblangTypes) {
      const items = dataObj[key];
      if (!Array.isArray(items)) continue;
      const outRoot = path.join(outputRoot, folder);
      fs.mkdirSync(outRoot, { recursive: true });
      for (const fn of items) {
        if (!fn.name) continue;
        // Compose AsciiDoc content for the function/method
        let adoc = `= ${fn.name}\n\n`;
        if (fn.signature) adoc += `*Signature*: \`${fn.signature}\`\n\n`;
        if (fn.description) adoc += `${fn.description}\n\n`;
        if (Array.isArray(fn.parameters) && fn.parameters.length) {
          adoc += `== Parameters\n\n`;
          for (const param of fn.parameters) {
            adoc += `* \`${param.name}\`: ${param.description || ''}\n`;
          }
          adoc += `\n`;
        }
        if (Array.isArray(fn.examples) && fn.examples.length) {
          adoc += `== Examples\n\n`;
          for (const ex of fn.examples) {
            // If the example is an object with a mapping, summary, and results, format as requested
            if (typeof ex === 'object' && ex !== null && ex.mapping) {
              let codeBlock = '';
              // Summary as comment
              if (ex.summary && ex.summary.trim()) {
                codeBlock += `# ${ex.summary.trim().replace(/\n/g, '\n# ')}\n`;
              }
              // Mapping code
              if (typeof ex.mapping === 'string') {
                codeBlock += ex.mapping.trim() + '\n';
              }
              // Results as # In/Out pairs
              if (Array.isArray(ex.results)) {
                for (const pair of ex.results) {
                  if (Array.isArray(pair) && pair.length === 2) {
                    codeBlock += `\n# In:  ${pair[0]}\n# Out: ${pair[1]}\n`;
                  }
                }
              }
              adoc += `[,coffeescript]\n----\n${codeBlock.trim()}\n----\n`;
            } else {
              // fallback: previous logic
              let exStr = '';
              if (typeof ex === 'string') {
                exStr = ex;
              } else if (typeof ex === 'object' && ex !== null) {
                if (ex.code) {
                  exStr = ex.code;
                } else if (ex.example) {
                  exStr = ex.example;
                } else {
                  try {
                    exStr = require('yaml').stringify(ex).trim();
                  } catch {
                    exStr = JSON.stringify(ex, null, 2);
                  }
                }
              } else {
                exStr = String(ex);
              }
              adoc += `[source,bloblang]\n----\n${exStr}\n----\n`;
            }
          }
          adoc += `\n`;
        }
        if (Array.isArray(fn.related) && fn.related.length) {
          adoc += `== Related\n\n`;
          for (const rel of fn.related) {
            adoc += `* ${rel}\n`;
          }
          adoc += `\n`;
        }
        // Write the partial
        const outPath = path.join(outRoot, `${fn.name}.adoc`);
        fs.writeFileSync(outPath, adoc, 'utf8');
        partialsWritten++;
        partialFiles.push(path.relative(process.cwd(), outPath));
      }
    }
  }

  // Common/Advanced config snippet YAMLs in modules/components/examples
  const commonConfig = helpers.commonConfig;
  const advancedConfig = helpers.advancedConfig;
  for (const [type, items] of Object.entries(dataObj)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item.name || !item.config || !Array.isArray(item.config.children)) continue;
      // Common config
      const commonYaml = commonConfig(item.type, item.name, item.config.children);
      const commonPath = path.join(configExamplesRoot, 'common', type, `${item.name}.yaml`);
      fs.mkdirSync(path.dirname(commonPath), { recursive: true });
      fs.writeFileSync(commonPath, commonYaml.toString(), 'utf8');
      partialsWritten++;
      partialFiles.push(path.relative(process.cwd(), commonPath));
      // Advanced config
      const advYaml = advancedConfig(item.type, item.name, item.config.children);
      const advPath = path.join(configExamplesRoot, 'advanced', type, `${item.name}.yaml`);
      fs.mkdirSync(path.dirname(advPath), { recursive: true });
      fs.writeFileSync(advPath, advYaml.toString(), 'utf8');
      partialsWritten++;
      partialFiles.push(path.relative(process.cwd(), advPath));
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
  mergeOverrides,
  resolveReferences
};
