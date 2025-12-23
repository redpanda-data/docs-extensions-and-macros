'use strict'
const fs = require('fs')
const path = require('path')
const Papa = require('papaparse')

// Default configuration - can be overridden via playbook config
const DEFAULTS = {
  csvPath: 'internal/plugins/info.csv',
  githubOwner: 'redpanda-data',
  githubRepo: 'connect'
}

module.exports.register = function ({ config }) {
  const logger = this.getLogger('redpanda-connect-info-extension')
  const { getAntoraValue } = require('../cli-utils/antora-utils')

  // Merge config with defaults
  const {
    csvpath,
    csvPath = DEFAULTS.csvPath,
    githubOwner = DEFAULTS.githubOwner,
    githubRepo = DEFAULTS.githubRepo
  } = config || {}

  // Use csvpath (legacy) or csvPath
  const localCsvPath = csvpath || null

  async function loadOctokit () {
    const { Octokit } = await import('@octokit/rest')
    const { getGitHubToken } = require('../cli-utils/github-token')
    const token = getGitHubToken()
    return token ? new Octokit({ auth: token }) : new Octokit()
  }

  // Use 'on' and return the promise so Antora waits for async completion
  this.on('contentClassified', ({ contentCatalog }) => {
    return processContent(contentCatalog)
  })

  async function processContent (contentCatalog) {
    const redpandaConnect = contentCatalog.getComponents().find(component => component.name === 'redpanda-connect')
    const redpandaCloud = contentCatalog.getComponents().find(component => component.name === 'redpanda-cloud')
    const preview = contentCatalog.getComponents().find(component => component.name === 'preview')

    if (!redpandaConnect) {
      logger.warn('redpanda-connect component not found, skipping CSV enrichment')
      return
    }

    const pages = contentCatalog.getPages()

    try {
      // Get the Connect version from antora.yml
      const connectVersion = getAntoraValue('asciidoc.attributes.latest-connect-version')

      // Fetch CSV data (from local file first, then GitHub as fallback)
      const csvData = await fetchCSV(localCsvPath, connectVersion, logger)
      const parsedData = Papa.parse(csvData, { header: true, skipEmptyLines: true })
      const enrichedData = translateCsvData(parsedData, pages, logger)
      parsedData.data = enrichedData

      // Set csvData on all relevant components
      const componentsToEnrich = [redpandaConnect, redpandaCloud, preview].filter(Boolean)
      for (const component of componentsToEnrich) {
        if (component.latest?.asciidoc?.attributes) {
          component.latest.asciidoc.attributes.csvData = parsedData
        }
      }

      // Enrich component pages with commercial names from CSV + AsciiDoc
      const commercialNamesMap = enrichPagesWithCommercialNames(pages, parsedData, logger)

      // Convert Map to plain object for serialization and macro access
      const commercialNamesObj = {}
      commercialNamesMap.forEach((names, connector) => {
        commercialNamesObj[connector] = Array.from(names)
      })

      // Make commercial names available to macros
      for (const component of componentsToEnrich) {
        if (component.latest?.asciidoc?.attributes) {
          component.latest.asciidoc.attributes.commercialNamesMap = commercialNamesObj
        }
      }

      logger.info(`Successfully processed ${parsedData.data.length} connectors from CSV`)
    } catch (error) {
      logger.error(`Error fetching or parsing CSV data: ${error.message}`)
      logger.error(error.stack)
      // Don't throw - allow build to continue with degraded functionality
    }
  }

  // Fetch CSV from GitHub or local file (local file for testing/override only)
  async function fetchCSV (localPath, connectVersion, logger) {
    // Priority 1: Use explicitly provided CSV path (for testing/override)
    if (localPath && fs.existsSync(localPath)) {
      if (path.extname(localPath).toLowerCase() !== '.csv') {
        throw new Error(`Invalid file type: ${localPath}. Expected a CSV file.`)
      }
      logger.info(`Loading CSV data from local file: ${localPath}`)
      return fs.readFileSync(localPath, 'utf8')
    }

    // Priority 2: Fetch from GitHub using the version tag
    logger.info(`Fetching CSV from GitHub (version: ${connectVersion || 'main'})...`)
    return fetchCsvFromGitHub(connectVersion)
  }

  // Fetch CSV data from GitHub
  async function fetchCsvFromGitHub (connectVersion) {
    const octokit = await loadOctokit()
    // Normalize version: trim whitespace and remove leading 'v' if present
    const normalizedVersion = connectVersion ? connectVersion.trim().replace(/^v/, '') : ''
    // Use version tag if valid, otherwise fallback to main branch
    const ref = normalizedVersion ? `v${normalizedVersion}` : 'main'

    try {
      const { data: fileContent } = await octokit.rest.repos.getContent({
        owner: githubOwner,
        repo: githubRepo,
        path: csvPath,
        ref: ref
      })
      return Buffer.from(fileContent.content, 'base64').toString('utf8')
    } catch (error) {
      logger.error(`Error fetching Redpanda Connect catalog from GitHub (ref: ${ref}): ${error.message}`)
      throw error
    }
  }

  /**
   * Transforms and enriches parsed CSV connector data with normalized fields and documentation URLs.
   * Uses O(n) lookup maps for efficient page matching.
   */
  function translateCsvData (parsedData, pages, logger) {
    // Build lookup maps once for O(1) access - much faster than O(n) iteration per row
    const connectPages = new Map()
    const cloudPages = new Map()

    for (const file of pages) {
      const { component } = file.src
      const stem = file.src.stem
      const filePath = file.path

      if (component === 'redpanda-connect') {
        // Store by stem, but only for connector doc paths
        if (isConnectorDocPath(filePath, file)) {
          const type = extractTypeFromPath(filePath)
          if (type) {
            const key = `${stem}:${type}`
            connectPages.set(key, file)
          }
        }
      } else if (component === 'redpanda-cloud') {
        // Cloud docs have a specific path pattern
        const cloudMatch = filePath.match(/connect\/components\/([^/]+)s\/([^/]+)\.adoc$/)
        if (cloudMatch) {
          const [, type, name] = cloudMatch
          const key = `${name}:${type}`
          cloudPages.set(key, file)
        }
      }
    }

    function isConnectorDocPath (filePath) {
      const dirsToCheck = [
        '/pages/inputs/',
        '/pages/outputs/',
        '/pages/processors/',
        '/pages/caches/',
        '/pages/rate_limits/',
        '/pages/buffers/',
        '/pages/metrics/',
        '/pages/tracers/',
        '/pages/scanners/',
        '/partials/components/'
      ]
      return dirsToCheck.some(dir => filePath.includes(dir))
    }

    function extractTypeFromPath (filePath) {
      const typeMatch = filePath.match(/\/(inputs|outputs|processors|caches|rate_limits|buffers|metrics|tracers|scanners)\//)
      if (typeMatch) {
        // Convert plural to singular
        return typeMatch[1].replace(/s$/, '').replace('rate_limit', 'rate_limit')
      }
      return null
    }

    return parsedData.data.map(row => {
      // Create a new object with trimmed keys and values
      const trimmedRow = Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key.trim(), (value || '').trim()])
      )

      // Map fields from the trimmed row to the desired output
      const connector = trimmedRow.name
      const type = trimmedRow.type
      const commercialName = trimmedRow.commercial_name
      const availableConnectVersion = trimmedRow.version
      const deprecated = (trimmedRow.deprecated || '').toLowerCase() === 'y' ? 'y' : 'n'
      const isCloudSupported = (trimmedRow.cloud || '').toLowerCase() === 'y' ? 'y' : 'n'
      const cloudAi = (trimmedRow.cloud_with_gpu || '').toLowerCase() === 'y' ? 'y' : 'n'

      // Handle enterprise to certified conversion and set enterprise license flag
      const originalSupport = (trimmedRow.support || '').toLowerCase()
      const supportLevel = originalSupport === 'enterprise' ? 'certified' : originalSupport
      const isLicensed = originalSupport === 'enterprise' ? 'Yes' : 'No'

      // O(1) lookup for URLs
      const lookupKey = `${connector}:${type}`
      const connectPage = connectPages.get(lookupKey)
      const cloudPage = cloudPages.get(lookupKey)

      const redpandaConnectUrl = connectPage?.pub?.url || ''
      const redpandaCloudUrl = cloudPage?.pub?.url || ''

      // Warn about missing docs (but not for deprecated or SQL drivers)
      if (deprecated !== 'y' && !connector.includes('sql_driver')) {
        if (!redpandaConnectUrl) {
          logger.warn(`Self-Managed docs missing for: ${connector} of type: ${type}`)
        }
        if (isCloudSupported === 'y' && !redpandaCloudUrl && redpandaConnectUrl) {
          logger.warn(`Cloud docs missing for: ${connector} of type: ${type}`)
        }
      }

      return {
        connector,
        type,
        commercial_name: commercialName,
        available_connect_version: availableConnectVersion,
        support_level: supportLevel,
        deprecated,
        is_cloud_supported: isCloudSupported,
        cloud_ai: cloudAi,
        is_licensed: isLicensed,
        redpandaConnectUrl,
        redpandaCloudUrl
      }
    })
  }

  /**
   * Enriches component pages with commercial names from CSV data and existing AsciiDoc attributes.
   */
  function enrichPagesWithCommercialNames (pages, parsedData, logger) {
    // Build a lookup map: connector name -> Set of commercial names from CSV
    const csvCommercialNames = new Map()

    for (const row of parsedData.data) {
      const { connector, commercial_name: commercialName } = row
      if (!connector || !commercialName) continue

      // Skip N/A and empty values
      const trimmedName = commercialName.trim()
      if (trimmedName.toLowerCase() === 'n/a' || trimmedName === '') continue

      if (!csvCommercialNames.has(connector)) {
        csvCommercialNames.set(connector, new Set())
      }

      // Add the commercial name if it's different from the connector name
      if (trimmedName.toLowerCase() !== connector.toLowerCase()) {
        csvCommercialNames.get(connector).add(trimmedName)
      }
    }

    // Enrich each component page with combined commercial names
    let enrichedCount = 0

    for (const page of pages) {
      const { component, relative, module: moduleName } = page.src

      // Only process Redpanda Connect and Cloud component pages
      if (component !== 'redpanda-connect' && component !== 'redpanda-cloud') continue

      // Match component documentation pages:
      // 1. Cloud-style paths: connect/components/processors/archive.adoc
      // 2. Connect module-based paths: module=components, relative=processors/archive.adoc
      const isComponentsModule = moduleName === 'components'
      const hasComponentsInPath = relative.includes('/components/')

      if (!isComponentsModule && !hasComponentsInPath) continue

      // Extract connector name from path
      let connectorMatch
      if (hasComponentsInPath) {
        connectorMatch = relative.match(/\/components\/[^/]+\/([^/]+)\.adoc$/)
      } else if (isComponentsModule) {
        connectorMatch = relative.match(/^[^/]+\/([^/]+)\.adoc$/)
      }

      if (!connectorMatch) continue

      const connectorName = connectorMatch[1]
      const csvNames = csvCommercialNames.get(connectorName) || new Set()

      // Get existing commercial names from AsciiDoc page attribute
      let existingNames = []
      const existingAttr = page.asciidoc?.attributes?.['page-commercial-names']

      if (existingAttr) {
        existingNames = existingAttr.split(',').map(n => n.trim()).filter(n => n)
      } else if (page.contents) {
        // Fallback: parse from file contents if attribute not yet available
        // Note: This regex handles single-line attributes only
        const fileContents = page.contents.toString('utf8')
        const attrMatch = fileContents.match(/:page-commercial-names:\s*(.+)/)
        if (attrMatch) {
          existingNames = attrMatch[1].split(',').map(n => n.trim()).filter(n => n)
        }
      }

      // Combine CSV names and existing names, deduplicate
      const allNames = new Set([...csvNames, ...existingNames])

      if (allNames.size > 0) {
        // Ensure attributes object exists
        if (!page.asciidoc) page.asciidoc = {}
        if (!page.asciidoc.attributes) page.asciidoc.attributes = {}

        // Set the combined commercial names as a comma-separated list
        const commercialNamesList = Array.from(allNames).join(', ')
        page.asciidoc.attributes['page-commercial-names'] = commercialNamesList
        enrichedCount++

        // Update the mapping with the enriched names
        csvCommercialNames.set(connectorName, allNames)

        logger.debug(`Added commercial names to ${connectorName}: ${commercialNamesList}`)
      }
    }

    logger.info(`Enriched ${enrichedCount} component pages with commercial names`)

    return csvCommercialNames
  }
}
