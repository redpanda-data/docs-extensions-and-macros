'use strict'

module.exports.register = function ({ config }) {
  const logger = this.getLogger('redpanda-connect-category-aggregation-extension')

  this.once('contentClassified', ({ siteCatalog, contentCatalog }) => {
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
      logger.error('No csvData attribute found in redpanda-connect component')
      logger.error('Make sure the generate-rp-connect-info extension runs before this extension')
      return
    }

    // Build lookup maps from CSV data
    const supportLookup = {}
    csvData.data.forEach(row => {
      const connector = row.connector
      if (connector) {
        supportLookup[connector] = {
          supportLevel: row.support_level?.toLowerCase() || 'community',
          isEnterprise: row.is_licensed === 'Yes'
        }
      }
    })

    logger.info(`Loaded support data for ${Object.keys(supportLookup).length} connectors from CSV`)

    const connectCategoriesData = {}
    const flatComponentsData = []
    const driverSupportData = {}
    const cacheSupportData = {}
    const types = Object.keys(descriptions)

    // Initialize connectCategoriesData for each type
    types.forEach(type => {
      connectCategoriesData[type] = []
    })

    try {
      const files = contentCatalog.findBy({ component: 'redpanda-connect', family: 'page' })

      files.forEach(file => {
        let content = file.contents.toString('utf8')
        const categoryMatch = /:categories: (.*)/.exec(content)
        const typeMatch = /:type: (.*)/.exec(content)
        const statusMatch = /:status: (.*)/.exec(content)
        const driverSupportMatch = /:driver-support: (.*)/.exec(content)
        const cacheSupportMatch = /:cache-support: (.*)/.exec(content)
        const pubUrl = file.pub.url
        const name = file.src.stem

        if (typeMatch) {
          const fileType = typeMatch[1]

          let status = statusMatch ? statusMatch[1] : 'community'

          // Skip deprecated components
          if (status === 'deprecated') return

          // Get support level from CSV data
          const csvInfo = supportLookup[name]
          const isEnterprise = csvInfo?.isEnterprise || false

          // Determine status from CSV support level
          if (csvInfo) {
            if (csvInfo.supportLevel === 'certified' || csvInfo.supportLevel === 'enterprise') {
              status = 'certified'
            } else {
              status = csvInfo.supportLevel
            }
          }

          // Read commercial names from frontmatter (:commercial-names: attribute)
          const commercialNamesMatch = /:commercial-names:\s*(.*)/.exec(content)
          let commonName = name // Default to connector key name

          if (commercialNamesMatch && commercialNamesMatch[1].trim()) {
            // Parse comma-separated list and use the first one as primary
            const names = commercialNamesMatch[1].split(',').map(n => n.trim()).filter(n => n)
            if (names.length > 0) {
              commonName = names[0]
            }
          }

          // Populate connectCategoriesData
          if (types.includes(fileType) && categoryMatch) {
            const categories = categoryMatch[1].replace(/[\[\]"]/g, '').split(',').map(category => category.trim())
            categories.forEach(category => {
              let categoryObj = connectCategoriesData[fileType].find(cat => cat.name === category)

              if (!categoryObj) {
                categoryObj = descriptions[fileType].find(desc => desc.name === category) || { name: category, description: "" }
                categoryObj.items = []
                connectCategoriesData[fileType].push(categoryObj)
              }

              categoryObj.items.push({ name: commonName, url: pubUrl, status: status })
            })
          }

          // Populate flatComponentsData
          let flatItem = flatComponentsData.find(item => item.name === commonName)
          if (!flatItem) {
            flatItem = { name: commonName, originalName: name, support: status, types: [], enterprise: isEnterprise ? true : false}
            flatComponentsData.push(flatItem)
          }

          if (!flatItem.types.some(type => type.type === fileType)) {
            flatItem.types.push({ type: fileType, url: pubUrl, enterprise: isEnterprise? true : false, support: status})
          }

          // Populate support data
          if (driverSupportMatch) driverSupportData[name] = driverSupportMatch[1]
          if (cacheSupportMatch) cacheSupportData[name] = cacheSupportMatch[1]
        }
      })

      redpandaConnect.latest.asciidoc.attributes.connectCategoriesData = connectCategoriesData
      redpandaConnect.latest.asciidoc.attributes.flatComponentsData = flatComponentsData
      redpandaConnect.latest.asciidoc.attributes.driverSupportData = driverSupportData
      redpandaConnect.latest.asciidoc.attributes.cacheSupportData = cacheSupportData

      logger.debug(`Added Redpanda Connect data to latest Asciidoc object.`)
      logger.debug(`${JSON.stringify({ connectCategoriesData, flatComponentsData }, null, 2)}`)
    } catch (error) {
      logger.error(`Error processing Redpanda Connect files: ${error.message}`)
    }
  })
}
