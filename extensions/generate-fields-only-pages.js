'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

// Default configuration
const DEFAULTS = {
  format: 'nested', // 'nested' or 'table'
  headingLevel: 2,  // Starting heading level for nested format (2-6)
  dataPath: null,   // Path to connector JSON data file (e.g., 'docs-data/connect-4.88.0.json')
  enabled: true     // Allow disabling the extension
}

module.exports.register = function ({ config }) {
  const logger = this.getLogger('generate-fields-only-pages-extension')

  // Merge config with defaults
  // Note: Antora lowercases all config keys, so headingLevel becomes headinglevel
  const {
    format = DEFAULTS.format,
    headinglevel = DEFAULTS.headingLevel,  // Antora lowercases this
    datapath = DEFAULTS.dataPath,           // Antora lowercases this
    enabled = DEFAULTS.enabled
  } = config || {}

  const headingLevel = parseInt(headinglevel, 10)
  const dataPath = datapath

  if (!enabled) {
    logger.info('Extension disabled via config')
    return
  }

  // Validate format
  if (format !== 'nested' && format !== 'table') {
    logger.error(`Invalid format '${format}'. Must be 'nested' or 'table'. Disabling extension.`)
    return
  }

  // Validate headingLevel
  const level = parseInt(headingLevel, 10)
  if (isNaN(level) || level < 2 || level > 6) {
    logger.error(`Invalid headingLevel '${headingLevel}'. Must be between 2 and 6. Disabling extension.`)
    return
  }

  this.on('contentClassified', ({ contentCatalog, siteCatalog }) => {
    return generateFieldsOnlyPages(contentCatalog, siteCatalog, { format, headingLevel: level, dataPath, logger })
  })
}

async function generateFieldsOnlyPages (contentCatalog, siteCatalog, options) {
  const { format, headingLevel, dataPath, logger } = options

  if (!dataPath) {
    logger.warn('No dataPath specified in config. Skipping field-only page generation.')
    return
  }

  // Resolve dataPath relative to project root
  const resolvedDataPath = path.resolve(process.cwd(), dataPath)
  if (!fs.existsSync(resolvedDataPath)) {
    logger.error(`Data file not found at ${resolvedDataPath}. Skipping field-only page generation.`)
    return
  }

  // Load connector data
  let connectorData
  try {
    const rawData = fs.readFileSync(resolvedDataPath, 'utf8')
    connectorData = JSON.parse(rawData)
  } catch (err) {
    logger.error(`Failed to load/parse connector data from ${resolvedDataPath}: ${err.message}`)
    return
  }

  // Find the redpanda-connect component
  const component = contentCatalog.getComponents().find(c => c.name === 'redpanda-connect')
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
        const content = generateAsciiDocContent(item, fields, format, headingLevel, type)
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

        // Set page attributes for noindex and to skip llms.txt directive
        file.asciidoc = {
          attributes: {
            'page-noindex': '',
            'page-nofollow': '',
            'page-robots': 'noindex,nofollow',
            'page-nodirective': ''
          }
        }

        pagesGenerated++
      } catch (err) {
        logger.error(`Failed to generate field-only page for ${type}/${item.name}: ${err.message}`)
      }
    }
  }

  logger.info(`Generated ${pagesGenerated} field-only pages in ${format} format`)
}

function generateAsciiDocContent (item, fields, format, headingLevel, type) {
  const typeDir = type.endsWith('s') ? type : `${type}s`

  let content = `= ${item.name} Fields\n`
  content += `:page-noindex:\n`
  content += `:page-nofollow:\n`
  content += `:page-robots: noindex,nofollow\n\n`

  // AI directive
  content += `[NOTE]\n`
  content += `====\n`
  content += `*Note for AI Agents and LLMs*: This page contains only the field reference for the *${item.name}* ${type}.\n\n`
  content += `For complete documentation including examples, usage information, and context, please see the xref:components:${typeDir}:${item.name}.adoc[full ${item.name} documentation].\n\n`
  content += `*Do not use this fields-only page as your primary reference* -- it is intended for UX/API integration purposes only.\n`
  content += `====\n\n`

  if (format === 'table') {
    content += generateTableFormat(fields)
  } else {
    content += generateNestedFormat(fields, headingLevel)
  }

  return content
}

function generateTableFormat (fields, prefix = '') {
  let rows = []

  function collectFields (fieldsList, pathPrefix = '') {
    if (!Array.isArray(fieldsList)) return

    fieldsList.forEach(field => {
      if (field.is_deprecated || !field.name) return

      const isArray = field.kind === 'array'
      const nameWithArray = (typeof field.name === 'string' && isArray && !field.name.endsWith('[]'))
        ? `${field.name}[]`
        : field.name
      const currentPath = pathPrefix ? `${pathPrefix}.${nameWithArray}` : nameWithArray

      // Normalize type
      let displayType
      const isArrayTitle = typeof field.name === 'string' && field.name.endsWith('[]')
      if (isArrayTitle) {
        displayType = 'array<object>'
      } else if (field.type === 'string' && field.kind === 'array') {
        displayType = 'array'
      } else if (field.type === 'unknown' && field.kind === 'map') {
        displayType = 'object'
      } else if (field.type === 'unknown' && (field.kind === 'array' || field.kind === 'list')) {
        displayType = 'array'
      } else {
        displayType = field.type
      }

      // Format default value
      let defaultValue = ''
      if (field.default !== undefined) {
        if (Array.isArray(field.default) && field.default.length === 0) {
          defaultValue = '`[]`'
        } else if (
          field.default !== null &&
          typeof field.default === 'object' &&
          !Array.isArray(field.default) &&
          Object.keys(field.default).length === 0
        ) {
          defaultValue = '`{}`'
        } else if (typeof field.default === 'string') {
          defaultValue = `\`"${field.default}"\``
        } else if (typeof field.default === 'number' || typeof field.default === 'boolean') {
          defaultValue = `\`${field.default}\``
        } else if (field.default === null) {
          defaultValue = '`null`'
        } else {
          defaultValue = '_(complex)_'
        }
      }

      // Clean description for table
      let desc = (field.description || '').replace(/\n+/g, ' ').trim()
      if (desc.length > 100) {
        desc = desc.substring(0, 97) + '...'
      }

      rows.push({
        field: `\`${currentPath}\``,
        type: `\`${displayType}\``,
        default: defaultValue || '-',
        description: desc || '-'
      })

      // Recurse for children
      if (field.children && Array.isArray(field.children) && field.children.length > 0) {
        collectFields(field.children, currentPath)
      }
    })
  }

  collectFields(fields, prefix)

  if (rows.length === 0) return 'No configuration fields available.\n\n'

  let table = '[cols="2,1,1,4"]\n'
  table += '|===\n'
  table += '|Field |Type |Default |Description\n\n'

  rows.forEach(row => {
    table += `|${row.field}\n`
    table += `|${row.type}\n`
    table += `|${row.default}\n`
    table += `|${row.description}\n\n`
  })

  table += '|===\n'

  return table
}

