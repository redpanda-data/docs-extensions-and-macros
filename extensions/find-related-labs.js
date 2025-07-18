'use strict';

module.exports.register = function ({ config }) {
  const logger = this.getLogger('related-labs-extension');

  this.on('documentsConverted', async ({ contentCatalog, siteCatalog }) => {
    const docs = contentCatalog.findBy({ family: 'page' });
    docs.forEach((docPage) => {
      const relatedLabs = []
      const sourceAttributes = docPage.asciidoc.attributes
      const pageCategories = sourceAttributes['page-categories'];
      if (!pageCategories) return;
      const sourceCategoryList = pageCategories.split(',').map(c => c.trim());
      const sourceDeploymentType = getDeploymentType(sourceAttributes)
      const labs = contentCatalog.findBy({ component: 'redpanda-labs', family: 'page' });
      labs.forEach((labPage) => {
        const related = findRelated(labPage, sourceCategoryList, sourceDeploymentType, logger)
        related && relatedLabs.push(related)
      })
      if (!relatedLabs.length) return
      docPage.asciidoc.attributes['page-related-labs'] = JSON.stringify(relatedLabs)
      logger.debug(`Set page-related-labs attribute for ${docPage.asciidoc.doctitle} to ${docPage.asciidoc.attributes['page-related-labs']}`)
    })
  })
}

function findRelated(labPage, sourceCategoryList, sourceDeploymentType, logger) {
  const targetAttributes = labPage.asciidoc.attributes
  const pageCategories = targetAttributes['page-categories'];
  if (!pageCategories) return null;
  const targetCategoryList = pageCategories.split(',').map(c => c.trim());
  const targetDeploymentType = getDeploymentType(targetAttributes)
  const categoryMatch = hasMatchingCategory(sourceCategoryList, targetCategoryList)
  if (categoryMatch && isCompatibleDeployment(sourceDeploymentType, targetDeploymentType)) {
    return {
      title: labPage.asciidoc.doctitle,
      url: labPage.pub.url,
      description: labPage.asciidoc.attributes.description,
    }
  }
  return null
}

function getDeploymentType (attributes) {
  return attributes['env-kubernetes'] ? 'Kubernetes'
    : attributes['env-linux'] ? 'Linux'
      : attributes['env-docker'] ? 'Docker'
        : attributes['env-cloud'] ? 'Redpanda Cloud'
          : attributes['page-cloud'] ? 'Redpanda Cloud' : ''
}

function hasMatchingCategory (sourcePageCategories, targetPageCategories) {
  return sourcePageCategories.every((category) => targetPageCategories.includes(category))
}

function isCompatibleDeployment (sourceDeploymentType, targetDeploymentType) {
  // If no target deployment type specified, it's compatible with everything
  if (!targetDeploymentType) return true

  // Cloud pages show only cloud labs
  if (sourceDeploymentType === 'Redpanda Cloud') {
    return targetDeploymentType === 'Redpanda Cloud'
  }

  // All other cases (Kubernetes, Docker, Linux, or no deployment type) show Docker and Kubernetes
  if (targetDeploymentType === 'Docker' || targetDeploymentType === 'Kubernetes') {
    return true
  }

  return false
}