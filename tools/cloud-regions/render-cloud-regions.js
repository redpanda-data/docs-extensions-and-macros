const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');


/**
 * Render cloud regions data using a Handlebars template.
 * @param {Object} opts
 * @param {Array} opts.providers - Array of provider objects: { name, regions: [{ name, zones, tiers: [str] }] }
 * @param {string} opts.format - 'md' or 'adoc'
 * @param {string} [opts.lastUpdated] - Optional ISO timestamp string for last update
 * @returns {string}
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
