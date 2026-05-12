'use strict'

/**
 * Unified Navigation Extension
 *
 * Creates a unified navigation structure for components within an umbrella section.
 * Discovers child components dynamically based on page-header-data.section attribute.
 * Supports nested buckets via parent-component attribute.
 *
 * Configuration:
 * - umbrellaSection: The section name to match (e.g., 'Data Platform')
 * - umbrellaComponent: The umbrella component name (e.g., 'data-platform')
 *
 * The extension reads from each component's existing page-header-data:
 * - title: Display name
 * - color: Theme color
 * - order: Sort order
 * - icon: Tabler icon name (optional)
 * - parent-component: Parent component name for nesting (optional)
 *
 * Output: Attaches 'page-unified-navigation' (JSON array) and 'page-is-unified-nav' (boolean)
 * to all pages in the umbrella and child components. Supports hierarchical nesting.
 *
 * Example playbook configuration:
 * antora:
 *   extensions:
 *     - require: '@redpanda-data/docs-extensions-and-macros/extensions/unified-navigation'
 *       umbrellaSection: 'Data Platform'
 *       umbrellaComponent: 'data-platform'
 */

module.exports.register = function ({ config }) {
  const logger = this.getLogger('unified-navigation-extension')

  // Antora lowercases config keys, so use lowercase
  const umbrellaSection = config?.umbrellasection
  const umbrellaComponent = config?.umbrellacomponent

  if (!umbrellaSection || !umbrellaComponent) {
    logger.warn('Missing required configuration: umbrellasection and umbrellacomponent')
    logger.warn(`Received config: ${JSON.stringify(config || {})}`)
    return
  }

  logger.warn(`Configuring unified navigation for section '${umbrellaSection}' with umbrella '${umbrellaComponent}'`)

  this.on('navigationBuilt', ({ contentCatalog }) => {
    try {
      const components = contentCatalog.getComponents()

      // Find the umbrella component
      const umbrella = components.find((c) => c.name === umbrellaComponent)
      if (!umbrella) {
        logger.warn(`Umbrella component '${umbrellaComponent}' not found`)
        return
      }

      // Find child components by matching page-header-data.section
      const childComponents = components.filter((c) => {
        if (c.name === umbrellaComponent) return false
        const latestVersion = c.latestVersion || c.versions[0]
        if (!latestVersion) return false
        const headerData = getHeaderData(latestVersion)
        return headerData && headerData.section === umbrellaSection
      })

      if (childComponents.length === 0) {
        logger.warn(`No child components found for section '${umbrellaSection}'`)
        return
      }

      logger.warn(
        `Found ${childComponents.length} child components for '${umbrellaSection}': ${childComponents.map((c) => c.name).join(', ')}`
      )

      // Build a map of component -> version -> navigation for quick lookup
      // Include the umbrella component as well
      const componentVersionNavMap = new Map()

      // Add umbrella component first
      const umbrellaLatestVersion = umbrella.latestVersion || umbrella.versions[0]
      if (umbrellaLatestVersion) {
        const versionMap = new Map()
        for (const version of umbrella.versions) {
          versionMap.set(version.version, {
            navigation: version.navigation || [],
            displayVersion: version.displayVersion || version.version,
          })
        }
        componentVersionNavMap.set(umbrella.name, {
          component: umbrella,
          versionMap,
          latestVersion: umbrellaLatestVersion,
        })
      }

      // Add child components
      for (const component of childComponents) {
        const versionMap = new Map()
        for (const version of component.versions) {
          versionMap.set(version.version, {
            navigation: version.navigation || [],
            displayVersion: version.displayVersion || version.version,
          })
        }
        componentVersionNavMap.set(component.name, {
          component,
          versionMap,
          latestVersion: component.latestVersion || component.versions[0],
        })
      }

      // Build base component metadata (without navigation - that's added per-page)
      const allMetadata = childComponents
        .map((component) => {
          const latestVersion = component.latestVersion || component.versions[0]
          const headerData = getHeaderData(latestVersion)

          if (!headerData) {
            logger.warn(`No page-header-data found for component '${component.name}'`)
            return null
          }

          // Build versions array with metadata
          const versions = component.versions.map((v) => ({
            version: v.version,
            displayVersion: v.displayVersion || v.version,
            url: v.url,
            isPrerelease: !!v.prerelease,
            releaseDate: v.asciidoc?.attributes?.['page-release-date'] || null,
            isEol: v.asciidoc?.attributes?.['page-is-past-eol'] === 'true',
          }))

          return {
            componentName: component.name,
            title: headerData.title || component.title,
            icon: headerData.icon || null,
            color: headerData.color || '#6366f1',
            order: headerData.order || 999,
            parentComponent: headerData['parent-component'] || null,
            versions: versions,
            componentUrl: component.url,
            isUmbrella: false,
          }
        })
        .filter(Boolean)

      // Build hierarchical structure: separate parents from children
      const parentMetadata = allMetadata.filter((m) => !m.parentComponent)
      const childMetadataMap = new Map()

      // Group children by parent
      for (const meta of allMetadata) {
        if (meta.parentComponent) {
          if (!childMetadataMap.has(meta.parentComponent)) {
            childMetadataMap.set(meta.parentComponent, [])
          }
          childMetadataMap.get(meta.parentComponent).push(meta)
        }
      }

      // Attach children to parents and sort
      const componentMetadata = parentMetadata
        .map((parent) => {
          const children = childMetadataMap.get(parent.componentName) || []
          return {
            ...parent,
            children: children.sort((a, b) => a.order - b.order),
          }
        })
        .sort((a, b) => a.order - b.order)

      logger.warn(`Built hierarchical navigation: ${componentMetadata.length} parent buckets`)
      for (const parent of componentMetadata) {
        if (parent.children.length > 0) {
          logger.warn(`  ${parent.componentName} has ${parent.children.length} children: ${parent.children.map((c) => c.componentName).join(', ')}`)
        }
      }

      if (componentMetadata.length === 0) {
        logger.warn('No valid navigation buckets built')
        return
      }

      // Only attach unified navigation to:
      // 1. The umbrella component (data-platform)
      // 2. Components that are parents WITH children (nested hierarchy roots)
      // 3. Components that have a parent (children in nested hierarchy)
      const parentComponentNames = new Set()
      const childComponentNames = new Set()
      for (const parent of componentMetadata) {
        if (parent.children && parent.children.length > 0) {
          // Only add parents that have children
          parentComponentNames.add(parent.componentName)
          for (const child of parent.children) {
            childComponentNames.add(child.componentName)
          }
        }
      }
      const affectedComponentNames = new Set([
        umbrellaComponent,
        ...parentComponentNames,
        ...childComponentNames,
      ])

      // Get all pages and set attributes on pages belonging to affected components
      const pages = contentCatalog.getPages()
      let pageCount = 0

      for (const page of pages) {
        if (!page.src || !affectedComponentNames.has(page.src.component)) continue

        const pageComponent = page.src.component
        const pageVersion = page.src.version

        // Determine which buckets to show based on current page
        let bucketsToShow
        let isUmbrellaPage = false
        if (pageComponent === umbrellaComponent) {
          // Umbrella page: show all top-level buckets
          bucketsToShow = componentMetadata
          isUmbrellaPage = true
        } else {
          // Find which parent hierarchy this page belongs to
          const pageIsParent = componentMetadata.some((m) => m.componentName === pageComponent)
          if (pageIsParent) {
            // Current page is a parent bucket - show only this parent and its children
            bucketsToShow = componentMetadata.filter((m) => m.componentName === pageComponent)
          } else {
            // Current page is a child - find its parent and show that parent + children
            let parentBucket = null
            for (const parent of componentMetadata) {
              if (parent.children && parent.children.some((c) => c.componentName === pageComponent)) {
                parentBucket = parent
                break
              }
            }
            bucketsToShow = parentBucket ? [parentBucket] : componentMetadata
          }
        }

        // Build unified navigation for this specific page
        // Recursive function to process bucket and its children
        const processBucket = (meta) => {
          const isCurrentBucket = meta.componentName === pageComponent
          const compData = componentVersionNavMap.get(meta.componentName)

          let navigation, currentVersion
          if (isCurrentBucket && compData) {
            // For the current bucket, use the page's version navigation
            const versionData = compData.versionMap.get(pageVersion)
            if (versionData) {
              navigation = versionData.navigation
              currentVersion = versionData.displayVersion
            } else {
              // Fallback to latest if version not found
              navigation = compData.latestVersion?.navigation || []
              currentVersion = compData.latestVersion?.displayVersion || compData.latestVersion?.version
            }
          } else if (compData) {
            // For other buckets, use the latest version navigation
            navigation = compData.latestVersion?.navigation || []
            currentVersion = compData.latestVersion?.displayVersion || compData.latestVersion?.version
          } else {
            navigation = []
            currentVersion = null
          }

          const result = {
            ...meta,
            isCurrentBucket,
            currentVersion,
            items: navigation,
          }

          // Process children recursively
          if (meta.children && meta.children.length > 0) {
            result.children = meta.children.map(processBucket)
            // Determine if parent should be expanded (if any child is current)
            result.hasCurrentChild = result.children.some((c) => c.isCurrentBucket || c.hasCurrentChild)
          }

          return result
        }

        const navForPage = bucketsToShow.map(processBucket)

        // Ensure asciidoc.attributes exists on the page
        page.asciidoc = page.asciidoc || {}
        page.asciidoc.attributes = page.asciidoc.attributes || {}

        // Attach as JSON string (templates will receive this as page.attributes.unified-navigation)
        page.asciidoc.attributes['page-unified-navigation'] = JSON.stringify(navForPage)
        page.asciidoc.attributes['page-is-unified-nav'] = 'true'
        page.asciidoc.attributes['page-is-umbrella-nav'] = isUmbrellaPage ? 'true' : 'false'
        pageCount++
      }

      logger.warn(
        `Attached unified navigation to ${pageCount} pages across ${affectedComponentNames.size} components (${Array.from(affectedComponentNames).join(', ')})`
      )
    } catch (error) {
      logger.error(`Error building unified navigation: ${error.message}`)
      logger.error(error.stack)
    }
  })
}

/**
 * Extract page-header-data from a component version
 * @param {Object} version - Component version object
 * @returns {Object|null} The page-header-data object or null
 */
function getHeaderData(version) {
  if (!version || !version.asciidoc || !version.asciidoc.attributes) {
    return null
  }
  return version.asciidoc.attributes['page-header-data'] || null
}
