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
    const componentNameMap = redpandaConnect.latest.asciidoc.attributes.components
    const certifiedConnectors = redpandaConnect.latest.asciidoc.attributes['certified-components']
    const enterpriseConnectors = redpandaConnect.latest.asciidoc.attributes['enterprise-components']

    if (!descriptions || !componentNameMap || !certifiedConnectors || !enterpriseConnectors) {
      if (!descriptions) {
        logger.error('No categories attribute found in redpanda-connect component')
      }
      if (!componentNameMap) {
        logger.error('No components attribute found in redpanda-connect component')
      }
      if (!certifiedConnectors) {
        logger.error('No certified-components attribute found in redpanda-connect component')
      }
      if (!enterpriseConnectors) {
        logger.error('No enterprise-components attribute found in redpanda-connect component')
      }
      return
    }

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

          const isCertified = certifiedConnectors.some(connector => connector.name === name)

          const isEnterprise = enterpriseConnectors.some(connector => connector === name)

          // Override status to "certified" if in the lookup table
          if (isCertified || isEnterprise) {
            status = 'certified'
          } else {
            status = 'community'
          }

          // Find the common name
          const componentNameEntry = componentNameMap.find(component => component.key === name)
          const commonName = componentNameEntry ? componentNameEntry.name : name

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
