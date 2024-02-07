'use strict';

module.exports.register = function ({ config }) {
  const logger = this.getLogger('related-docs-extension');

  this.on('documentsConverted', async ({ contentCatalog, siteCatalog }) => {
    const labs = contentCatalog.findBy({ component: 'redpanda-labs', family: 'page' });
    labs.forEach((labPage) => {
      const relatedDocs = []
      const relatedLabs = []
      const sourceAttributes = labPage.asciidoc.attributes
      const pageCategories = sourceAttributes['page-categories'];
      if (!pageCategories) return;
      const sourceCategoryList = pageCategories.split(',').map(c => c.trim());
      const sourceDeploymentType = getDeploymentType(sourceAttributes)
      const docs = contentCatalog.findBy({ component: 'ROOT', family: 'page' });
      docs.forEach((docPage) => {
        const related = findRelated(docPage, sourceCategoryList, sourceDeploymentType, logger)
        related && relatedDocs.push(related)
      })
      labs.forEach((targetLabPage) => {
        if (targetLabPage === labPage) return;

        const related = findRelated(targetLabPage, sourceCategoryList, sourceDeploymentType, logger);
        if (related) relatedLabs.push(related);
      });

      // Store related docs and labs in the lab page attributes
      if (relatedDocs.length > 0) {
        labPage.asciidoc.attributes['page-related-docs'] = JSON.stringify(relatedDocs);
      }

      if (relatedLabs.length > 0) {
        labPage.asciidoc.attributes['page-related-labs'] = JSON.stringify(relatedLabs);
      }

      if (relatedDocs.length > 0 || relatedLabs.length > 0) {
        logger.info(`Set related docs and labs attributes for ${labPage.asciidoc.doctitle}`);
      }
    })
  })
}

function findRelated(docPage, sourceCategoryList, sourceDeploymentType, logger) {
  const targetAttributes = docPage.asciidoc.attributes
  const pageCategories = targetAttributes['page-categories'];
  if (!pageCategories) return null;
  const targetCategoryList = pageCategories.split(',').map(c => c.trim());
  const targetDeploymentType = getDeploymentType(targetAttributes)
  const categoryMatch = hasMatchingCategory(sourceCategoryList, targetCategoryList)
  if (categoryMatch && (!targetDeploymentType ||sourceDeploymentType === targetDeploymentType)) {
    return {
      title: docPage.asciidoc.doctitle,
      url: docPage.pub.url,
    }
  }
  return null
}

function getDeploymentType (attributes) {
  return attributes['env-kubernetes'] ? 'Kubernetes'
    : attributes['env-linux'] ? 'Linux'
      : attributes['env-docker'] ? 'Docker'
        : attributes.cloud ? 'Redpanda Cloud' : ''
}

function hasMatchingCategory (sourcePageCategories, targetPageCategories) {
  return sourcePageCategories.every((category) => targetPageCategories.includes(category))
}