'use strict'

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
  const logger = this.getLogger('redpanda-connect-category-aggregation-extension')

  this.on('contentClassified', ({ contentCatalog }) => {
    const redpandaConnect = contentCatalog.getComponents().find(component => component.name === 'redpanda-connect')

    if (!redpandaConnect || !redpandaConnect.latest) {
      logger.warn('Could not find the redpanda-connect component. Skipping category creation.')
      return
    }

    const descriptions = redpandaConnect.latest.asciidoc.attributes.categories
    const csvData = redpandaConnect.latest.asciidoc.attributes.csvData

    if (!descriptions) {
      logger.error('No categories attribute found in redpanda-connect component')
      return
    }

    if (!csvData || !csvData.data) {
      logger.error('No csvData attribute found in redpanda-connect component.')
      logger.error('Ensure generate-rp-connect-info extension is listed BEFORE this extension in your playbook.')
      return
    }

    // Build lookup maps from CSV data
    const supportLookup = new Map()
    for (const row of csvData.data) {
      const connector = row.connector
      if (connector) {
        supportLookup.set(connector, {
          supportLevel: (row.support_level || 'community').toLowerCase(),
          isEnterprise: row.is_licensed === 'Yes'
        })
      }
    }

    logger.info(`Loaded support data for ${supportLookup.size} connectors from CSV`)

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
      const files = contentCatalog.findBy({ component: 'redpanda-connect', family: 'page' })

      for (const file of files) {
        // Prefer using page.asciidoc.attributes when available
        const attrs = file.asciidoc?.attributes || {}

        // Get attributes - prefer API, fallback to content parsing
        const fileType = attrs.type || extractAttribute(file, 'type')
        const categories = attrs.categories || extractAttribute(file, 'categories')
        const status = attrs.status || extractAttribute(file, 'status')
        const driverSupport = attrs['driver-support'] || extractAttribute(file, 'driver-support')
        const cacheSupport = attrs['cache-support'] || extractAttribute(file, 'cache-support')
        const commercialNames = attrs['page-commercial-names'] || extractAttribute(file, 'page-commercial-names')

        const pubUrl = file.pub.url
        const name = file.src.stem

        if (!fileType) continue

        let componentStatus = status || 'community'

        // Skip deprecated components
        if (componentStatus === 'deprecated') continue

        // Get support level from CSV data
        const csvInfo = supportLookup.get(name)
        const isEnterprise = csvInfo?.isEnterprise || false

        // Determine status from CSV support level (CSV takes precedence)
        if (csvInfo) {
          if (csvInfo.supportLevel === 'certified' || csvInfo.supportLevel === 'enterprise') {
            componentStatus = 'certified'
          } else {
            componentStatus = csvInfo.supportLevel
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
