/* Example use in the playbook
* antora:
    extensions:
 *    - require: ./extensions/add-global-attributes.js
*/

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const _ = require('lodash');

const ATTRIBUTES_PATH = 'modules/ROOT/partials/';  // Default path within the 'shared' component

module.exports.register = function ({ config }) {
  const logger = this.getLogger('global-attributes-extension');
  const chalk = require('chalk');

  /**
   * Load global attributes from a specified local file if provided.
   */
  function loadLocalAttributes(siteCatalog, localAttributesFile) {
    try {
      const resolvedPath = path.resolve(localAttributesFile);
      if (!fs.existsSync(resolvedPath)) {
        logger.warn(`Local attributes file "${localAttributesFile}" does not exist.`);
        return false;  // Return false if the local file doesn't exist
      }

      const fileContents = fs.readFileSync(resolvedPath, 'utf8');
      const fileAttributes = yaml.load(fileContents);

      siteCatalog.attributeFile = _.merge({}, fileAttributes);
      console.log(chalk.green(`Loaded global attributes from local file "${localAttributesFile}".`));
      return true;  // Return true if the local attributes were successfully loaded

    } catch (error) {
      logger.error(`Error loading local attributes from "${localAttributesFile}": ${error.message}`);
      return false;  // Return false if an error occurs
    }
  }

  this.on('contentAggregated', ({ siteCatalog, contentAggregate }) => {
    try {
      let attributesLoaded = false;

      // Try to load attributes from the local file if provided
      if (config.attributespath) {
        attributesLoaded = loadLocalAttributes(siteCatalog, config.attributespath);
      }

      // If no local attributes were loaded, fallback to the 'shared' component
      if (!attributesLoaded) {
        let sharedComponentFound = false;

        for (const component of contentAggregate) {
          if (component.name === 'shared') {
            sharedComponentFound = true;
            const attributeFiles = component.files.filter(file => file.path.startsWith(ATTRIBUTES_PATH) && (file.path.endsWith('.yml') || file.path.endsWith('.yaml'));

            if (!attributeFiles.length) {
              logger.warn(`No YAML attributes files found in 'shared' component in ${ATTRIBUTES_PATH}.`);
            } else {
              siteCatalog.attributeFile = attributeFiles.reduce((acc, file) => {
                const fileAttributes = yaml.load(file.contents.toString('utf8'));
                return _.merge(acc, fileAttributes);
              }, {});
              console.log(chalk.green('Loaded global attributes from shared component.'));
            }
            break;
          }
        }

        // If no 'shared' component is found, log a warning
        if (!sharedComponentFound) {
          logger.warn("No component named 'shared' found in the content and no valid local attributes file provided. Global attributes will not be available. You may see Asciidoc warnings about missing attributes and some behavior may not work as expected.");
        }
      }

    } catch (error) {
      logger.error(`Error loading attributes: ${error.message}`);
    }
  })

  .on('contentClassified', async ({ siteCatalog, contentCatalog }) => {
    const components = await contentCatalog.getComponents();
    for (let i = 0; i < components.length; i++) {
      let component = components[i];
      component.versions.forEach(({ asciidoc }) => {
        if (siteCatalog.attributeFile) {
          asciidoc.attributes = _.merge({}, siteCatalog.attributeFile, asciidoc.attributes);
        }
      });
    }
  });
};