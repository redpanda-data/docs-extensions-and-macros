const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');


/**
 * Generates a formatted string representing cloud provider regions using a Handlebars template.
 *
 * Sorts regions alphabetically within each provider and renders the data using a template file corresponding to the specified format ('md' or 'adoc'). Optionally includes a last updated timestamp.
 *
 * @param {Object} opts - Options for rendering.
 * @param {Array} opts.providers - List of cloud provider objects, each with a name and an array of regions.
 * @param {string} opts.format - Output format, either 'md' (Markdown) or 'adoc' (AsciiDoc).
 * @param {string} [opts.lastUpdated] - Optional ISO timestamp indicating when the data was last updated.
 * @returns {string} The rendered output string.
 * @throws {Error} If the providers array is missing or empty.
 */
function renderCloudRegions({ providers, format, lastUpdated }) {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error('No providers/regions found in YAML.');
  }
  if (!['md', 'adoc'].includes(format)) {
    throw new Error(`Unsupported format: ${format}. Use 'md' or 'adoc'.`);
  }
  // Sort regions alphabetically within each provider
  const sortedProviders = providers.map(provider => ({
    ...provider,
    regions: [...provider.regions].sort((a, b) => a.name.localeCompare(b.name))
  }));
  const templateFile = path.join(__dirname, `cloud-regions-table-${format}.hbs`);
  if (!fs.existsSync(templateFile)) {
    throw new Error(`Template file not found: ${templateFile}`);
  }
  let templateSrc, template;
  try {
    templateSrc = fs.readFileSync(templateFile, 'utf8');
    template = handlebars.compile(templateSrc);
  } catch (err) {
    throw new Error(`Failed to compile Handlebars template at ${templateFile}: ${err.message}`);
  }
  try {
    return template({ providers: sortedProviders, lastUpdated });
  } catch (err) {
    throw new Error(`Failed to render Handlebars template at ${templateFile}: ${err.message}`);
  }
}

module.exports = renderCloudRegions;
