'use strict';

module.exports.register = function () {
  this.on('documentsConverted', ({ siteCatalog, contentCatalog }) => {
    // Get all pages that have an `out` property
    const pages = contentCatalog.getPages((page) => page.out);
    let componentName;
    siteCatalog.unpublishedPages = []

    // Iterate over each page
    pages.forEach((page) => {
      // Retrieve the component associated with the page
      componentName = page.asciidoc?.attributes['page-component-name'];
      const component = contentCatalog.getComponent(componentName);

      // Check if the component has a latest prerelease
      const prerelease = component ? component.latestPrerelease : null;

      // Check the conditions for unpublishing the page
      const shouldUnpublish = (
        page.asciidoc?.attributes['page-unpublish'] ||
        (page.asciidoc?.attributes['publish-only-during-beta']
        && !prerelease // No beta version available, meaning the beta period has ended
      )
      );

      // If any condition is met, unpublish the page
      if (shouldUnpublish) {
        siteCatalog.unpublishedPages.push(page.pub.url)
        delete page.out;
      }
    });
  });
};
