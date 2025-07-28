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
  // Sort regions alphabetically within each provider
  const sortedProviders = providers.map(provider => ({
    ...provider,
    regions: [...provider.regions].sort((a, b) => a.name.localeCompare(b.name))
  }));
  const templateFile = path.join(__dirname, `table-${format}.hbs`);
  const templateSrc = fs.readFileSync(templateFile, 'utf8');
  const template = handlebars.compile(templateSrc);
  return template({ providers: sortedProviders, lastUpdated });
}

module.exports = renderCloudRegions;
