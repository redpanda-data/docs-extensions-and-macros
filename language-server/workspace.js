'use strict'

/**
 * The build data the docs language server checks pages against, loaded from
 * the files on disk with the build's own loaders:
 *
 *   property data  macros/prop.js loadPropertiesFor, the function prop: and
 *                  propval: call during a build, over the minimal content
 *                  catalog that migrate-property-values also uses
 *                  (extension-utils/component-catalog.js): the component's
 *                  antora.yml (name, version, asciidoc attributes such as
 *                  env-cloud) and its property attachments. Dataset selection
 *                  by release series, Cloud lending and the corrupt-file
 *                  fallback are therefore exactly the build's.
 *   taxonomy       extension-utils/taxonomy.js loadTaxonomyFrom, the loader
 *                  `doc-tools check-metadata` uses: the workspace's
 *                  shared/modules/ROOT/attachments/taxonomy.yml, then
 *                  $REDPANDA_DOCS_PATH, then the published file.
 *   legacy list    tools/check-metadata loadLegacyCategories
 *                  (valid-categories.yml), when the workspace has it.
 *
 * A Cloud component has no property data of its own and borrows the newest
 * streaming file, as in the build. Outside a combined build that file is
 * found through $REDPANDA_DOCS_PATH, a local checkout of the docs repo, which
 * is read as the streaming component.
 */

const fs = require('fs')
const path = require('path')
const { loadPropertiesFor } = require('../macros/prop')
const { readComponent, catalogFor } = require('../extension-utils/component-catalog')
const { loadTaxonomyFrom } = require('../extension-utils/taxonomy')
const { loadLegacyCategories } = require('../tools/check-metadata')

/** The nearest directory at or above `start` that holds an antora.yml. */
function findComponentRoot (start) {
  let dir = path.resolve(start)
  try {
    if (fs.statSync(dir).isFile()) dir = path.dirname(dir)
  } catch {
    dir = path.dirname(dir)
  }
  for (;;) {
    if (fs.existsSync(path.join(dir, 'antora.yml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Everything the server needs for the pages under one component root.
 *
 * @param {string} root - directory holding antora.yml
 * @param {Object} [options]
 * @param {Object} [options.env=process.env]
 * @param {Function} [options.fetch=globalThis.fetch] - for the published taxonomy
 * @returns {Promise<Object>}
 */
async function loadWorkspace (root, { env = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
  const own = readComponent(root)
  const component = { name: own.component, version: own.version, attributes: own.attributes }
  const components = [own]
  const notes = []
  const docsPath = env.REDPANDA_DOCS_PATH ? path.resolve(env.REDPANDA_DOCS_PATH) : null
  if (docsPath && docsPath !== path.resolve(root) && fs.existsSync(path.join(docsPath, 'antora.yml'))) {
    const lender = readComponent(docsPath)
    if (lender.component !== own.component) components.push(lender)
  }
  const contentCatalog = catalogFor(components)

  let properties = null
  try {
    properties = loadPropertiesFor(contentCatalog, component.name, component.version) || null
  } catch (err) {
    notes.push(`property data could not be loaded: ${err.message}`)
  }
  if (!properties) notes.push(`no property data for ${component.name}@${component.version || 'unversioned'}; prop: and propval: are not checked`)

  let taxonomy = null
  let taxonomySource = null
  try {
    const loaded = await loadTaxonomyFrom({ root, env, fetch: fetchImpl })
    taxonomy = loaded.taxonomy
    taxonomySource = loaded.source
    notes.push(...loaded.warnings)
  } catch (err) {
    notes.push(`taxonomy not loaded, so :page-categories: is not checked: ${err.message}`)
  }

  return {
    root,
    component,
    properties,
    taxonomy,
    taxonomySource,
    isLegacyCategory: loadLegacyCategories(root) || undefined,
    notes,
  }
}

module.exports = { findComponentRoot, loadWorkspace }
