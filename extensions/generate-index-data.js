'use strict';
const _ = require('lodash');

module.exports.register = function ({ config }) {
  const logger = this.getLogger('generate-index-data-extension');

  this.on('documentsConverted', async ({ contentCatalog, siteCatalog }) => {
    // Ensure data.sets exists and is an object
    const setsConfig = _.get(config, 'data.sets', {});
    if (!setsConfig || Object.keys(setsConfig).length === 0) {
      logger.info('No index sets defined in the configuration. Skipping index data generation.');
      return;
    }

    try {
      // Process each defined index set
      for (const [setName, setParams] of Object.entries(setsConfig)) {
        logger.info(`Processing index set: ${setName}`);
        const { component, filter, env_type, output_file, attribute_name } = setParams;

        // Validate required parameters
        const requiredParams = ['component', 'attribute_name'];

        const missingParams = requiredParams.filter(param => !setParams[param]);

        if (missingParams.length > 0) {
          logger.warn(`One or more required parameters are missing: ${missingParams.join(', ')} for set "${setName}". Skipping.`);
          continue;
        }

        // Gather items based on the target version
        const items = gatherItems(contentCatalog, {
          component,
          filter,
          env_type,
        }, logger);

        if (!items.length) {
          continue;
        }

        const uniqueItems = deduplicateAndSortItems(items);
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
 *   - component (string, required): Component name to search
 *   - filter (string, optional): A substring to match in the URL or other criteria
 *   - env_type (string, optional): Deployment type to match ('Docker', 'Kubernetes', 'Linux', 'Redpanda Cloud')
 */
function gatherItems(contentCatalog, setParams, logger) {
  const { component, filter, env_type } = setParams;

  // Find the component in the catalog
  const componentObj = contentCatalog.getComponents().find(comp => comp.name === component);
  if (!componentObj) {
    logger.warn(`Component "${component}" not found in the content catalog.`);
    return [];
  }

  const result = [];

  // Iterate through all versions of the component
  componentObj.versions.forEach(versionObj => {
    const versionPages = contentCatalog.findBy({ component, family: 'page', version: versionObj.version });

    logger.debug(`Gathering pages for component "${component}" version "${versionObj.version}". Found ${versionPages.length} pages.`);

    // Filter pages based on criteria
    const matchedPages = versionPages.filter(page => {
      const deploymentType = getDeploymentType(page.asciidoc.attributes);
      const urlMatches = filter ? page.pub.url.includes(filter) : true;
      const envMatches = env_type ? (deploymentType === env_type) : true;

      return urlMatches && envMatches;
    });

    // Map matched pages to the desired structure
    const pages = matchedPages.map(page => ({
      title: page.asciidoc.doctitle,
      url: page.pub.url,
      description: page.asciidoc.attributes.description || ''
    }));

    // Add the component and version structure, even if pages is empty
    result.push({
      component,
      version: versionObj.version,
      pages
    });

    logger.debug(`Processed ${pages.length} pages for version "${versionObj.version}".`);
  });

  logger.debug(`Completed gathering items for component "${component}".`);
  return result;
}

/**
 * Deduplicates items by their URL and returns them in alphabetical order by title.
 */
function deduplicateAndSortItems(items) {
  return items.map(item => {
    const seenUrls = new Set();

    // Deduplicate pages by URL
    const deduplicatedPages = item.pages.filter(page => {
      if (seenUrls.has(page.url)) {
        return false;
      }
      seenUrls.add(page.url);
      return true;
    });

    // Sort pages alphabetically by title
    const sortedPages = deduplicatedPages.sort((a, b) => {
      const titleA = a.title.toLowerCase();
      const titleB = b.title.toLowerCase();
      if (titleA < titleB) return -1;
      if (titleA > titleB) return 1;
      return 0;
    });

    return {
      ...item,
      pages: sortedPages
    };
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
  try {
    const jsonData = JSON.stringify(data, null, 2);
    const components = await contentCatalog.getComponents();

    components.forEach(component => {
      component.versions.forEach(({ name, asciidoc }) => {
        asciidoc.attributes[attributeName] = jsonData;
        logger.debug(`Set attribute "${attributeName}" on component "${name}".`);
      });
    });

    logger.info(`Added "${attributeName}" attribute to relevant component versions.`);
  } catch (error) {
    logger.error(`Failed to add data attribute "${attributeName}": ${error.message}`);
  }
}

/**
 * Create a JSON file in the output with the given data.
 */
function createIndexFile(data, siteCatalog, outputFile, logger) {
  if (!outputFile) {
    logger.info('No output_file specified, skipping JSON file creation.');
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
