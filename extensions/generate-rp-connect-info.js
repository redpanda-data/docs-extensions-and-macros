'use strict'

const { raiseListenerLimit } = require('./util/raise-listener-limit')
const fs = require('fs')
const path = require('path')
const Papa = require('papaparse')
const catalogUtil = require('./util/connect-catalog')

// Default configuration - can be overridden via playbook config
const DEFAULTS = {
  csvPath: 'internal/plugins/info.csv',
  githubOwner: 'redpanda-data',
  githubRepo: 'connect'
}

// Generated sets that connector pages include, by Antora family. Each one
// must be present, or pages publish with unresolved includes.
// The generated partial and example directories that connector pages include,
// read from the pages themselves, so the guard asks for exactly what the pages
// in this build use (rp-connect-docs pages gain availability includes, for
// example, when they move to the generated docs).
const PARTIAL_INCLUDE = /include::connect:components:partial\$([a-z0-9_-]+)\//g
const EXAMPLE_INCLUDE = /include::(?:connect:)?components:example\$([a-z0-9_-]+)\//g

function includedDirs (pages) {
  const partial = new Set()
  const example = new Set()
  for (const page of pages) {
    const text = page.contents ? page.contents.toString() : ''
    for (const m of text.matchAll(PARTIAL_INCLUDE)) partial.add(m[1])
    for (const m of text.matchAll(EXAMPLE_INCLUDE)) example.add(m[1])
  }
  // Name the core sets first, in a fixed order, so the error reads the same
  // way every time.
  const order = ['fields', 'descriptions', 'availability', 'metadata', 'examples', 'common', 'advanced']
  const rank = (d) => (order.includes(d) ? order.indexOf(d) : order.length)
  const sorted = (set) => [...set].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  return { partial: sorted(partial), example: sorted(example) }
}

// Connector pages include the generated field reference, description meta,
// availability, and config examples, which the modify-connect-tag-playbook
// extension adds from the redpanda-connect-docs.tar.gz asset of a connect
// release. If a playbook has the Connect pages but any set is missing (an
// incomplete asset, or a connect source whose ref lacks them), connector
// pages would publish with unresolved includes, and Antora only logs them.
// Fail the build instead so the playbook gets fixed before anything is
// published.
//
// `connectSources` are the connect content sources still in the playbook,
// which means no release asset was downloaded.
function assertConnectReferencePresent (contentCatalog, { connectSources = [] } = {}) {
  const component = contentCatalog.getComponents().find((c) => c.name === 'connect')
  if (!component) return
  // Only connector pages (inputs/kafka.adoc and so on) include the generated
  // sets. Overview pages at the module root don't.
  const pages = contentCatalog.findBy({ component: 'connect', module: 'components', family: 'page' })
    .filter((p) => p.src.relative.includes('/'))
  if (!pages.length) return
  const missingIn = (family, dirs) => {
    const files = contentCatalog.findBy({ component: 'connect', module: 'components', family })
    return dirs.filter((dir) => !files.some((f) => f.src.relative.startsWith(`${dir}/`)))
      .map((dir) => `components:${family}$${dir}/*`)
  }
  const wanted = includedDirs(pages)
  const missing = [...missingIn('partial', wanted.partial), ...missingIn('example', wanted.example)]
  if (!missing.length) return
  const sourceHint = connectSources.length
    ? `The playbook lists a connect content source (${connectSources.join(', ')}), so no release asset was downloaded and these files must come from that source's refs. ` +
      'Point it at a ref that has the generated docs, or remove it to use the release asset. '
    : ''
  throw new Error(
    `The connect component has connector pages but no generated ${missing.join(' or ')} files. ` +
    sourceHint +
    'These come from the redpanda-connect-docs.tar.gz asset of a Redpanda Connect release, which the ' +
    'modify-connect-tag-playbook extension downloads. Register that extension and check its log: ' +
    'the release it used (the latest stable release, or the one in its `tag` config) may have no asset or an incomplete one. ' +
    'Set `tag` to a release that has the asset, or set REDPANDA_CONNECT_DOCS_DIR to a local directory that contains ' +
    'modules/ (for example a connect checkout\'s docs/ after running its docs generator).'
  )
}

