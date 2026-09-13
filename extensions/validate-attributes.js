/* Example use in the playbook
* antora:
    extensions:
 *    - require: ./extensions/validate-attributes.js
*/

'use strict';

const { raiseListenerLimit } = require('./util/raise-listener-limit')
const { createCategoryMap, parseCategoryList, normalizeCategories } = require('../extension-utils/categories')

module.exports.register = function ({ config }) {
  raiseListenerLimit(this)
  const logger = this.getLogger('attribute-validation-extension');

  this.on('documentsConverted', async ({ contentCatalog, siteCatalog }) => {
    // Retrieve valid categories and subcategories from site attributes defined in add-global-attributes.js.
    if (!siteCatalog.attributeFile) return logger.warn('No global attributes file available - skipping attribute validation. Check global-attributes-extension for errors')
    const validCategories = siteCatalog.attributeFile['page-valid-categories'];
    if (!validCategories) return logger.warn('No page-valid-categories attribute found - skipping attribute validation')
    const categoryMap = createCategoryMap(validCategories);
    const pages = contentCatalog.findBy({ family: 'page' });
    pages.forEach((page) => {
      let pageCategories = page.asciidoc.attributes['page-categories'];
      if (!pageCategories) return;
      const pageCategoryList = pageCategories.split(',').map(c => c.trim());
      const validatedCategories = validateCategories(pageCategoryList, page.asciidoc.attributes['page-relative-src-path'], categoryMap, logger);
      page.asciidoc.attributes['page-categories'] = validatedCategories
      processEnvironmentAttributes(page, logger);
    })
  })
}

function processEnvironmentAttributes(page, logger) {
  const envAttributes = ['env-kubernetes', 'env-linux', 'env-docker'];
  envAttributes.forEach(envAttr => {
    if (page.asciidoc.attributes[envAttr]) {
      // If the env attribute exists, set a corresponding page- attribute for use in the UI
      const pageEnvAttr = `page-${envAttr}`;
      page.asciidoc.attributes[pageEnvAttr] = true;
      logger.debug(`Set '${pageEnvAttr}' for ${page.asciidoc.attributes['page-relative-src-path']}`);
    }
  });
}

/**
 * Normalize the authored categories and report what changed. The shared helper
 * does the work; this wrapper only owns the log lines so the build output stays
 * identical to what it was before the extraction.
 */
function validateCategories(pageCategoryList, pageInfo, categoryMap, logger) {
  const { categories, invalid, parentsAdded } = normalizeCategories(pageCategoryList, categoryMap)

  parentsAdded.forEach((parent) => {
    logger.debug(`Added missing parent category '${parent}' in ${pageInfo}`);
  })
  invalid.forEach((category) => {
    logger.warn(`Invalid category '${category}' in ${pageInfo}`);
  })
  if (invalid.length) {
    logger.warn(`Invalid categories detected. For a list of valid categories, see https://github.com/redpanda-data/docs/blob/main/shared/modules/ROOT/partials/valid-categories.yml`);
  }
  return categories.join(', ');
}
