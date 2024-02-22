/* Example use in the playbook
* antora:
    extensions:
 *    - require: ./extensions/add-global-attributes.js
*/

module.exports.register = function ({ config }) {
  const yaml = require('js-yaml');
  const logger = this.getLogger('global-attributes-extension');
  const chalk = require('chalk')
  const _ = require('lodash');

  this.on('contentAggregated', ({ siteCatalog, contentAggregate }) => {
    try {
      for (const component of contentAggregate) {
        if (component.name === 'shared') {
          const attributeFiles = component.files.filter(file => file.path.startsWith('modules/ROOT/partials/') && file.path.endsWith('.yml'));
          if (!attributeFiles.length) {
            logger.warn("No YAML attributes files found in 'shared' component.");
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
      })
    }
  })
}