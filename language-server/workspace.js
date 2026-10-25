'use strict'

/**
 * The build data the docs language server checks pages against, loaded from
 * the files on disk with the build's own loaders:
 *
 *   property data  macros/prop.js loadPropertiesFor, the function prop: and
 *                  propval: call during a build. It takes an Antora content
 *                  catalog, so this module builds a minimal one from the
 *                  workspace: the component's antora.yml (name, version,
 *                  asciidoc attributes such as env-cloud) and its
 *                  modules/<module>/attachments files. Dataset selection by
 *                  release series, Cloud lending and the corrupt-file
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
const yaml = require('js-yaml')
const { loadPropertiesFor } = require('../macros/prop')
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

/** One component version as Antora describes it: name, version and asciidoc attributes. */
function readComponentDescriptor (root) {
  const data = yaml.load(fs.readFileSync(path.join(root, 'antora.yml'), 'utf8')) || {}
  // version: ~ (null) is Antora's unversioned component, whose version is ''.
  const version = data.version === null || data.version === undefined || data.version === '~' ? '' : String(data.version)
  const attributes = (data.asciidoc && data.asciidoc.attributes) || {}
  return { name: String(data.name || ''), version, attributes, root }
}

/** The attachment files of a component, as content catalog entries. */
function attachmentsOf (descriptor) {
  const modulesDir = path.join(descriptor.root, 'modules')
  if (!fs.existsSync(modulesDir)) return []
  const out = []
  for (const mod of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (!mod.isDirectory()) continue
    const dir = path.join(modulesDir, mod.name, 'attachments')
    if (!fs.existsSync(dir)) continue
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const abs = path.join(current, entry.name)
        if (entry.isDirectory()) walk(abs)
        else if (entry.isFile()) out.push({ abs, module: mod.name, relative: path.relative(dir, abs).split(path.sep).join('/') })
      }
    }
    walk(dir)
  }
  return out.map(({ abs, module, relative }) => {
    const file = {
      src: { component: descriptor.name, version: descriptor.version, module, family: 'attachment', relative, abspath: abs },
    }
    // Read lazily: only the property JSON is ever opened.
    Object.defineProperty(file, 'contents', { get: () => fs.readFileSync(abs), enumerable: true })
    return file
  })
}

/**
 * A minimal Antora content catalog over component checkouts on disk: enough
 * of findBy and getComponent for loadPropertiesFor.
 *
 * @param {Array<{name: string, version: string, attributes: Object, root: string}>} descriptors
 */
function createContentCatalog (descriptors) {
  const files = descriptors.flatMap(attachmentsOf)
  const components = new Map()
  for (const d of descriptors) {
    if (!components.has(d.name)) components.set(d.name, { name: d.name, versions: [] })
    components.get(d.name).versions.push({ version: d.version, asciidoc: { attributes: d.attributes } })
  }
  for (const c of components.values()) c.latest = c.versions[0]
  return {
    findBy (criteria = {}) {
      return files.filter((f) => Object.entries(criteria).every(([key, value]) => f.src[key] === value))
    },
    getComponent (name) {
      return components.get(name)
    },
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
  const component = readComponentDescriptor(root)
  const descriptors = [component]
  const notes = []
  const docsPath = env.REDPANDA_DOCS_PATH ? path.resolve(env.REDPANDA_DOCS_PATH) : null
  if (docsPath && docsPath !== path.resolve(root) && fs.existsSync(path.join(docsPath, 'antora.yml'))) {
    const lender = readComponentDescriptor(docsPath)
    if (lender.name !== component.name) descriptors.push(lender)
  }
  const contentCatalog = createContentCatalog(descriptors)

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

module.exports = { findComponentRoot, readComponentDescriptor, createContentCatalog, loadWorkspace }
