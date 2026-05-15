'use strict'

/**
 * Unified Navigation Extension (Config-Driven)
 *
 * Creates a unified navigation structure based on component configuration.
 * Components define their navigation hierarchy via the 'page-navigation' attribute in antora.yml.
 * Supports nested buckets with version detection and breadcrumb hierarchy computation.
 *
 * Configuration: No playbook configuration needed - reads from component antora.yml files.
 *
 * Component antora.yml configuration:
 * asciidoc:
 *   attributes:
 *     component-metadata:
 *       title: "Component Name"
 *       color: "#hexcolor"
 *       icon: "tabler-icon-name"
 *       order: 10
 *     page-navigation:
 *       - component-name
 *       - parent-component:
 *           - child-component-1
 *           - child-component-2
 *
 * Output: Attaches to pages with page-navigation config:
 * - 'page-custom-navigation' (JSON array of buckets)
 * - 'page-has-custom-nav' (boolean)
 * - 'page-is-umbrella-nav' (boolean)
 * - 'page-breadcrumb-hierarchy' (JSON array of breadcrumb items)
 *
 * Components without page-navigation use standard Antora navigation.
 */

module.exports.register = function () {
  const logger = this.getLogger('unified-navigation-extension')

  this.on('navigationBuilt', ({ contentCatalog }) => {
    try {
      // Build a set of published page URLs (pages that have page.out defined)
      const allPages = contentCatalog.getPages()
      const publishedUrlsSet = new Set(
        allPages
          .filter((page) => page.out && page.pub && page.pub.url)
          .map((page) => page.pub.url)
      )

      const components = contentCatalog.getComponents()

      // Build component version navigation map (used by both config-driven and section-based nav)
      const componentVersionNavMap = buildComponentVersionNavMap(components)

      // PHASE 1: Config-Driven Navigation
      // Step 1: Collect all components with page-navigation config
      const pages = contentCatalog.getPages()
      const configDrivenPages = new Set()
      const componentConfigs = new Map() // component -> {configTree, configOwner}

      // First pass: find components with page-navigation config
      for (const component of components) {
        for (const version of component.versions) {
          const navConfig = version.asciidoc?.attributes?.['page-navigation']
          if (navConfig) {
            try {
              const configTree = parseNavigationConfig(navConfig)
              if (configTree.length > 0) {
                // Store config and extract all component names mentioned
                const allComponentsInConfig = new Set()
                const extractComponents = (tree) => {
                  for (const item of tree) {
                    allComponentsInConfig.add(item.name)
                    if (item.children) {
                      extractComponents(item.children)
                    }
                  }
                }
                extractComponents(configTree)

                // Store config for the owner
                // A component's OWN config always takes priority (regardless of depth)
                const existingOwnerConfig = componentConfigs.get(component.name)

                if (!existingOwnerConfig || existingOwnerConfig.configOwner !== component.name) {
                  // No existing config, or existing config is from another component - use this one
                  componentConfigs.set(component.name, {
                    configTree,
                    configOwner: component.name,
                    allComponents: allComponentsInConfig,
                  })
                  console.log(`[config] Storing ${component.name}'s OWN config (root items: ${Array.from(allComponentsInConfig).join(', ')})`)
                } else {
                  // Existing config is also from this component - compare depths
                  const existingOwnerDepth = getComponentDepth(existingOwnerConfig.configTree, component.name)
                  const newOwnerDepth = getComponentDepth(configTree, component.name)
                  if (newOwnerDepth >= existingOwnerDepth) {
                    // New config has equal or better hierarchy, use it
                    componentConfigs.set(component.name, {
                      configTree,
                      configOwner: component.name,
                      allComponents: allComponentsInConfig,
                    })
                    console.log(`[config] Updating ${component.name}'s OWN config (better depth)`)
                  }
                }

                // Also store this config for all child components
                // Prefer configs with deeper nesting (more parent context for breadcrumbs)
                for (const childComponent of allComponentsInConfig) {
                  const existingConfig = componentConfigs.get(childComponent)
                  const newDepth = getComponentDepth(configTree, childComponent)

                  if (!existingConfig) {
                    // No existing config, store this one
                    componentConfigs.set(childComponent, {
                      configTree,
                      configOwner: component.name,
                      allComponents: allComponentsInConfig,
                    })
                  } else {
                    // Compare depths - prefer deeper nesting (more parent context)
                    const existingDepth = getComponentDepth(existingConfig.configTree, childComponent)
                    if (newDepth > existingDepth) {
                      // New config has more parent context, prefer it for breadcrumbs
                      componentConfigs.set(childComponent, {
                        configTree,
                        configOwner: component.name,
                        allComponents: allComponentsInConfig,
                      })
                    }
                  }
                }
              }
            } catch (error) {
              logger.error(`Error parsing page-navigation for ${component.name}: ${error.message}`)
            }
          }
        }
      }

      // Step 1.5: Find the home component's config for breadcrumb calculations
      // Home has the full hierarchy, so use it for ALL breadcrumb computations
      const homeConfig = componentConfigs.get('home')

      // Step 2: Apply navigation to all pages of components mentioned in configs
      for (const page of pages) {
        if (!page.src) continue

        const configData = componentConfigs.get(page.src.component)
        if (!configData) continue // No config for this component

        try {
          // Filter config tree to show only relevant hierarchy for current page
          const relevantTree = filterConfigTreeForComponent(configData.configTree, page.src.component)

          if (page.src.component === 'streaming' && page.src.path.includes('home/index')) {
            logger.warn(
              `Streaming home page: filtered tree has ${relevantTree.length} root items: ${relevantTree.map((t) => t.name).join(', ')}`
            )
          }

          const buckets = buildBucketsFromConfig(
            relevantTree,
            contentCatalog,
            page.src.component,
            page.src.version,
            publishedUrlsSet,
            componentVersionNavMap,
            page
          )

          // Always compute breadcrumb hierarchy from HOME config (which has full hierarchy)
          // This ensures components like self-managed show "Docs > Data Platform > Self-Managed"
          // instead of just "Docs > Self-Managed"
          page.asciidoc = page.asciidoc || {}
          page.asciidoc.attributes = page.asciidoc.attributes || {}

          if (homeConfig) {
            const hierarchy = findComponentPath(homeConfig.configTree, page.src.component, contentCatalog)
            if (hierarchy) {
              page.asciidoc.attributes['page-breadcrumb-hierarchy'] = JSON.stringify(hierarchy)
            }
          }

          // Only set custom navigation if buckets exist AND component is not standalone
          // Standalone components appear at root level with no children (e.g., agentic-data-plane)
          // They appear in product switcher/home nav but use standard Antora nav on their own pages
          const isStandaloneComponent = isStandalone(configData.configTree, page.src.component)

          if (buckets.length > 0 && !isStandaloneComponent) {
            page.asciidoc.attributes['page-custom-navigation'] = JSON.stringify(buckets)
            page.asciidoc.attributes['page-has-custom-nav'] = 'true'
            // Set is-umbrella-nav to show parent bucket headers
            page.asciidoc.attributes['page-is-umbrella-nav'] = 'true'
          }

          configDrivenPages.add(page.src.component)
        } catch (error) {
          logger.error(`Error processing navigation for ${page.src.path}: ${error.message}`)
        }
      }

      if (configDrivenPages.size > 0) {
        logger.warn(`Processed config-driven navigation for ${configDrivenPages.size} components: ${Array.from(configDrivenPages).join(', ')}`)
      }
    } catch (error) {
      logger.error(`Error building unified navigation: ${error.message}`)
      logger.error(error.stack)
    }
  })
}

