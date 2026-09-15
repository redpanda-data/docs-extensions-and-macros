'use strict';

const { raiseListenerLimit } = require('./util/raise-listener-limit')

// Components with no nav.adoc by design. `api` and `labs` are the historical
// defaults; `solutions` derives its navigation from page-solution-steps (see
// solutions-catalog) and is always skipped, whatever the config says.
const DEFAULT_SKIP_COMPONENTS = ['api', 'labs'];
const ALWAYS_SKIP_COMPONENTS = ['solutions'];

/**
 * Resolve the `skip_components` option. Antora camelCases playbook keys, so
 * both `skipComponents` and `skip_components` are accepted.
 */
function resolveSkipComponents(config = {}) {
  const raw = config.skipComponents !== undefined ? config.skipComponents : config.skip_components;
  let list;
  if (raw === undefined || raw === null) list = DEFAULT_SKIP_COMPONENTS;
  else if (Array.isArray(raw)) list = raw;
  else list = String(raw).split(',');
  return new Set([...list.map((c) => String(c).trim()).filter(Boolean), ...ALWAYS_SKIP_COMPONENTS]);
}

module.exports.register = function ({ config }) {
  raiseListenerLimit(this)
  const { addToNavigation, unlistedPagesHeading = 'Unlisted Pages' } = config;
  const logger = this.getLogger('unlisted-pages-extension');
  const skipComponents = resolveSkipComponents(config);

  this.on('navigationBuilt', ({ siteCatalog, contentCatalog }) => {
    contentCatalog.getComponents().forEach(({ versions }) => {
      versions.forEach(({ name: component, version, navigation: nav, url: defaultUrl }) => {
        if (skipComponents.has(component)) return;
        if (!nav) return;

        const navEntriesByUrl = getNavEntriesByUrl(nav);
        const unlistedPages = contentCatalog
          .findBy({ component, version, family: 'page' })
          .reduce((collector, page) => {
            if (siteCatalog.unpublishedPages?.includes(page.pub.url)) {
              logger.info({ file: page.src, source: page.src.origin }, 'removing unpublished page from nav tree');
              removePageFromNav(nav, page.pub.url); // Remove the page from navigationCatalog
              return collector; // Skip adding this page to the collector
            }

            // Skip field-only pages (generated for includes, not standalone navigation)
            if (page.isFieldOnlyPage) return collector;

            // Skip technical pages that are intentionally unlisted (e.g., llms.txt, sitemap)
            const technicalPages = ['llms', 'sitemap', 'sitemap-llms'];
            if (technicalPages.includes(page.src.stem)) return collector;

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

module.exports.resolveSkipComponents = resolveSkipComponents
module.exports.DEFAULT_SKIP_COMPONENTS = DEFAULT_SKIP_COMPONENTS
module.exports.ALWAYS_SKIP_COMPONENTS = ALWAYS_SKIP_COMPONENTS
