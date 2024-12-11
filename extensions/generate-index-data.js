'use strict';
const _ = require('lodash');

module.exports.register = function ({ config }) {
  const logger = this.getLogger('generate-index-data-extension');

  this.on('documentsConverted', async ({ contentCatalog, siteCatalog }) => {
    // Ensure data.sets exists and is an object
    const setsConfig = _.get(config, 'data.sets', {});
    if (!setsConfig || Object.keys(setsConfig).length === 0) {
      logger.warn('No index sets defined in the configuration. Skipping index generation.');
      return;
    }

    try {
      // Process each defined index set
      for (const [setName, setParams] of Object.entries(setsConfig)) {
        logger.info(`Processing index set: ${setName}`);
        const { component, family, filter, env_type, version, output_file, attribute_name } = setParams;

        // Validate required parameters
        const missingParams = [];

        if (!component) missingParams.push('component');
        if (!family) missingParams.push('family');
        if (!attribute_name) missingParams.push('attribute_name');

        if (missingParams.length > 0) {
          logger.warn(`Missing required parameter(s) (${missingParams.join(', ')}) for set "${setName}". Skipping.`);
          continue;
        }

        // Determine the target version
        let targetVersion = version || null;

        if (version === 'latest') {
          // Retrieve the component to access 'latest'
          const componentObj = contentCatalog.getComponents().find(comp => comp.name === component);
          if (componentObj && componentObj.latest && componentObj.latest.version) {
            targetVersion = componentObj.latest.version;
            logger.debug(`Resolved 'latest' to version "${targetVersion}" for component "${component}".`);
          } else {
            targetVersion = null; // Represents unversioned
            logger.info(`Component "${component}" is unversioned. Using the sole available version.`);
          }
        }

        // Gather items based on the target version
        const items = gatherItems(contentCatalog, {
          component,
          family,
          filter,
          env_type,
          version: targetVersion
        }, logger);

        if (!items.length) {
          logger.warn(`No items found for set "${setName}". Skipping output.`);
          continue;
        }

        const uniqueItems = deduplicateItems(items);
        await addDataAttributeToComponents(uniqueItems, contentCatalog, attribute_name, logger);
        if (output_file) createIndexFile(uniqueItems, siteCatalog, output_file, logger);
      }
    } catch (error) {
      logger.error(`Failed to generate indexes: ${error.stack}`);
    }
  });
};

/**
 * Gathers items (pages) from the contentCatalog based on the provided setParams.
 * setParams should contain:
 *   - component (string): Component name to search
 *   - family (string): Family of pages (usually 'page')
 *   - version (string|null): The component version ('latest', specific version, or null for unversioned)
 *   - filter (string, optional): A substring to match in the URL or other criteria
 *   - env_type (string, optional): Deployment type to match ('Docker', 'Kubernetes', 'Linux', 'Redpanda Cloud')
 */
function gatherItems(contentCatalog, setParams, logger) {
  const { component, family, filter, env_type, version } = setParams;
  let pages = [];

  if (version) {
    // Specific version or 'latest' resolved to a version
    pages = contentCatalog.findBy({ component, family, version });
    logger.debug(`Gathering pages for component "${component}" version "${version}". Found ${pages.length} pages.`);
  } else {
    // Unversioned component: gather all pages without specifying version
    pages = contentCatalog.findBy({ component, family });
    logger.debug(`Gathering pages for unversioned component "${component}". Found ${pages.length} pages.`);
  }

  // Filter pages based on provided criteria
  const matched = pages.filter(page => {
    const deploymentType = getDeploymentType(page.asciidoc.attributes);
    const urlMatches = filter ? page.pub.url.includes(filter) : true;
    const envMatches = env_type ? (deploymentType === env_type) : true;

    return urlMatches && envMatches;
  });

  logger.debug(`Found ${matched.length} items in component "${component}" matching filter "${filter}", env_type "${env_type || 'N/A'}".`);

  const mappedItems = matched.map(page => ({
    title: page.asciidoc.doctitle,
    url: page.pub.url,
    description: page.asciidoc.attributes.description || '',
  }));

  const sortedItems = mappedItems.sort((a, b) => {
    const titleA = a.title.toUpperCase();
    const titleB = b.title.toUpperCase();
    if (titleA < titleB) return -1;
    if (titleA > titleB) return 1;
    return 0;
  });

  logger.debug(`Sorted ${sortedItems.length} items alphabetically by title.`);

  return sortedItems;
}

/**
 * Deduplicates items by their URL.
 */
function deduplicateItems(items) {
  const seen = new Set();
  return items.filter(item => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

/**
 * Add the gathered data as an attribute to all components.
 * 
 * @param {Array} data - The deduplicated items to set as an attribute.
 * @param {Object} contentCatalog - The content catalog from Antora.
 * @param {string} attributeName - The name of the attribute to set.
 * @param {Object} logger - The Antora logger.
 */
async function addDataAttributeToComponents(data, contentCatalog, attributeName, logger) {
  if (!attributeName) {
    logger.warn('No attribute_name provided for this data set, skipping attribute injection.');
    return;
  }

  const jsonData = JSON.stringify(data, null, 2);
  const components = await contentCatalog.getComponents();

  components.forEach(component => {
    component.versions.forEach(({ name, asciidoc }) => {
      asciidoc.attributes[attributeName] = jsonData;
      logger.debug(`Set attribute "${attributeName}" on component "${name}".`);
    });
  });

  logger.info(`Added "${attributeName}" attribute to relevant component versions.`);
}

/**
 * Create a JSON file in the output with the given data.
 */
function createIndexFile(data, siteCatalog, outputFile, logger) {
  if (!outputFile) {
    logger.warn('No output_file specified, skipping JSON file creation.');
    return;
  }

  const jsonData = JSON.stringify(data, null, 2);
  siteCatalog.addFile({
    contents: Buffer.from(jsonData, 'utf8'),
    out: {
      path: outputFile
    },
  });
  logger.info(`Created "${outputFile}" with indexed data.`);
}

/**
 * Determine the deployment type from AsciiDoc attributes.
 */
function getDeploymentType(attributes) {
  return attributes['env-kubernetes'] ? 'Kubernetes'
    : attributes['env-linux'] ? 'Linux'
      : attributes['env-docker'] ? 'Docker'
        : attributes['env-cloud'] ? 'Redpanda Cloud'
          : attributes['page-cloud'] ? 'Redpanda Cloud' : '';
}
