/* Example use in the playbook
* antora:
    extensions:
 *    - require: ./extensions/add-global-attributes.js
*/

module.exports.register = function ({ config }) {
  const yaml = require('js-yaml');
  const _ = require('lodash');
  const logger = this.getLogger('global-attributes-extension');
  const chalk = require('chalk')

  this.on('contentAggregated', ({ siteCatalog, contentAggregate }) => {
    let attributeFile;
    try {
      for (const component of contentAggregate) {
        if (component.name === 'shared') {
          attributeFile = component.files.find(file => file.path.includes('attributes.yml'));
          if (!attributeFile) {
            logger.warn("No attributes.yml file found in 'shared' component.");
          } else {
            siteCatalog.attributeFile = yaml.load(attributeFile.contents.toString('utf8'));
            console.log(chalk.green('Loaded attributes from shared component.'));
          }
          break
        }
      }
    } catch (error) {
      logger.error(`Error loading attributes: ${error.message}`);
    }
  })

  .on('contentClassified', ({ siteCatalog, contentCatalog }) => {
    const components = contentCatalog.getComponents()
    try {
      components.forEach(({versions}) => {
        versions.forEach(({asciidoc}) => {
          asciidoc.attributes = _.merge(asciidoc.attributes, siteCatalog.attributeFile);
        })
      });
      console.log(chalk.green('Merged global attributes into each component version.'));
    } catch (error) {
      logger.error(`Error merging attributes: ${error.message}`);
    }
  });
}