/* Example use in the playbook
* antora:
    extensions:
 *    - require: ./extensions/validate-attributes.js
*/

'use strict';

module.exports.register = function ({ config }) {
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
      let pageCategoryList = pageCategories.split(',').map(c => c.trim());
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

function validateCategories(pageCategoryList, pageInfo, categoryMap, logger) {
  let isValid = true;
  let adjustedCategories = new Set(pageCategoryList);

  pageCategoryList.forEach(category => {
    // Check if the current category is a subcategory
    if (categoryMap.subcategories.has(category)) {
      // Retrieve the parent category for the current subcategory
      const parentCategory = categoryMap.parentMap.get(category);

      // Check if the parent category is not already in the pageCategoryList
      if (!adjustedCategories.has(parentCategory)) {
        // Add the parent category since it's missing
        adjustedCategories.add(parentCategory);
        logger.debug(`Added missing parent category '${parentCategory}' for subcategory '${category}' in ${pageInfo}`);
      }
    }
    // Check if the current category is not a valid category or subcategory
    else if (!categoryMap.categories.has(category)) {
      logger.warn(`Invalid category '${category}' in ${pageInfo}`);
      adjustedCategories.delete(category)
      isValid = false;
    }
  });

  if (!isValid) {
      logger.warn(`Invalid categories detected. For a list of valid categories, see https://github.com/redpanda-data/docs/tree/shared/modules/ROOT/partials/valid-categories.yml`);
  }
  return Array.from(adjustedCategories).join(', ');
}

function createCategoryMap(validCategories) {
  const categoryMap = {
    categories: new Set(),
    subcategories: new Set(),
    parentMap: new Map()
  };

  validCategories.forEach(categoryInfo => {
    categoryMap.categories.add(categoryInfo.category);
    if (categoryInfo.subcategories) {
      categoryInfo.subcategories.forEach(subcat => {
        categoryMap.subcategories.add(subcat.category);
        categoryMap.parentMap.set(subcat.category, categoryInfo.category);
      });
    }
  });
  return categoryMap
}