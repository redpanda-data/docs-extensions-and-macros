'use strict';

module.exports.register = function () {
  const logger = this.getLogger('unpublish-pages-extension');

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

      // Debug logging for ANY page with publish-only-during-beta attribute
      if (page.asciidoc?.attributes['publish-only-during-beta']) {
        logger.debug(`Found page with publish-only-during-beta: ${page.src?.relative || page.pub?.url}`);
        logger.debug(`  - publish-only-during-beta: ${page.asciidoc?.attributes['publish-only-during-beta']}`);
        logger.debug(`  - page-component-version-is-prerelease: ${page.asciidoc?.attributes['page-component-version-is-prerelease']}`);
        logger.debug(`  - page-unpublish: ${page.asciidoc?.attributes['page-unpublish']}`);
        logger.debug(`  - component: ${componentName}, version: ${pageVersion}`);
      }

      // Check the conditions for unpublishing the page
      const shouldUnpublish = (
        page.asciidoc?.attributes['page-unpublish'] ||
        (page.asciidoc?.attributes['publish-only-during-beta']
        && !page.asciidoc?.attributes['page-component-version-is-prerelease'] // Not part of a beta version, meaning the beta period has ended
      )
      );

      // Unpublish the shouldUnpublish pages
      if (shouldUnpublish) {
        logger.info(`Unpublishing page: ${page.src?.relative || page.pub?.url}`);
        siteCatalog.unpublishedPages.push(page.pub.url)
        delete page.out;
      }
    });
  });
};
