'use strict'

const { raiseListenerLimit } = require('./util/raise-listener-limit')
const { normalizeType, typeFromRelative } = require('./util/connect-catalog')

// Page :type: values for each data type. Pages use metrics where the data says metric.
const PAGE_TYPE = { metric: 'metrics' }

/**
 * Indexes translated catalog rows (from generate-rp-connect-info) by
 * `name:type`. Names are not unique across types: parquet is a certified input
 * and a community processor, and sql is a certified cache and a community
 * output, so a name-only key lets one type's row overwrite another's.
 */
function buildRowLookup (rows) {
  const lookup = new Map()
  for (const row of rows || []) {
    const name = String(row.connector || '').trim()
    const type = normalizeType(row.type)
    if (name && type) lookup.set(`${name}:${type}`, row)
  }
  return lookup
}

/**
 * The catalog facts for one connector page, from its data row when there is
 * one and from the page's own attributes otherwise.
 * - type: the page's :type:, or the type its directory implies when the data
 *   has a row for that name and type (drafts no longer write :type:)
 * - deprecated: the data row's deprecated flag (info.csv deprecated column, or
 *   catalog.json status), so a hand-kept :status: cannot hide a live component
 *   or list a deprecated one. Pages without a data row fall back to :status:.
 * - categories: catalog.json categories when the row has them, else :categories:
 */
function resolveComponent ({ name, relative, pageType, pageStatus, pageCategories }, lookup) {
  const dirType = typeFromRelative(relative)
  const key = (t) => `${name}:${normalizeType(t)}`
  let type = pageType || null
  let row = type ? lookup.get(key(type)) : undefined
  if (!type && dirType && lookup.has(key(dirType))) {
    row = lookup.get(key(dirType))
    type = PAGE_TYPE[dirType] || dirType
  }
  if (!type) return null
  const deprecated = row
    ? row.deprecated === 'y' || row.status === 'deprecated'
    : pageStatus === 'deprecated'
  const categories = row && Array.isArray(row.categories) && row.categories.length
    ? row.categories.join(', ')
    : pageCategories
  return {
    type,
    row,
    deprecated,
    categories,
    supportLevel: row ? (row.support_level || 'community').toLowerCase() : null,
    isEnterprise: row ? row.is_licensed === 'Yes' : false
  }
}

module.exports.buildRowLookup = buildRowLookup
module.exports.resolveComponent = resolveComponent

/**
 * Redpanda Connect Category Aggregation Extension
 *
 * IMPORTANT: This extension depends on generate-rp-connect-info running first.
 * Both extensions use 'contentClassified' event. The generate-rp-connect-info
 * extension returns a Promise, so Antora will wait for it to complete before
 * running this extension (extensions are processed in playbook order).
 *
 * Ensure generate-rp-connect-info is listed BEFORE this extension in your playbook.
 */
