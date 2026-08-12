'use strict'

/* Antora extension that warms the prop macro's property-page index before
 * document conversion starts.
 *
 * The prop macro discovers which reference page documents each property by
 * reading page sources for include:: lines and partials for property
 * headings. Antora replaces each page's contents with converted HTML as
 * conversion proceeds, so an index built lazily by the first macro call can
 * miss includes on pages that were converted earlier — the result silently
 * depends on conversion order. Building the index at contentClassified,
 * while every page still holds its AsciiDoc source, removes the ordering
 * hazard entirely. The macro finds the warmed cache and never rebuilds it.
 *
 * Register under antora.extensions (NOT asciidoc.extensions):
 *
 *   antora:
 *     extensions:
 *     - require: '@redpanda-data/docs-extensions-and-macros/extensions/property-page-index'
 */

const { buildPageIndex, loadPropertiesFor } = require('../macros/prop')

module.exports.register = function () {
  const logger = this.getLogger('property-page-index-extension')

  this.once('contentClassified', ({ contentCatalog }) => {
    let indexed = 0
    for (const component of contentCatalog.getComponents()) {
      for (const componentVersion of component.versions) {
        const registry = loadPropertiesFor(contentCatalog, component.name, componentVersion.version)
        if (!registry) continue
        const index = buildPageIndex(contentCatalog, component.name, registry.properties, componentVersion.version)
        if (index.size > 0) {
          indexed++
          logger.debug(`Indexed ${index.size} properties for ${component.name}@${componentVersion.version || 'default'}`)
        }
      }
    }
    if (indexed > 0) logger.info(`Property page index warmed for ${indexed} component version(s)`)
  })
}
