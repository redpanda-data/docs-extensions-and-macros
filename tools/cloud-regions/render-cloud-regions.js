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
 * @param {string} [opts.template] - Optional absolute path to a custom Handlebars template. Overrides the bundled template for the given format. The caller is responsible for containing this path: bin/doc-tools.js resolves it with resolveInsideRepo before calling, and that is the single enforcement point for the CLI and the MCP server alike.
 * @param {string} [opts.clusterType] - Optional cluster type the data was filtered to. Exposed to the template so a filtered table can name it.
 * @returns {string} The rendered output string.
 * @throws {Error} If the providers array is missing or empty.
 */
function renderCloudRegions({ providers, format, lastUpdated, template, clusterType }) {
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
  const templateFile = template || path.join(__dirname, `cloud-regions-table-${format}.hbs`);
  if (!fs.existsSync(templateFile)) {
    throw new Error(`Template file not found: ${templateFile}`);
  }
  let compiledTemplate;
  try {
    const templateSrc = fs.readFileSync(templateFile, 'utf8');
    // compile() only parses on first render, so a syntax error in a custom
    // template would otherwise be reported as a render failure and send the
    // author looking at their data instead of their braces. precompile parses now.
    handlebars.precompile(templateSrc);
    compiledTemplate = handlebars.compile(templateSrc);
  } catch (err) {
    throw new Error(`Failed to compile Handlebars template at ${templateFile}: ${err.message}`);
  }
  try {
    return compiledTemplate({ providers: sortedProviders, lastUpdated, clusterType });
  } catch (err) {
    throw new Error(`Failed to render Handlebars template at ${templateFile}: ${err.message}`);
  }
}

module.exports = renderCloudRegions;
