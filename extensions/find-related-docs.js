'use strict';

module.exports.register = function ({ config }) {
  const logger = this.getLogger('related-docs-extension');

  this.on('documentsConverted', async ({ contentCatalog, siteCatalog }) => {
    // Find the latest version of each component
    const latestVersions = {};
    contentCatalog.getComponents().forEach(component => {
      latestVersions[component.name] = component.latest.version;
    });

    // Retrieve all documents and labs from the latest versions of each component
    const allDocs = [];
    const allLabs = contentCatalog.findBy({ component: 'redpanda-labs', family: 'page', version: latestVersions['redpanda-labs'] });

    Object.keys(latestVersions).forEach(component => {
      if (component === 'redpanda-labs') return;
      allDocs.push(...contentCatalog.findBy({ component, family: 'page', version: latestVersions[component] }));
    });
    allLabs.forEach((labPage) => {
      const relatedDocs = new Set();
      const relatedLabs = new Set();
      const sourceAttributes = labPage.asciidoc.attributes;
      const pageCategories = sourceAttributes['page-categories'];
      if (!pageCategories) return;
      const sourceCategoryList = pageCategories.split(',').map(c => c.trim());
      const sourceDeploymentType = getDeploymentType(sourceAttributes);
      const docs = contentCatalog.findBy({ component: 'ROOT', family: 'page', version: latestVersions['ROOT'] });

      allDocs.forEach((docPage) => {
        const related = findRelated(docPage, sourceCategoryList, sourceDeploymentType, logger);
        if (related) relatedDocs.add(JSON.stringify(related));
      });

      allLabs.forEach((targetLabPage) => {
        if (targetLabPage === labPage) return;

        const related = findRelated(targetLabPage, sourceCategoryList, sourceDeploymentType, logger);
        if (related) relatedLabs.add(JSON.stringify(related));
      });

      // Convert Sets back to arrays and remove duplicates
      const uniqueRelatedDocs = Array.from(relatedDocs).map(item => JSON.parse(item));
      const uniqueRelatedLabs = Array.from(relatedLabs).map(item => JSON.parse(item));

      // Store related docs and labs in the lab page attributes
      if (uniqueRelatedDocs.length > 0) {
        labPage.asciidoc.attributes['page-related-docs'] = JSON.stringify(uniqueRelatedDocs);
      }

      if (uniqueRelatedLabs.length > 0) {
        labPage.asciidoc.attributes['page-related-labs'] = JSON.stringify(uniqueRelatedLabs);
      }

      if (uniqueRelatedDocs.length > 0 || uniqueRelatedLabs.length > 0) {
        logger.info(`Set related docs and labs attributes for ${labPage.asciidoc.doctitle}`);
      }
    });
  });
};

function findRelated(docPage, sourceCategoryList, sourceDeploymentType, logger) {
  const targetAttributes = docPage.asciidoc.attributes;
  const pageCategories = targetAttributes['page-categories'];
  if (!pageCategories) return null;
  const targetCategoryList = pageCategories.split(',').map(c => c.trim());
  const targetDeploymentType = getDeploymentType(targetAttributes);
  const categoryMatch = hasMatchingCategory(sourceCategoryList, targetCategoryList);
  if (categoryMatch && (!targetDeploymentType || sourceDeploymentType === targetDeploymentType)) {
    return {
      title: docPage.asciidoc.doctitle,
      url: docPage.pub.url,
    };
  }
  return null;
}

function getDeploymentType(attributes) {
  return attributes['env-kubernetes'] ? 'Kubernetes'
    : attributes['env-linux'] ? 'Linux'
      : attributes['env-docker'] ? 'Docker'
        : attributes.cloud ? 'Redpanda Cloud'
        : '';
}

function hasMatchingCategory(sourcePageCategories, targetPageCategories) {
  return sourcePageCategories.every(category => targetPageCategories.includes(category));
}
