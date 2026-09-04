/* Publishes the Kapa source-group mapping to the UI as an AsciiDoc attribute.
 *
 * Example use in the playbook:
 *   antora:
 *     extensions:
 *       - require: '@redpanda-data/docs-extensions-and-macros/extensions/kapa-source-groups'
 *
 * WHY THIS EXISTS
 * ---------------
 * docs-ui's get-kapa-source-groups helper needs to turn the page's version
 * segment into a Kapa source group id, so Ask AI retrieval is scoped to the docs
 * version the reader is actually on (DOC-1807, DOC-2450). docs-ui does not depend
 * on this package and must not carry a second copy of the mapping, which would
 * drift silently. So the mapping travels as an attribute: generated here by
 * `doc-tools generate kapa-source-groups`, committed to docs-data, and merged
 * onto every component version at build time.
 *
 * Set on every component version rather than only the versioned ones, because the
 * helper needs the mapping on unversioned pages too. Those resolve to the
 * mapping's default_segment, and sending no filter there is exactly what caused
 * DOC-2450: the reporter was on a page with no version of its own.
 *
 * DEGRADATION
 * -----------
 * Every failure sets nothing and warns. The helper treats a missing attribute as
 * "send no source group", which is the pre-DOC-2450 behaviour of searching every
 * version. That is the right way to fail: a wrong group is worse than no group,
 * because scoping to a group that does not hold the reader's version returns only
 * Kapa's global sources, silently and with no error.
 */

const fs = require('fs')
const path = require('path')

const ATTRIBUTE_NAME = 'kapa-source-groups'
const DEFAULT_MAPPING_PATH = path.join(__dirname, '..', 'docs-data', 'kapa-source-groups.json')

/**
 * Validate the shape the helper depends on, so a malformed mapping is caught at
 * build time with a named reason rather than producing pages that quietly lose
 * version scoping.
 *
 * @param {*} mapping
 * @returns {string|null} Reason it is unusable, or null when it is fine
 */
function validateMapping (mapping) {
  if (!mapping || typeof mapping !== 'object') return 'not an object'
  if (!mapping.segments || typeof mapping.segments !== 'object') return 'no segments object'
  const segments = Object.keys(mapping.segments)
  if (segments.length === 0) return 'segments is empty'
  if (!mapping.default_segment) return 'no default_segment'
  if (!mapping.segments[mapping.default_segment]) {
    // The helper falls back to default_segment for every unversioned page, so a
    // dangling default silently disables scoping across most of the site.
    return `default_segment "${mapping.default_segment}" is not one of the segments (${segments.join(', ')})`
  }
  const missing = segments.filter((s) => !mapping.segments[s] || !mapping.segments[s].group_id)
  if (missing.length) return `segments missing group_id: ${missing.join(', ')}`
  return null
}

module.exports.register = function ({ config = {} } = {}) {
  const logger = this.getLogger('kapa-source-groups-extension')
  const mappingPath = config.mapping_file ? path.resolve(config.mapping_file) : DEFAULT_MAPPING_PATH

  this.on('contentClassified', async ({ contentCatalog }) => {
    let mapping
    try {
      if (!fs.existsSync(mappingPath)) {
        logger.warn(
          `Kapa source-group mapping not found at ${mappingPath}. Ask AI will search every docs version. ` +
          'Generate it with: doc-tools generate kapa-source-groups'
        )
        return
      }
      mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'))
    } catch (err) {
      logger.warn(`Could not read the Kapa source-group mapping at ${mappingPath}: ${err.message}. Ask AI will search every docs version.`)
      return
    }

    const problem = validateMapping(mapping)
    if (problem) {
      logger.warn(`Kapa source-group mapping at ${mappingPath} is unusable (${problem}). Ask AI will search every docs version.`)
      return
    }

    // Serialised once. The helper accepts a string or an object, but a string is
    // what survives Antora's attribute handling unchanged, and it keeps the
    // attribute value comparable between builds.
    const serialised = JSON.stringify(mapping)

    let versions = 0
    const components = await contentCatalog.getComponents()
    for (const component of components) {
      component.versions.forEach(({ asciidoc }) => {
        if (!asciidoc) return
        asciidoc.attributes = asciidoc.attributes || {}
        // Do not clobber an explicit override: a playbook or antora.yml that
        // already sets this wins, matching how add-global-attributes.js lets
        // component attributes beat the shared file.
        if (asciidoc.attributes[ATTRIBUTE_NAME] === undefined) {
          asciidoc.attributes[ATTRIBUTE_NAME] = serialised
        }
        versions += 1
      })
    }

    logger.info(
      `Kapa source groups: set ${ATTRIBUTE_NAME} on ${versions} component version(s); ` +
      `${Object.keys(mapping.segments).length} version segments, default "${mapping.default_segment}".`
    )
  })
}

module.exports.validateMapping = validateMapping
module.exports.ATTRIBUTE_NAME = ATTRIBUTE_NAME
module.exports.DEFAULT_MAPPING_PATH = DEFAULT_MAPPING_PATH