function generateNestedFormat (fields, startLevel, prefix = '') {
  if (!Array.isArray(fields) || fields.length === 0) {
    return 'No configuration fields available.\n\n'
  }

  const sorted = [...fields].sort((a, b) => {
    const an = a.name || ''
    const bn = b.name || ''
    return an.localeCompare(bn, undefined, { sensitivity: 'base' })
  })

  let output = ''
  let currentLevel = startLevel

  function renderFields (fieldsList, level, pathPrefix = '') {
    fieldsList.forEach(field => {
      if (field.is_deprecated || !field.name) return

      const isArray = field.kind === 'array'
      const nameWithArray = (typeof field.name === 'string' && isArray && !field.name.endsWith('[]'))
        ? `${field.name}[]`
        : field.name
      const currentPath = pathPrefix ? `${pathPrefix}.${nameWithArray}` : nameWithArray

      // Create heading
      const headingLevel = Math.min(Math.max(level, 2), 6)
      const headingMarker = '='.repeat(headingLevel)
      output += `${headingMarker} \`${currentPath}\`\n\n`

      // Description
      let desc = field.description || ''
      if (field.is_beta) {
        desc = 'badge::[label=Beta, size=large, tooltip={page-beta-text}]\n\n' + desc.replace(/^\s*BETA:\s*/i, '')
      }

      if (desc) {
        output += `${desc}\n\n`
      }

      if (field.is_secret) {
        output += `WARNING: This field contains sensitive data. Do not expose this value in logs or unsecured locations.\n\n`
      }

      if (field.version) {
        output += `_Requires version ${field.version} or later._\n\n`
      }

      // Normalize type
      let displayType
      const isArrayTitle = typeof field.name === 'string' && field.name.endsWith('[]')
      if (isArrayTitle) {
        displayType = 'array<object>'
      } else if (field.type === 'string' && field.kind === 'array') {
        displayType = 'array'
      } else if (field.type === 'unknown' && field.kind === 'map') {
        displayType = 'object'
      } else if (field.type === 'unknown' && (field.kind === 'array' || field.kind === 'list')) {
        displayType = 'array'
      } else {
        displayType = field.type
      }

      output += `*Type*: \`${displayType}\`\n\n`

      // Default value
      if (field.default !== undefined) {
        if (Array.isArray(field.default) && field.default.length === 0) {
          output += `*Default*: \`[]\`\n\n`
        } else if (
          field.default !== null &&
          typeof field.default === 'object' &&
          !Array.isArray(field.default) &&
          Object.keys(field.default).length === 0
        ) {
          output += `*Default*: \`{}\`\n\n`
        } else if (typeof field.default === 'string') {
          output += `*Default*: \`"${field.default}"\`\n\n`
        } else if (typeof field.default === 'number' || typeof field.default === 'boolean') {
          output += `*Default*: \`${field.default}\`\n\n`
        } else if (field.default === null) {
          output += `*Default*: \`null\`\n\n`
        } else {
          // Complex default - use YAML block
          const yaml = require('yaml')
          try {
            const yamlStr = yaml.stringify(field.default).trim()
            output += `*Default*:\n\n[,yaml]\n----\n${yamlStr}\n----\n\n`
          } catch (err) {
            output += `*Default*: \`${JSON.stringify(field.default)}\`\n\n`
          }
        }
      }

      // Enum/Options
      if (field.annotated_options && Array.isArray(field.annotated_options) && field.annotated_options.length > 0) {
        output += `*Options*:\n\n`
        field.annotated_options.forEach(([optValue, optDesc]) => {
          const cleanDesc = (optDesc || '').replace(/\n/g, ' ').trim()
          output += `* \`${optValue}\``
          if (cleanDesc) {
            output += `: ${cleanDesc}`
          }
          output += `\n`
        })
        output += `\n`
      }

      // Interpolation support
      if (field.interpolated === true) {
        output += `_This field supports xref:configuration:interpolation.adoc#bloblang-queries[interpolation functions]._\n\n`
      }

      // Recurse for children
      if (field.children && Array.isArray(field.children) && field.children.length > 0) {
        const sortedChildren = [...field.children].sort((a, b) => {
          const an = a.name || ''
          const bn = b.name || ''
          return an.localeCompare(bn, undefined, { sensitivity: 'base' })
        })
        renderFields(sortedChildren, level + 1, currentPath)
      }
    })
  }

  renderFields(sorted, currentLevel, prefix)

  return output
}
