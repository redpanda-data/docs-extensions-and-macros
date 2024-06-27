'use strict';

module.exports.register = function ({ config }) {
  const { addToNavigation, unlistedPagesHeading = 'Unlisted Pages' } = config;
  const logger = this.getLogger('unlisted-pages-extension');

  this.on('navigationBuilt', ({ siteCatalog, contentCatalog }) => {
    contentCatalog.getComponents().forEach(({ versions }) => {
      versions.forEach(({ name: component, version, navigation: nav, url: defaultUrl }) => {
        if (component === 'api') return;
        if (!nav) return;
        const currentComponent = contentCatalog.getComponent(component);
        const prerelease = currentComponent && currentComponent.latestPrerelease ? currentComponent.latestPrerelease : false;

        const navEntriesByUrl = getNavEntriesByUrl(nav);
        const unlistedPages = contentCatalog
          .findBy({ component, version, family: 'page' })
          .reduce((collector, page) => {
            if (siteCatalog.unpublishedPages?.includes(page.pub.url)) {
              logger.info({ file: page.src, source: page.src.origin }, 'removing unpublished page from nav tree');
              removePageFromNav(nav, page.pub.url); // Remove the page from navigationCatalog
              return collector; // Skip adding this page to the collector
            }

            if (!(page.pub.url in navEntriesByUrl) && page.pub.url !== defaultUrl) {
              logger.warn({ file: page.src, source: page.src.origin }, 'detected unlisted page');
              return collector.concat(page);
            }

            return collector;
          }, []);

        if (unlistedPages.length && addToNavigation) {
          nav.push({
            content: unlistedPagesHeading,
            items: unlistedPages.map((page) => {
              return { content: page.asciidoc.navtitle, url: page.pub.url, urlType: 'internal' };
            }),
            root: true,
          });
        }
      });
    });
  });
};

function getNavEntriesByUrl(items = [], accum = {}) {
  items.forEach((item) => {
    if (item.urlType === 'internal') accum[item.url.split('#')[0]] = item;
    getNavEntriesByUrl(item.items, accum);
  });
  return accum;
}

function removePageFromNav(navItems, urlToRemove) {
  // Remove the page from the navigation items
  for (let i = navItems.length - 1; i >= 0; i--) {
    const item = navItems[i];
    if (item.url === urlToRemove) {
      navItems.splice(i, 1);
    } else if (item.items && item.items.length > 0) {
      removePageFromNav(item.items, urlToRemove);
    }
  }
}
