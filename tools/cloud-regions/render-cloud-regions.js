const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');


/**
 * Generates a formatted string representing cloud provider regions using a Handlebars template.
 *
 * Sorts regions alphabetically within each provider and renders the data using a template file corresponding to the specified format ('md' or 'adoc'). Optionally includes a last updated timestamp.
 *
 * @param {Object} opts - Options for rendering.
 * @param {Array} [opts.providers] - List of cloud provider objects, each with a name and an array of regions (for non-tabs format).
 * @param {Array} [opts.clusterTypes] - List of cluster type objects, each with providers (for tabs format).
 * @param {string} opts.format - Output format, either 'md' (Markdown) or 'adoc' (AsciiDoc).
 * @param {string} [opts.lastUpdated] - Optional ISO timestamp indicating when the data was last updated.
 * @param {boolean} [opts.tabs=false] - Whether to use tabs format.
 * @param {string} [opts.template] - Optional path to custom template file.
 * @returns {string} The rendered output string.
 * @throws {Error} If the providers/clusterTypes array is missing or empty, or if template compilation fails.
 */
function renderCloudRegions({ providers, clusterTypes, format, lastUpdated, tabs = false, template }) {
  if (tabs) {
    if (!Array.isArray(clusterTypes) || clusterTypes.length === 0) {
      throw new Error('No cluster types/regions found in YAML.');
    }
  } else {
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new Error('No providers/regions found in YAML.');
    }
  }
  
  if (!['md', 'adoc'].includes(format)) {
    throw new Error(`Unsupported format: ${format}. Use 'md' or 'adoc'.`);
  }

  let templateFile;
  if (template) {
    templateFile = template;
  } else if (tabs && format === 'adoc') {
    templateFile = path.join(__dirname, 'cloud-regions-table-adoc-tabs.hbs');
  } else {
    templateFile = path.join(__dirname, `cloud-regions-table-${format}.hbs`);
  }

  if (!fs.existsSync(templateFile)) {
    throw new Error(`Template file not found: ${templateFile}`);
  }

  let templateSrc, compiledTemplate;
  try {
    templateSrc = fs.readFileSync(templateFile, 'utf8');
    compiledTemplate = handlebars.compile(templateSrc);
  } catch (err) {
    throw new Error(`Failed to compile Handlebars template at ${templateFile}: ${err.message}`);
  }

  try {
    if (tabs) {
      return compiledTemplate({ clusterTypes, lastUpdated });
    } else {
      // Sort regions alphabetically within each provider for non-tabs format
      const sortedProviders = providers.map(provider => ({
        ...provider,
        regions: [...provider.regions].sort((a, b) => a.name.localeCompare(b.name))
      }));
      return compiledTemplate({ providers: sortedProviders, lastUpdated });
    }
  } catch (err) {
    throw new Error(`Failed to render Handlebars template at ${templateFile}: ${err.message}`);
  }
}

module.exports = renderCloudRegions;