/**
 * Build a map of component navigation data for quick lookup
 * @param {Array} components - Array of component objects from content catalog
 * @returns {Map} Map of component name -> { component, versionMap, latestVersion }
 */
function buildComponentVersionNavMap(components) {
  const map = new Map()

  for (const component of components) {
    const versionMap = new Map()
    for (const version of component.versions) {
      versionMap.set(version.version, {
        navigation: version.navigation || [],
        displayVersion: version.displayVersion || version.version,
      })
    }

    map.set(component.name, {
      component,
      versionMap,
      latestVersion: component.latestVersion || component.versions[0],
    })
  }

  return map
}

/**
 * Filter navigation items to exclude unpublished pages
 * @param {Array} items - Navigation items array
 * @param {Map} publishedUrlsSet - Set of published page URLs
 * @returns {Array} Filtered navigation items
 */
function filterUnpublishedPages(items, publishedUrlsSet) {
  if (!Array.isArray(items)) return []

  return items
    .map((item) => {
      // If item has a URL, check if it's in the published URLs set
      if (item.url) {
        // Skip items whose pages aren't published
        if (!publishedUrlsSet.has(item.url)) {
          return null
        }
      }

      // Recursively filter children
      if (item.items && Array.isArray(item.items)) {
        item.items = filterUnpublishedPages(item.items, publishedUrlsSet)
      }

      return item
    })
    .filter(Boolean) // Remove null entries
}