// The connect content sources in a playbook, with credentials removed.
function connectSourcesOf (playbook) {
  const sources = (playbook && playbook.content && playbook.content.sources) || []
  return sources
    .filter((s) => catalogUtil.isConnectSource(s.url))
    .map((s) => String(s.url).replace(/([a-z][a-z+.-]*:\/\/)[^@/\s]*@/gi, '$1'))
}

module.exports.assertConnectReferencePresent = assertConnectReferencePresent

module.exports.register = function ({ config }) {
  raiseListenerLimit(this)
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

  function loadOctokit () {
    // Use shared Octokit client
    return require('../cli-utils/octokit-client')
  }

  // Translated CSV rows, kept for the documentsConverted hook below
  let translatedRows = null

  // Use 'on' and return the promise so Antora waits for async completion
  this.on('contentClassified', ({ contentCatalog, playbook }) => {
    assertConnectReferencePresent(contentCatalog, { connectSources: connectSourcesOf(playbook) })
    return processContent(contentCatalog)
  })

  // Set sticky-bar page attributes (type context switcher and availability badges) so the UI
  // templates (article.hbs) render them server-side, with no flash of client-side rearranging.
  // This must run on documentsConverted: Antora extracts page attributes for UI templates in a
  // header-only parse with Asciidoctor extensions disabled, so these attributes cannot be set
  // from the component_type_dropdown macro during conversion. Mutating page.asciidoc.attributes
  // after conversion is the supported way to feed computed attributes to UI templates.
  this.on('documentsConverted', ({ contentCatalog }) => {
    if (!translatedRows) return
    setStickyBarPageAttributes(contentCatalog, translatedRows, logger)
  })

  async function processContent (contentCatalog) {
    const redpandaConnect = contentCatalog.getComponents().find(component => component.name === 'connect')
    const redpandaCloud = contentCatalog.getComponents().find(component => component.name === 'cloud-data-platform')
    const preview = contentCatalog.getComponents().find(component => component.name === 'preview')

    if (!redpandaConnect) {
      logger.warn('connect component not found, skipping CSV enrichment')
      return
    }

    const pages = contentCatalog.getPages()

    try {
      const rawRows = await loadCatalogRows(contentCatalog)
      const parsedData = { data: rawRows }
      const enrichedData = translateCsvData(parsedData, pages, logger)
      parsedData.data = enrichedData
      translatedRows = enrichedData

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

  // Raw catalog rows (info.csv column names) for this build.
  //
  // The generated partials/platforms/catalog.json from connect (the release
  // asset, or a connect content source) comes first: it is from the same ref
  // as the reference content
  // and carries status, categories, and cgo data that info.csv lacks. info.csv
  // still supplies the SQL driver rows, which are not components and so are
  // not in the catalog. Without catalog.json, info.csv supplies every row.
  async function loadCatalogRows (contentCatalog) {
    const catalogFile = catalogUtil.findConnectCatalogFile(contentCatalog)
    let catalogRows = null
    if (catalogFile) {
      try {
        catalogRows = catalogUtil.catalogEntriesToCsvRows(JSON.parse(catalogFile.contents.toString('utf8')))
        logger.info(`Loaded ${catalogRows.length} components from ${describeFile(catalogFile)}`)
      } catch (error) {
        logger.warn(`Could not read ${describeFile(catalogFile)}, so falling back to info.csv: ${error.message}`)
      }
    }

    let csvRows = []
    try {
      const csvText = await fetchCSV(localCsvPath, contentCatalog)
      csvRows = Papa.parse(csvText, { header: true, skipEmptyLines: true }).data
    } catch (error) {
      if (!catalogRows) throw error
      logger.warn(`Could not fetch info.csv for the SQL driver rows, so the SQL driver support list is empty: ${error.message}`)
    }
    if (!catalogRows) return csvRows
    const isDriver = (row) => String(row.type || '').trim().toLowerCase() === 'sql_driver'
    return [...catalogRows, ...csvRows.filter(isDriver)]
  }

  function describeFile (file) {
    const origin = file.src.origin || {}
    const ref = origin.tag || origin.branch || origin.refname
    return `${file.src.component}:${file.src.module}:partial$${file.src.relative}${ref ? ` (${ref})` : ''}`
  }

  // Fetch CSV from GitHub or local file (local file for testing/override only)
  async function fetchCSV (localPath, contentCatalog) {
    // Priority 1: Use explicitly provided CSV path (for testing/override)
    if (localPath && fs.existsSync(localPath)) {
      if (path.extname(localPath).toLowerCase() !== '.csv') {
        throw new Error(`Invalid file type: ${localPath}. Expected a CSV file.`)
      }
      logger.info(`Loading CSV data from local file: ${localPath}`)
      return fs.readFileSync(localPath, 'utf8')
    }

    // Priority 2: Fetch from GitHub at the connect ref of this build
    const target = resolveCsvRef(contentCatalog)
    logger.info(`Fetching ${csvPath} from ${target.owner}/${target.repo} at ${target.ref} (${target.source})`)
    return fetchCsvFromGitHub(target)
  }

  // The ref to read info.csv from, in order:
  // 1. the tag modify-connect-tag-playbook resolved (for the release asset or
  //    the connect content source)
  // 2. the ref of the connect files in the content catalog
  // 3. latest-connect-version in antora.yml in the working directory
  // 4. main, with a warning, because the catalog can then disagree with the
  //    reference content
  function resolveCsvRef (contentCatalog) {
    const base = { owner: githubOwner, repo: githubRepo }
    const shared = catalogUtil.getResolvedConnectRef()
    if (shared) return { ...base, ref: shared, source: 'the tag modify-connect-tag-playbook resolved' }
    const origin = catalogUtil.connectOriginRef(contentCatalog)
    if (origin && origin.ref) return { ...base, ...origin, source: 'the connect content source' }
    const connectVersion = getAntoraValue('asciidoc.attributes.latest-connect-version')
    const normalizedVersion = connectVersion ? String(connectVersion).trim().replace(/^v/, '') : ''
    if (normalizedVersion) return { ...base, ref: `v${normalizedVersion}`, source: 'latest-connect-version in antora.yml' }
    logger.warn(
      'No resolved connect release or latest-connect-version found, so info.csv is read from connect main. ' +
      'Catalog badges can then disagree with the reference content. Register the modify-connect-tag-playbook ' +
      'extension, or set its `tag` config when REDPANDA_CONNECT_DOCS_DIR is set.'
    )
    return { ...base, ref: 'main', source: 'fallback' }
  }

  // Fetch CSV data from GitHub
  async function fetchCsvFromGitHub ({ owner, repo, ref }) {
    const octokit = await loadOctokit()
    try {
      const { data: fileContent } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: csvPath,
        ref
      })
      return Buffer.from(fileContent.content, 'base64').toString('utf8')
    } catch (error) {
      // The caller decides how loud this is: fatal to the catalog without
      // catalog.json, a warning with it.
      error.message = `${owner}/${repo} ${csvPath} at ${ref}: ${error.message}`
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

      if (component === 'connect') {
        // Store by stem, but only for connector doc paths
        if (isConnectorDocPath(filePath, file)) {
          const type = extractTypeFromPath(filePath)
          if (type) {
            const key = `${stem}:${type}`
            connectPages.set(key, file)
          }
        }
      } else if (component === 'cloud-data-platform') {
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
      // Rows from catalog.json also carry arrays (categories, commercial_names)
      const trimmedRow = Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key.trim(), typeof value === 'string' || value == null ? (value || '').trim() : value])
      )

      // Map fields from the trimmed row to the desired output
      const connector = trimmedRow.name
      const type = trimmedRow.type
      const commercialName = trimmedRow.commercial_name
      const availableConnectVersion = trimmedRow.version
      const deprecated = (trimmedRow.deprecated || '').toLowerCase() === 'y' ? 'y' : 'n'
      // is_cloud_supported is the standard Cloud pipeline flag and cloud_ai the
      // GPU pipeline flag. A component in either one is available in Cloud
      // (catalogUtil.isCloudAvailable); gpu_only and no_gpu say which.
      const isCloudSupported = (trimmedRow.cloud || '').toLowerCase() === 'y' ? 'y' : 'n'
      const cloudAi = (trimmedRow.cloud_with_gpu || '').toLowerCase() === 'y' ? 'y' : 'n'
      const cloudAvailable = isCloudSupported === 'y' || cloudAi === 'y'
      const { gpu_only: gpuOnly, no_gpu: noGpu } = catalogUtil.gpuFlags(isCloudSupported, cloudAi)

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
        // Check if this is a cloud-only connector (plugin)
        // Cloud-only connectors (like 'gateway' and 'a2a_message') are plugins that:
        // - Only run in Redpanda Cloud (not in self-managed rpk connect)
        // - Have docs in cloud-docs repo but not in rp-connect-docs pages
        // - Are marked with cloud: y in CSV but don't ship with OSS binary
        const isCloudOnly = cloudAvailable && !redpandaConnectUrl && redpandaCloudUrl

        // Only warn about missing self-managed docs if it's NOT cloud-only
        if (!redpandaConnectUrl && !isCloudOnly) {
          logger.warn(`Self-Managed docs missing for: ${connector} of type: ${type}`)
        }
        if (cloudAvailable && !redpandaCloudUrl && redpandaConnectUrl) {
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
        gpu_only: gpuOnly,
        no_gpu: noGpu,
        is_licensed: isLicensed,
        // From catalog.json only; empty or absent for info.csv rows
        status: trimmedRow.status || (deprecated === 'y' ? 'deprecated' : ''),
        categories: Array.isArray(trimmedRow.categories) ? trimmedRow.categories : undefined,
        commercial_names: Array.isArray(trimmedRow.commercial_names) ? trimmedRow.commercial_names : undefined,
        cgo_only: trimmedRow.cgo_only === 'y' ? 'y' : 'n',
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
      const { connector, commercial_name: commercialName, commercial_names: commercialNames } = row
      if (!connector) continue
      // catalog.json rows list every commercial name; info.csv rows have one
      const names = Array.isArray(commercialNames) && commercialNames.length ? commercialNames : [commercialName]
      for (const name of names) {
        // Skip N/A and empty values
        const trimmedName = String(name || '').trim()
        if (trimmedName.toLowerCase() === 'n/a' || trimmedName === '') continue

        if (!csvCommercialNames.has(connector)) {
          csvCommercialNames.set(connector, new Set())
        }

        // Add the commercial name if it's different from the connector name
        if (trimmedName.toLowerCase() !== connector.toLowerCase()) {
          csvCommercialNames.get(connector).add(trimmedName)
        }
      }
    }

    // Enrich each component page with combined commercial names
    let enrichedCount = 0

    for (const page of pages) {
      const { component, relative, module: moduleName } = page.src

      // Only process Redpanda Connect and Cloud component pages
      if (component !== 'connect' && component !== 'cloud-data-platform') continue

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

  /**
   * Sets sticky-bar metadata attributes on connector pages after conversion, so the UI templates
   * (article.hbs and the context-switcher partial) render the Type dropdown and availability
   * badges server-side:
   * - page-context-switcher: Type dropdown entries (when the connector has multiple types)
   * - page-cloud-available + page-cloud-available-url: on Self-Managed pages with a Cloud variant
   * - page-self-managed-available + page-self-managed-available-url: on Cloud pages with a
   *   Self-Managed variant
   * - page-self-managed-only: on Self-Managed pages whose type is not available in Cloud
   * - page-cloud-gpu-only: on both variants when the type runs only in Cloud GPU pipelines
   * - page-cloud-no-gpu: on both variants when the type runs in Cloud, but not in GPU pipelines
   *
   * Availability is decided per row (name and type), not per connector: the http_server
   * input runs in Cloud and the http_server output does not. Only the Type dropdown is
   * built from all of the connector's rows.
   */
  function setStickyBarPageAttributes (contentCatalog, rows, logger) {
    const pagesByUrl = new Map()
    contentCatalog.getPages((page) => page.out && page.pub && page.asciidoc).forEach((page) => {
      pagesByUrl.set(page.pub.url, page)
    })

    // Group CSV rows by connector name; each row is one type (input, output, and so on)
    const rowsByConnector = new Map()
    for (const row of rows) {
      const connector = (row.connector || '').trim().toLowerCase()
      if (!connector) continue
      if (!rowsByConnector.has(connector)) rowsByConnector.set(connector, [])
      rowsByConnector.get(connector).push(row)
    }

    let decoratedCount = 0
    const setGpuFlags = (attrs, row) => {
      if (row.gpu_only === 'y') attrs['page-cloud-gpu-only'] = 'true'
      if (row.no_gpu === 'y') attrs['page-cloud-no-gpu'] = 'true'
    }
    for (const connectorRows of rowsByConnector.values()) {
      for (const row of connectorRows) {
        const isCloudAvailable = catalogUtil.isCloudAvailable(row)
        // Self-Managed (Connect) variant of this connector page
        const connectPage = row.redpandaConnectUrl && pagesByUrl.get(row.redpandaConnectUrl)
        if (connectPage) {
          const attrs = connectPage.asciidoc.attributes
          if (connectorRows.length > 1) {
            attrs['page-context-switcher'] = buildContextSwitcher(connectorRows, row, 'connect')
          }
          if (isCloudAvailable && row.redpandaCloudUrl) {
            attrs['page-cloud-available'] = 'true'
            attrs['page-cloud-available-url'] = row.redpandaCloudUrl
            setGpuFlags(attrs, row)
          } else if (!isCloudAvailable) {
            attrs['page-self-managed-only'] = 'true'
          }
          decoratedCount++
        }
        // Cloud variant of this connector page
        const cloudPage = row.redpandaCloudUrl && pagesByUrl.get(row.redpandaCloudUrl)
        if (cloudPage) {
          const attrs = cloudPage.asciidoc.attributes
          if (connectorRows.length > 1) {
            attrs['page-context-switcher'] = buildContextSwitcher(connectorRows, row, 'cloud')
          }
          if (row.redpandaConnectUrl) {
            attrs['page-self-managed-available'] = 'true'
            attrs['page-self-managed-available-url'] = row.redpandaConnectUrl
          }
          setGpuFlags(attrs, row)
          decoratedCount++
        }
      }
    }
    logger.info(`Set sticky-bar metadata attributes on ${decoratedCount} connector pages`)
  }

  /**
   * Builds the page-context-switcher JSON: one Type dropdown entry per connector type, linking to
   * that type's page in the current site variant. The current page's type is listed first.
   */
  function buildContextSwitcher (connectorRows, currentRow, variant) {
    const capitalize = (value) => value.charAt(0).toUpperCase() + value.slice(1)
    const orderedRows = [currentRow, ...connectorRows.filter((row) => row !== currentRow)]
    // The process-context-switcher extension and the UI's context-switcher partial
    // both expect an array of { name, to } items; `to` is a root-relative pub URL.
    const items = []
    for (const row of orderedRows) {
      const link = (variant === 'cloud' && row.redpandaCloudUrl) || row.redpandaConnectUrl
      if (!link) continue
      const type = row.type.trim()
      // First occurrence wins: orderedRows puts the current page's row first,
      // so a connector with duplicate types keeps its own entry. (The old
      // object-keyed build let later rows overwrite earlier ones.)
      if (items.some((item) => item.name === capitalize(type))) continue
      items.push({ name: capitalize(type), to: link })
    }
    return JSON.stringify(items)
  }
}
