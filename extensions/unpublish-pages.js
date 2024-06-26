'use strict';

module.exports.register = function () {
  this.on('documentsConverted', ({ siteCatalog, contentCatalog }) => {
    // Get all pages that have an `out` property
    const pages = contentCatalog.getPages((page) => page.out);
    let componentName;
    let pageVersion;
    siteCatalog.unpublishedPages = []

    pages.forEach((page) => {
      // Retrieve the component metadata associated with the page
      componentName = page.asciidoc?.attributes['page-component-name'];
      pageVersion = page.asciidoc?.attributes['page-component-version'];
      const component = contentCatalog.getComponent(componentName);

      // Check if the page is part of the beta version
      const isPrerelease = component && pageVersion && component.latestPrerelease && component.latestPrerelease.version === pageVersion;

      // Check the conditions for unpublishing the page
      const shouldUnpublish = (
        page.asciidoc?.attributes['page-unpublish'] ||
        (page.asciidoc?.attributes['publish-only-during-beta']
        && !isPrerelease // No beta version available, meaning the beta period has ended
      )
      );

      // Unpublish the shouldUnpublish pages
      if (shouldUnpublish) {
        siteCatalog.unpublishedPages.push(page.pub.url)
        delete page.out;
      }
    });
  });
};