/**
 * Extract component-metadata from a component version
 * @param {Object} version - Component version object
 * @returns {Object|null} The component-metadata object or null
 */
function getHeaderData(version) {
  if (!version || !version.asciidoc || !version.asciidoc.attributes) {
    return null
  }
  return version.asciidoc.attributes['component-metadata'] || null
}

/**
 * Find the depth of a component in a config tree
 * @param {Array} tree - Navigation config tree
 * @param {string} targetComponent - Component name to find
 * @param {number} currentDepth - Current depth in recursion
 * @returns {number} Depth of component (0 = root level), or -1 if not found
 */
function getComponentDepth(tree, targetComponent, currentDepth = 0) {
  for (const item of tree) {
    if (item.name === targetComponent) {
      return currentDepth
    }
    if (item.children) {
      const childDepth = getComponentDepth(item.children, targetComponent, currentDepth + 1)
      if (childDepth !== -1) return childDepth
    }
  }
  return -1 // Not found
}

/**
 * Parse page-navigation YAML config into component tree structure
 * @param {string|array} navConfig - YAML string or parsed array from page-navigation attribute
 * @returns {Array} Array of bucket definitions with hierarchy
 *
 * Example input:
 * - data-platform:
 *     - cloud-data-platform
 *     - self-managed: [streaming, connect]
 * - redpanda-adp
 *
 * Example output:
 * [{
 *   name: 'data-platform',
 *   children: [
 *     { name: 'cloud-data-platform' },
 *     { name: 'self-managed', children: [{ name: 'streaming' }, { name: 'connect' }] }
 *   ]
 * }, { name: 'redpanda-adp' }]
 */
function parseNavigationConfig(navConfig) {
  // If it's already an array (from YAML parsing), use it directly
  const config = typeof navConfig === 'string' ? JSON.parse(navConfig) : navConfig

  if (!Array.isArray(config)) {
    return []
  }

  function parseItem(item) {
    if (typeof item === 'string') {
      // Simple component name
      return { name: item }
    } else if (typeof item === 'object' && item !== null) {
      // Object with component name as key and children as value
      const keys = Object.keys(item)
      if (keys.length === 0) return null

      const name = keys[0]
      const childrenValue = item[name]

      if (!childrenValue) {
        return { name }
      }

      // Parse children (can be array of strings, objects, or mix)
      const children = Array.isArray(childrenValue)
        ? childrenValue.map(parseItem).filter(Boolean)
        : [parseItem(childrenValue)].filter(Boolean)

      return { name, children: children.length > 0 ? children : undefined }
    }

    return null
  }

  return config.map(parseItem).filter(Boolean)
}