module.exports.register = function ({ config }) {
  raiseListenerLimit(this)
  const logger = this.getLogger('redpanda-connect-category-aggregation-extension')

  this.on('contentClassified', ({ contentCatalog }) => {
    const redpandaConnect = contentCatalog.getComponents().find(component => component.name === 'connect')

    if (!redpandaConnect || !redpandaConnect.latest) {
      logger.warn('Could not find the connect component. Skipping category creation.')
      return
    }

    const descriptions = redpandaConnect.latest.asciidoc.attributes.categories
    const csvData = redpandaConnect.latest.asciidoc.attributes.csvData

    if (!descriptions) {
      logger.error('No categories attribute found in connect component')
      return
    }

    if (!csvData || !csvData.data) {
      logger.error('No csvData attribute found in connect component.')
      logger.error('Ensure generate-rp-connect-info extension is listed BEFORE this extension in your playbook.')
      return
    }

    const rowLookup = buildRowLookup(csvData.data)

    logger.info(`Loaded support data for ${rowLookup.size} connectors from CSV`)

    const connectCategoriesData = {}
    const flatComponentsData = []
    const driverSupportData = {}
    const cacheSupportData = {}
    const types = Object.keys(descriptions)

    // Initialize connectCategoriesData for each type
    for (const type of types) {
      connectCategoriesData[type] = []
    }

    try {
      const files = contentCatalog.findBy({ component: 'connect', family: 'page' })

      for (const file of files) {
        // Prefer using page.asciidoc.attributes when available
        const attrs = file.asciidoc?.attributes || {}

        // Get attributes - prefer API, fallback to content parsing
        const status = attrs.status || extractAttribute(file, 'status')
        const driverSupport = attrs['driver-support'] || extractAttribute(file, 'driver-support')
        const cacheSupport = attrs['cache-support'] || extractAttribute(file, 'cache-support')
        const commercialNames = attrs['page-commercial-names'] || extractAttribute(file, 'page-commercial-names')

        const pubUrl = file.pub.url
        const name = file.src.stem

        const resolved = resolveComponent({
          name,
          relative: file.src.relative,
          pageType: attrs.type || extractAttribute(file, 'type'),
          pageStatus: status,
          pageCategories: attrs.categories || extractAttribute(file, 'categories')
        }, rowLookup)
        if (!resolved) continue
        const { type: fileType, categories, isEnterprise } = resolved

        // Skip deprecated components
        if (resolved.deprecated) continue

        let componentStatus = status || 'community'

        // Determine status from the data row's support level (data takes precedence)
        if (resolved.supportLevel) {
          if (resolved.supportLevel === 'certified' || resolved.supportLevel === 'enterprise') {
            componentStatus = 'certified'
          } else {
            componentStatus = resolved.supportLevel
          }
        }

        // Parse commercial names and use first as display name
        let commonName = name // Default to connector key name
        if (commercialNames) {
          const names = commercialNames.split(',').map(n => n.trim()).filter(n => n)
          if (names.length > 0) {
            commonName = names[0]
          }
        }

        // Populate connectCategoriesData
        if (types.includes(fileType) && categories) {
          const categoryList = categories.replace(/[\[\]"]/g, '').split(',').map(cat => cat.trim())

          for (const category of categoryList) {
            let categoryObj = connectCategoriesData[fileType].find(cat => cat.name === category)

            if (!categoryObj) {
              categoryObj = descriptions[fileType].find(desc => desc.name === category) || { name: category, description: '' }
              categoryObj.items = []
              connectCategoriesData[fileType].push(categoryObj)
            }

            categoryObj.items.push({ name: commonName, url: pubUrl, status: componentStatus })
          }
        }

        // Populate flatComponentsData
        let flatItem = flatComponentsData.find(item => item.name === commonName)
        if (!flatItem) {
          flatItem = {
            name: commonName,
            originalName: name,
            support: componentStatus,
            types: [],
            enterprise: isEnterprise
          }
          flatComponentsData.push(flatItem)
        }

        if (!flatItem.types.some(t => t.type === fileType)) {
          flatItem.types.push({
            type: fileType,
            url: pubUrl,
            enterprise: isEnterprise,
            support: componentStatus
          })
        }

        // Populate support data
        if (driverSupport) driverSupportData[name] = driverSupport
        if (cacheSupport) cacheSupportData[name] = cacheSupport
      }

      redpandaConnect.latest.asciidoc.attributes.connectCategoriesData = connectCategoriesData
      redpandaConnect.latest.asciidoc.attributes.flatComponentsData = flatComponentsData
      redpandaConnect.latest.asciidoc.attributes.driverSupportData = driverSupportData
      redpandaConnect.latest.asciidoc.attributes.cacheSupportData = cacheSupportData

      logger.info(`Processed ${flatComponentsData.length} components across ${types.length} types`)
      logger.debug(`Categories data: ${JSON.stringify(connectCategoriesData, null, 2)}`)
    } catch (error) {
      logger.error(`Error processing Redpanda Connect files: ${error.message}`)
      logger.error(error.stack)
    }
  })

  /**
   * Extract attribute from file contents when page.asciidoc.attributes is not available.
   * This is a fallback for when attributes haven't been parsed yet.
   */
  function extractAttribute (file, attrName) {
    if (!file.contents) return null

    try {
      const content = file.contents.toString('utf8')
      const regex = new RegExp(`:${attrName}:\\s*(.*)`)
      const match = regex.exec(content)
      return match ? match[1].trim() : null
    } catch {
      return null
    }
  }
}
