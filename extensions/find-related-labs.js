'use strict';

const { raiseListenerLimit } = require('./util/raise-listener-limit')
const { getDeploymentType } = require('../extension-utils/deployment-type')

module.exports.register = function ({ config }) {
  raiseListenerLimit(this)
  const logger = this.getLogger('related-labs-extension');

  this.on('documentsConverted', async ({ contentCatalog, siteCatalog }) => {
    // Labs are being replaced by solutions. The solutions-catalog extension
    // computes page-related-solutions with scored, explainable edges; this
    // extension goes away in the next major version.
    logger.warn('find-related-labs is deprecated and will be removed in 6.0. Use solutions-catalog (page-related-solutions) instead.');
    const docs = contentCatalog.findBy({ family: 'page' });
    docs.forEach((docPage) => {
      const relatedLabs = []
      const sourceAttributes = docPage.asciidoc.attributes
      const pageCategories = sourceAttributes['page-categories'];
      if (!pageCategories) return;
      const sourceCategoryList = pageCategories.split(',').map(c => c.trim());
      const sourceDeploymentType = getDeploymentType(sourceAttributes)
      const labs = contentCatalog.findBy({ component: 'labs', family: 'page' });
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