/**
 * Build navigation buckets from parsed config tree
 * @param {Array} configTree - Parsed navigation config tree
 * @param {Object} contentCatalog - Antora content catalog
 * @param {string} currentPageComponent - Current page's component name
 * @param {string} currentPageVersion - Current page's version
 * @param {Set} publishedUrlsSet - Set of published page URLs
 * @param {Map} componentVersionNavMap - Map of component navigation data
 * @returns {Array} Array of bucket objects for templates
 */
/**
 * Check if a component is standalone (root-level with no children)
 * Standalone components appear in product switcher but use standard Antora nav
 * @param {Array} configTree - Parsed navigation config tree
 * @param {string} componentName - Component name to check
 * @returns {boolean} True if component is standalone
 */
function isStandalone(configTree, componentName) {
  for (const item of configTree) {
    if (item.name === componentName) {
      // Component found at root level
      return !item.children || item.children.length === 0
    }
  }
  return false
}

/**
 * Filter config tree to show only relevant hierarchy for a component
 * - If component is at root level: return entire tree
 * - If component is a parent (has children): return that parent with its children
 * - If component is a child (leaf): return parent + siblings (parent marked for nav-only display)
 * @param {Array} configTree - Full navigation config tree
 * @param {string} componentName - Current page component
 * @returns {Array} Filtered config tree
 */
function filterConfigTreeForComponent(configTree, componentName) {
  const treeNames = configTree.map(t => t.name).join(', ')
  console.log(`[filterConfigTreeForComponent] Called for ${componentName}, root items: [${treeNames}]`)

  // Check if component is at root level
  for (const item of configTree) {
    if (item.name === componentName) {
      console.log(`[filterConfigTreeForComponent] ${componentName}: FOUND at root level, hasChildren: ${!!item.children}`)
      // Component is at root - if it has children, show parent nav items + children as buckets
      if (item.children) {
        // Return parent with showNavItemsOnly flag + children as separate buckets
        const result = [{ ...item, showNavItemsOnly: true, children: undefined }, ...item.children]
        console.log(`[filterConfigTreeForComponent] ${componentName}: returning parent with showNavItemsOnly + ${item.children.length} children`)
        return result
      }
      console.log(`[filterConfigTreeForComponent] ${componentName}: no children, returning original tree`)
      return configTree
    }
  }

  console.log(`[filterConfigTreeForComponent] ${componentName}: NOT found at root, searching nested...`)

  // Component is nested - find it and determine if it's a parent or child
  function findComponentAndParent(items, parent = null) {
    for (const item of items) {
      if (item.name === componentName) {
        // Found the component
        if (item.children) {
          // Component is a parent - return it with its children
          return { isParent: true, parent: null, result: [item] }
        } else {
          // Component is a leaf child
          // Check if there are other leaf siblings (to determine if we should show siblings)
          const siblings = parent ? parent.children.filter(child => child.name !== componentName) : []
          const hasLeafSiblings = siblings.some(sibling => !sibling.children)

          if (hasLeafSiblings) {
            // Has other leaf siblings - show parent nav + all siblings (like Streaming/Connect)
            // Mark parent as "showNavItemsOnly" so it doesn't render as a bucket header
            return { isParent: false, parent: parent, result: parent ? [{ ...parent, showNavItemsOnly: true }, ...parent.children] : [item] }
          } else {
            // No leaf siblings (standalone like Cloud) - return empty to use standard nav
            return { isParent: false, parent: null, result: [] }
          }
        }
      }

      if (item.children) {
        const found = findComponentAndParent(item.children, item)
        if (found) return found
      }
    }
    return null
  }

  const found = findComponentAndParent(configTree)
  return found ? found.result : configTree // Fallback to full tree if not found
}

