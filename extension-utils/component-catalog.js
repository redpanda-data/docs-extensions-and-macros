'use strict'

/* A minimal Antora content catalog read from component checkouts on disk,
 * for code that runs outside an Antora build but must pick property data
 * exactly as the build does: migrate-property-values and the docs language
 * server both pass it to loadPropertiesFor in macros/prop.js.
 */

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const { PROPERTIES_JSON_RX } = require('../macros/prop')

/**
 * Read an Antora component descriptor and its property attachments into the
 * file shapes loadPropertiesFor reads from a content catalog.
 */
function readComponent (repoDir) {
  const descriptor = yaml.load(fs.readFileSync(path.join(repoDir, 'antora.yml'), 'utf8')) || {}
  const component = String(descriptor.name || '')
  const version = descriptor.version === null || descriptor.version === undefined ? '' : String(descriptor.version)
  const attributes = (descriptor.asciidoc && descriptor.asciidoc.attributes) || {}
  const dir = path.join(repoDir, 'modules', 'reference', 'attachments')
  const files = []
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!PROPERTIES_JSON_RX.test(name)) continue
      files.push({
        src: { component, version, module: 'reference', family: 'attachment', relative: name },
        contents: fs.readFileSync(path.join(dir, name)),
      })
    }
  }
  return { component, version, attributes, files }
}

/**
 * A minimal content catalog over one or more component checkouts, enough for
 * loadPropertiesFor to select a dataset exactly as it does in an Antora build.
 */
function catalogFor (components) {
  const files = components.flatMap((c) => c.files)
  return {
    findBy: (query) => files.filter((file) => Object.entries(query).every(([key, value]) => file.src[key] === value)),
    getComponent: (name) => {
      const own = components.filter((c) => c.component === name)
      if (!own.length) return undefined
      const versions = own.map((c) => ({ version: c.version, asciidoc: { attributes: c.attributes } }))
      return { name, versions, latest: versions[0] }
    },
  }
}

module.exports = { readComponent, catalogFor }
