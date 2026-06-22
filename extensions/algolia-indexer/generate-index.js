'use strict'

const { parse } = require('node-html-parser')
const { decode } = require('html-entities')
const path = require('path')

// Create encoder once at module scope for efficiency
const textEncoder = new TextEncoder()

/**
 * Generates an Algolia index:
 *
 * Iterates over the specified pages and creates the indexes.
 *
 * @memberof algolia-indexer
 *
 * @param {Object} playbook - The configuration object for Antora.
 * @param {Object} contentCatalog - The Antora content catalog, with pages and metadata.
 * @param {Object} [config={}] - Configuration options
 * @param {Boolean} config.indexLatestOnly - If true, only index the latest version of any given page.
 * @param {Array} config.excludes - CSS selectors for elements to exclude from indexing.
 * @param {Object} config.logger - Logger to use
 * @typedef {Object} SearchIndexData
 * @returns {SearchIndexData} A data object that contains the Algolia index
 */
function generateIndex (playbook, contentCatalog, { indexLatestOnly = false, excludes = [], logger } = {}) {
  // Use provided logger or create a no-op logger for tests
  if (!logger) {
    logger = process.env.NODE_ENV === 'test'
      ? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
      : console
  }

  const algolia = {}

  logger.info('Starting Algolia index generation...')
  const unixTimestamp = Math.floor(Date.now() / 1000)

  // Select indexable pages
  const pages = contentCatalog.getPages((page) => {
    // Skip pages without output, noindex pages, and field-only pages (internal includes)
    if (!page.out || page.asciidoc?.attributes?.noindex != null || page.isFieldOnlyPage) return
    return {}
  })

  if (!pages.length) {
    logger.warn('No pages found to index')
    return {}
  }

  // Handle the site URL
  let siteUrl = playbook.site.url || ''
  if (siteUrl.endsWith('/')) {
    siteUrl = siteUrl.slice(0, -1)
  }
  const urlPath = extractUrlPath(siteUrl)

  let algoliaCount = 0

  for (const page of pages) {
    const root = parse(
      page.contents,
      {
        blockTextElements: {
          code: true
        }
      }
    )

    // Compute a flag identifying if the current page is in the
    // "current" component version.
    // When indexLatestOnly is set, we only index the current version.
    const component = contentCatalog.getComponent(page.src.component)
    const thisVersion = contentCatalog.getComponentVersion(component, page.src.version)
    const latestVersion = component.latest
    const isCurrent = thisVersion === latestVersion

    if (indexLatestOnly && !isCurrent) continue

    // Capture the component name and version
    const cname = component.name
    const version = page.src.origin?.descriptor?.prerelease
      ? page.src.origin.descriptor.displayVersion
      : page.src.version

    // Handle the page keywords
    const kwElement = root.querySelector('meta[name=keywords]')
    let keywords = []
    if (kwElement) {
      const kwContent = kwElement.getAttribute('content')
      keywords = kwContent ? kwContent.split(/,\s*/) : []
    }

    // Gather page breadcrumbs
    const breadcrumbs = []
    root.querySelectorAll('nav.breadcrumbs > ul > li a')
      .forEach((elem) => {
        const url = path.resolve(
          path.join('/', page.out.dirname),
          elem.getAttribute('href')
        )
        breadcrumbs.push({
          u: url,
          t: elem.text
        })
      })

    // Start handling the article content
    const article = root.querySelector('article.doc')
    let documentTitle, titles, intro, text, isLandingPage

    if (!article) {
      // Check if this is a landing page we should index with metadata
      const pageRole = page.asciidoc?.attributes?.['page-role'] || ''
      const pageLayout = page.asciidoc?.attributes?.['page-layout'] || ''
      const isUmbrellaPage = ['home', 'component-home-v3', 'data-platform'].includes(pageRole) ||
                            ['home', 'component-home-v3', 'data-platform'].includes(pageLayout)

      if (!isUmbrellaPage) {
        logger.warn(`Page is not an article...skipping ${page.pub.url}`)
        continue
      }

      // Index landing page using metadata
      isLandingPage = true
      const h1 = root.querySelector('h1') || root.querySelector('.hero-title') || root.querySelector('title')
      documentTitle = h1 ? decode(h1.text || h1.textContent || '') : component.title || cname
      titles = []

      // Get description from meta tag or page attribute
      const metaDesc = root.querySelector('meta[name="description"]')
      intro = metaDesc ? metaDesc.getAttribute('content') :
              page.asciidoc?.attributes?.description || ''
      text = intro
      logger.info(`Indexing landing page: ${page.pub.url}`)
    } else {
      isLandingPage = false

      // Handle titles
      const h1 = article.querySelector('h1')
      if (!h1) {
        logger.warn(`No H1 in ${page.pub.url}...skipping`)
        continue
      }
      documentTitle = h1.text
      h1.remove()

      titles = []
      article.querySelectorAll('h2,h3,h4,h5,h6').forEach((title) => {
        const id = title.getAttribute('id')
        if (id) {
          titles.push({
            t: title.text,
            h: id
          })
        }
        title.remove()
      })

      // Exclude elements within the article that should not be indexed
      for (const excl of excludes) {
        if (!excl) continue
        article.querySelectorAll(excl).forEach((e) => e.remove())
      }

      // FIXED: Handle potential null intro element
      const introElement = article.querySelector('p')
      intro = introElement ? decode(introElement.rawText) : ''
    }

    // Establish structure in the Algolia index
    if (!(cname in algolia)) algolia[cname] = {}
    if (!(version in algolia[cname])) algolia[cname][version] = []

    // Check if this is a properties reference page (or has many titles)
    const isPropertiesPage = page.pub.url.includes('/properties/') || titles.length > 30

    // Handle the article text (skip for landing pages - already set above)
    if (!isLandingPage) {
      text = ''
    }

    if (!isLandingPage && !isPropertiesPage && article) {
      // For normal pages, index full text content
      const contentElements = article.querySelectorAll('p, table, li')
      let contentText = ''
      let currentSize = 0
      // Maximum size in bytes (Algolia's limit is 100KB, using 50KB for safety)
      const MAX_SIZE = 50000

      for (const element of contentElements) {
        let elementText = ''
        if (element.tagName === 'TABLE') {
          for (const tr of element.querySelectorAll('tr')) {
            for (const cell of tr.querySelectorAll('td, th')) {
              elementText += cell.textContent + ' '
            }
          }
        } else {
          elementText = element.textContent
        }

        const elementSize = textEncoder.encode(elementText).length
        if (currentSize + elementSize > MAX_SIZE) {
          break
        }

        contentText += elementText
        currentSize += elementSize
      }

      text = contentText.replace(/\n/g, ' ')
        .replace(/\r/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    } else if (!isLandingPage && isPropertiesPage) {
      // For long pages, only use intro as text (property names are already in titles array)
      text = intro
      logger.info(`Skipping full text indexing for long page: ${page.pub.url} (${titles.length} properties)`)
    }
    // For landing pages, text is already set above

    let tag
    const title = (component.title || '').trim()
    const titleLower = title.toLowerCase()

    // Umbrella components that should include multiple product tags
    const UMBRELLA_COMPONENTS = ['home', 'data platform', 'self-managed']

    if (UMBRELLA_COMPONENTS.includes(titleLower)) {
      // Collect all unique component titles except umbrella/utility components
      const componentsList = typeof contentCatalog.getComponents === 'function'
        ? contentCatalog.getComponents()
        : Array.isArray(contentCatalog.components)
          ? contentCatalog.components
          : Object.values(contentCatalog.components || contentCatalog._components || {})

      // Find the latest version for Streaming
      let streamingLatestVersion
      const streaming = componentsList.find(c => (c.title || '').trim().toLowerCase() === 'streaming')
      if (streaming?.latest?.version) {
        streamingLatestVersion = streaming.latest.version
        if (streamingLatestVersion && !/^v/.test(streamingLatestVersion)) {
          streamingLatestVersion = 'v' + streamingLatestVersion
        }
      }

      // Filter components based on umbrella type
      let filteredTitles
      if (titleLower === 'home') {
        // Home includes all main products
        filteredTitles = componentsList
          .map(c => (c.title || '').trim())
          .filter(t => t && !['home', 'shared', 'search', 'data platform', 'self-managed'].includes(t.toLowerCase()))
      } else if (titleLower === 'data platform') {
        // Data Platform includes Cloud, Streaming, Connect
        filteredTitles = ['Cloud', 'Streaming', 'Connect']
      } else if (titleLower === 'self-managed') {
        // Self-Managed includes Streaming, Connect
        filteredTitles = ['Streaming', 'Connect']
      }

      if (!filteredTitles || !filteredTitles.length) {
        // Fallback to component title
        tag = title
      } else {
        tag = [...new Set(filteredTitles)]
        // For Streaming, append v<latest-version> to the tag
        if (streamingLatestVersion) {
          tag = tag.map(t => t.toLowerCase() === 'streaming' ? `${t} ${streamingLatestVersion}` : t)
        }
      }
    } else {
      tag = `${title}${version ? ' v' + version : ''}`
    }

    const deployment = page.asciidoc?.attributes['env-kubernetes']
      ? 'Kubernetes'
      : page.asciidoc?.attributes['env-linux']
        ? 'Linux'
        : page.asciidoc?.attributes['env-docker']
          ? 'Docker'
          : page.asciidoc?.attributes['page-cloud']
            ? 'Redpanda Cloud'
            : ''

    const categories = page.asciidoc?.attributes['page-categories']
      ? page.asciidoc.attributes['page-categories'].split(',').map(category => category.trim())
      : []

    const commercialNames = page.asciidoc?.attributes['page-commercial-names']
      ? page.asciidoc.attributes['page-commercial-names'].split(',').map(name => name.trim())
      : []

    // Algolia only indexes roughly the first ~290 words of any single record. On
    // long reference pages (cluster/topic properties, metrics) every property or
    // metric name lives in the `titles` array, and there can be hundreds of them, so
    // every name past that window is stored but NOT searchable (DOC-1878). Split the
    // titles of such pages across multiple records, each small enough to be fully
    // indexed. Normal pages keep a single record. Chunks after the first get a unique
    // objectID anchored to their first heading so search results deep-link into the
    // page; the first chunk keeps the page's base objectID.
    const baseObjectID = urlPath + page.pub.url
    const titleChunks = isPropertiesPage ? chunkTitles(titles) : [titles]

    titleChunks.forEach((chunk, chunkIndex) => {
      const objectID = chunkIndex === 0
        ? baseObjectID
        : `${baseObjectID}#${chunk[0].h}`

      // keywords included in index item
      const indexItem = {
        title: documentTitle,
        version: version,
        text: text,
        intro: intro,
        objectID: objectID,
        // Clean page path (no #fragment) shared by every chunk of a page. The search
        // UI builds result links from `url` and appends its own matched-heading
        // anchor, so chunk objectIDs (which carry a #anchor for uniqueness) must not
        // be used for the href. `url` is also the attribute to dedupe chunks on.
        url: baseObjectID,
        titles: chunk,
        keywords: keywords,
        categories: categories,
        commercialNames: commercialNames,
        unixTimestamp: unixTimestamp
      }

      if (component.name !== 'labs') {
        indexItem.product = component.title
        indexItem.breadcrumbs = breadcrumbs
        indexItem.type = 'Doc'
        indexItem._tags = Array.isArray(tag) ? tag : [tag]
      } else {
        indexItem.deployment = deployment
        indexItem.type = 'Lab'
        indexItem.interactive = false
        indexItem._tags = Array.isArray(tag) ? tag : [tag]
      }

      algolia[cname][version].push(indexItem)
      algoliaCount++
    })
  }

  logger.info(`Indexed ${algoliaCount} pages`)
  return algolia
}

/**
 * Split a titles array into chunks whose combined token count stays within
 * Algolia's per-record indexing window (~290 words; we leave a safety margin).
 * Each returned chunk is small enough that every heading it contains is actually
 * indexed for search, which keeps property/metric names on long reference pages
 * searchable (DOC-1878).
 *
 * @param {Array<{t: string, h: string}>} titles - Section headings for a page.
 * @param {number} [maxTokens=180] - Approximate token budget per chunk.
 * @returns {Array<Array<{t: string, h: string}>>} One or more title chunks. An
 *   empty input yields a single empty chunk so the page still gets a record.
 */
function chunkTitles (titles, maxTokens = 180) {
  if (!titles.length) return [[]]
  const chunks = []
  let current = []
  let tokens = 0
  for (const entry of titles) {
    // Algolia tokenizes on separators (whitespace, underscores, dots, etc.), so a
    // name like `partition_autobalancing_mode` counts as several tokens.
    const entryTokens = String(entry.t || '').split(/[\s_./:-]+/).filter(Boolean).length || 1
    if (current.length && tokens + entryTokens > maxTokens) {
      chunks.push(current)
      current = []
      tokens = 0
    }
    current.push(entry)
    tokens += entryTokens
  }
  if (current.length) chunks.push(current)
  return chunks
}

/**
 * Extract the path from a URL
 * @param {string} url - The URL to extract path from
 * @returns {string} The URL path
 */
function extractUrlPath (url) {
  if (!url) return ''
  if (url.charAt(0) === '/') return url

  try {
    // FIXED: Use modern URL API instead of deprecated url.parse()
    const urlPath = new URL(url).pathname
    return urlPath === '/' ? '' : urlPath
  } catch {
    return ''
  }
}

module.exports = generateIndex