function buildBucketsFromConfig(
  configTree,
  contentCatalog,
  currentPageComponent,
  currentPageVersion,
  publishedUrlsSet,
  componentVersionNavMap,
  page
) {
  // Get list of buckets to expand by default from page attribute
  const expandBucketsAttr = page?.asciidoc?.attributes?.['page-expand-buckets'] || ''
  const expandBuckets = expandBucketsAttr.split(',').map((s) => s.trim()).filter(Boolean)

  function buildBucket(configItem) {
    const componentName = configItem.name
    const component = contentCatalog.getComponent(componentName)

    if (!component) {
      return null // Component not found
    }

    const latestVersion = component.latestVersion || component.versions[0]
    if (!latestVersion) {
      return null
    }

    // Get metadata from component-metadata
    const metadata = getHeaderData(latestVersion)
    if (!metadata) {
      return null
    }

    // Build versions array
    const versions = component.versions.map((v) => ({
      version: v.version,
      displayVersion: v.displayVersion || v.version,
      url: v.url,
      isPrerelease: !!v.prerelease,
      releaseDate: v.asciidoc?.attributes?.['page-release-date'] || null,
      isEol: v.asciidoc?.attributes?.['page-is-past-eol'] === 'true',
    }))

    // Determine if this is the current bucket
    const isCurrentBucket = componentName === currentPageComponent

    // Check if this bucket should be expanded by default (from page attribute)
    const isExpandedByDefault = expandBuckets.includes(componentName)

    // Get navigation for this component
    let navigation, displayVersion
    const compData = componentVersionNavMap.get(componentName)

    if (isCurrentBucket && compData) {
      // For current bucket, use page's version
      const versionData = compData.versionMap.get(currentPageVersion)
      if (versionData) {
        navigation = versionData.navigation
        displayVersion = versionData.displayVersion
      } else {
        navigation = compData.latestVersion?.navigation || []
        displayVersion = compData.latestVersion?.displayVersion || compData.latestVersion?.version
      }
    } else if (compData) {
      // For other buckets, use latest version
      navigation = compData.latestVersion?.navigation || []
      displayVersion = compData.latestVersion?.displayVersion || compData.latestVersion?.version
    } else {
      navigation = []
      displayVersion = latestVersion.displayVersion || latestVersion.version
    }

    // Filter unpublished pages
    const filteredNavigation = filterUnpublishedPages(navigation, publishedUrlsSet)

    const bucket = {
      componentName,
      title: metadata.title || component.title || componentName,
      color: metadata.color || '#6366f1',
      icon: metadata.icon || null,
      order: metadata.order || 999,
      versions,
      currentVersion: displayVersion,
      isCurrentBucket,
      isExpandedByDefault,
      items: filteredNavigation,
      componentUrl: component.url,
      showNavItemsOnly: configItem.showNavItemsOnly || false, // Flag for rendering nav items without bucket header,
    }

    // Process children recursively
    if (configItem.children && configItem.children.length > 0) {
      bucket.children = configItem.children.map(buildBucket).filter(Boolean)
      // Determine if parent should be expanded
      bucket.hasCurrentChild = bucket.children.some((c) => c.isCurrentBucket || c.hasCurrentChild)
    }

    return bucket
  }

  return configTree.map(buildBucket).filter(Boolean)
}

/**
 * Find component's position in navigation hierarchy for breadcrumbs
 * @param {Array} configTree - Parsed navigation config tree
 * @param {string} targetComponent - Component to find
 * @param {Object} contentCatalog - Antora content catalog
 * @returns {Array|null} Array of breadcrumb items or null
 */
function findComponentPath(configTree, targetComponent, contentCatalog) {
  function search(items, path = []) {
    for (const item of items) {
      const componentName = item.name
      const component = contentCatalog.getComponent(componentName)

      if (!component) continue

      const latestVersion = component.latestVersion || component.versions[0]
      const metadata = latestVersion ? getHeaderData(latestVersion) : null

      const breadcrumbItem = {
        component: componentName,
        title: metadata?.title || component.title || componentName,
        url: component.url || `/${componentName}/`,
      }

      if (componentName === targetComponent) {
        return [...path, breadcrumbItem]
      }

      if (item.children && item.children.length > 0) {
        const childPath = search(item.children, [...path, breadcrumbItem])
        if (childPath) return childPath
      }
    }

    return null
  }

  return search(configTree)
}
