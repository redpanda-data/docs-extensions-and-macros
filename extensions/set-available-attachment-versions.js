'use strict'

const { raiseListenerLimit } = require('./util/raise-listener-limit')

const semver = require('semver')

/**
 * Points UI templates at generated JSON attachments that actually exist.
 *
 * The docs-ui head-meta partial builds <meta name="properties-json-url"> and
 * <meta name="connect-json-url"> tags from version attributes such as
 * latest-redpanda-tag and latest-connect-version. Those attributes track the
 * newest GitHub release, which can be ahead of the newest generated JSON in
 * the content catalog. When that happens the template's production fallback
 * URL points at a file that does not exist, and every page view requests a
 * guaranteed 404.
 *
 * This extension scans the catalog on contentClassified and sets, per
 * component version:
 *
 * - available-properties-tag: newest redpanda-properties-<tag>.json attachment
 *   in the reference module of each streaming (ROOT) component version
 * - available-connect-version: newest connect-<version>.json attachment in the
 *   components module of the connect component
 * - page-disable-property-tooltips: 'true' on streaming versions that have no
 *   properties JSON at all, so browsers never request a URL that cannot exist
 *
 * Attributes already set (for example, pinned in antora.yml) are never
 * overwritten.
 */

// Components known to publish Redpanda property data. Any other component that
// ships a redpanda-properties-<tag>.json attachment is picked up too: the docs
// UI resolves the tooltip dataset against the page's own component when that
// component declares available-properties-tag, so a component publishing its
// own data must get the attribute or its tooltips fall back to streaming's and
// describe different properties from the ones its pages document.
const PROPERTIES_COMPONENTS = ['ROOT', 'streaming']
const CONNECT_COMPONENTS = ['connect', 'redpanda-connect']

const PROPERTIES_JSON_RX = /^redpanda-properties-(v\d+\.\d+\.\d+(?:-[\w.]+)?)\.json$/
const CONNECT_JSON_RX = /^connect-(\d+\.\d+\.\d+(?:-[\w.]+)?)\.json$/

module.exports.register = function () {
  raiseListenerLimit(this)
  const logger = this.getLogger('set-available-attachment-versions-extension')

  this.once('contentClassified', ({ contentCatalog }) => {
    contentCatalog.getComponents().forEach((component) => {
      const publishesProperties = (contentCatalog.findBy({ component: component.name, family: 'attachment' }) || [])
        .some((file) => file.src.module === 'reference' && PROPERTIES_JSON_RX.test(file.src.relative.split('/').pop()))
      const isProperties = PROPERTIES_COMPONENTS.includes(component.name) || publishesProperties
      const isConnect = CONNECT_COMPONENTS.includes(component.name)
      if (!isProperties && !isConnect) return

      component.versions.forEach((compVer) => {
        const attributes = ((compVer.asciidoc = compVer.asciidoc || {}).attributes =
          compVer.asciidoc.attributes || {})
        const attachments = contentCatalog.findBy({
          component: component.name,
          version: compVer.version,
          family: 'attachment',
        })

        if (isProperties) {
          const newest = findNewestVersion(attachments, 'reference', PROPERTIES_JSON_RX)
          if (newest) {
            if (!attributes['available-properties-tag']) {
              attributes['available-properties-tag'] = newest
              logger.info(
                `Set available-properties-tag=${newest} for ${component.name}@${compVer.version}`
              )
            }
          } else if (attributes['latest-redpanda-tag'] && !attributes['available-properties-tag']) {
            // Tooltips would request a JSON that does not exist for this version
            if (!attributes['page-disable-property-tooltips']) {
              attributes['page-disable-property-tooltips'] = 'true'
              logger.info(
                `No properties JSON found for ${component.name}@${compVer.version}; disabling property tooltips`
              )
            }
          }
        }

        if (isConnect) {
          const newest = findNewestVersion(attachments, 'components', CONNECT_JSON_RX)
          if (newest && !attributes['available-connect-version']) {
            attributes['available-connect-version'] = newest
            logger.info(
              `Set available-connect-version=${newest} for ${component.name}@${compVer.version}`
            )
          }
        }
      })
    })
  })
}

function findNewestVersion (attachments, module, rx) {
  let newestRaw = null
  let newestSemver = null
  attachments.forEach((attachment) => {
    if (attachment.src.module !== module) return
    const basename = attachment.src.relative.split('/').pop()
    const match = basename.match(rx)
    if (!match) return
    const raw = match[1]
    const parsed = semver.coerce(raw, { includePrerelease: true })
    if (!parsed) return
    if (!newestSemver || semver.gt(parsed, newestSemver)) {
      newestSemver = parsed
      newestRaw = raw
    }
  })
  return newestRaw
}
