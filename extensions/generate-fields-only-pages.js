'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const handlebars = require('handlebars')

// Import and register Redpanda Connect helpers
const helpers = require('../tools/redpanda-connect/helpers')
Object.entries(helpers).forEach(([name, fn]) => {
  if (typeof fn === 'function') {
    handlebars.registerHelper(name, fn)
  }
})

// Default configuration
const DEFAULTS = {
  dataPath: null,   // Path to connector JSON data file (e.g., 'docs-data/connect-4.88.0.json')
  enabled: true     // Allow disabling the extension
}

module.exports.register = function ({ config }) {
  const logger = this.getLogger('generate-fields-only-pages-extension')

  // Merge config with defaults
  const {
    datapath = DEFAULTS.dataPath,           // Antora lowercases this
    enabled = DEFAULTS.enabled
  } = config || {}

  const dataPath = datapath

  if (!enabled) {
    logger.info('Extension disabled via config')
    return
  }

  // Load the connector data file
  if (!dataPath) {
    logger.warn('No dataPath configured. Skipping field-only page generation.')
    return
  }

  let connectorData
  try {
    const resolvedPath = path.resolve(dataPath)
    const rawData = fs.readFileSync(resolvedPath, 'utf8')
    connectorData = JSON.parse(rawData)
    logger.info(`Loaded connector data from ${resolvedPath}`)
  } catch (err) {
    logger.error(`Failed to load connector data from ${dataPath}: ${err.message}`)
    return
  }

  // Compile simple template for field-only pages
  const fieldOnlyTemplate = handlebars.compile('= {{name}} Fields\n\n{{{renderConnectFields children}}}')

  this.on('contentClassified', ({ contentCatalog, siteCatalog }) => {
    const component = contentCatalog.getComponent('redpanda-connect')
    if (!component) {
      logger.warn('redpanda-connect component not found. Skipping field-only page generation.')
      return
    }

    const componentVersion = component.latest
    if (!componentVersion) {
      logger.warn('No latest version found for redpanda-connect component.')
      return
    }

    let pagesGenerated = 0

    // Iterate over each type (inputs, outputs, processors, etc.)
    for (const [type, items] of Object.entries(connectorData)) {
      if (!Array.isArray(items)) continue

      // Skip bloblang functions/methods (they don't have config fields)
      if (type === 'bloblang-functions' || type === 'bloblang-methods') continue

      for (const item of items) {
        if (!item.name) continue

        // Only generate if there are fields
        const hasFields = (item.config && item.config.children && item.config.children.length > 0) ||
                         (item.children && item.children.length > 0)

        if (!hasFields) continue

        const fields = item.config?.children || item.children || []

        try {
          // Use Handlebars template to render content
          const content = fieldOnlyTemplate({
            name: item.name,
            children: fields
          })

          const typeDir = type.endsWith('s') ? type : `${type}s`
          const relative = `fields/${typeDir}/${item.name}.adoc`

          // Get origin from first existing page in component (for git metadata)
          const existingPages = contentCatalog.getPages((page) => page.src.component === 'redpanda-connect')
          const origin = existingPages.length > 0 ? existingPages[0].src.origin : { type: 'generated' }

          // Create a fake absolute path for generated files (used by logger)
          const fakeAbspath = path.join(os.tmpdir(), 'generated-fields-only', relative)

          // Create a stat object like real files have
          const contentBuffer = Buffer.from(content)
          const stat = Object.assign(new fs.Stats(), {
            mode: 0o100644,
            mtime: new Date(),
            size: contentBuffer.byteLength
          })

          // Create file spec with all required properties
          const file = contentCatalog.addFile({
            path: `modules/components/pages/${relative}`,
            contents: contentBuffer,
            stat: stat,
            src: {
              component: 'redpanda-connect',
              version: componentVersion.version,
              module: 'components',
              family: 'page',
              relative: relative,
              mediaType: 'text/asciidoc',
              origin: origin,
              abspath: fakeAbspath  // Needed by logger for error messages
            }
          })

          // Mark as field-only page (used by convert-to-markdown and add-llms-directive to skip directive)
          file.isFieldOnlyPage = true

          pagesGenerated++
        } catch (err) {
          logger.error(`Failed to generate field-only page for ${type}/${item.name}: ${err.message}`)
        }
      }
    }

    logger.info(`Generated ${pagesGenerated} field-only pages`)
  })
}
