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
    if (!page.out || page.asciidoc?.attributes?.noindex != null) return
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

    // Handle the page keywords - FIXED: now added to index
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
    if (!article) {
      logger.warn(`Page is not an article...skipping ${page.pub.url}`)
      continue
    }

    // Handle titles
    const h1 = article.querySelector('h1')
    if (!h1) {
      logger.warn(`No H1 in ${page.pub.url}...skipping`)
      continue
    }
    const documentTitle = h1.text
    h1.remove()

    const titles = []
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
    const intro = introElement ? decode(introElement.rawText) : ''

    // Establish structure in the Algolia index
    if (!(cname in algolia)) algolia[cname] = {}
    if (!(version in algolia[cname])) algolia[cname][version] = []

    // Check if this is a properties reference page (or has many titles)
    const isPropertiesPage = page.pub.url.includes('/properties/') || titles.length > 30

    // Handle the article text
    let text = ''

    if (!isPropertiesPage) {
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
    } else {
      // For long pages, only use intro as text (property names are already in titles array)
      text = intro
      logger.info(`Skipping full text indexing for long page: ${page.pub.url} (${titles.length} properties)`)
    }

    let tag
    const title = (component.title || '').trim()
    if (title.toLowerCase() === 'home') {
      // Collect all unique component titles except 'home', 'shared', 'search'
      const componentsList = typeof contentCatalog.getComponents === 'function'
        ? contentCatalog.getComponents()
        : Array.isArray(contentCatalog.components)
          ? contentCatalog.components
          : Object.values(contentCatalog.components || contentCatalog._components || {})

      // Find the latest version for Self-Managed (component title: 'Self-Managed')
      let selfManagedLatestVersion
      const selfManaged = componentsList.find(c => (c.title || '').trim().toLowerCase() === 'self-managed')
      if (selfManaged?.latest?.version) {
        selfManagedLatestVersion = selfManaged.latest.version
        if (selfManagedLatestVersion && !/^v/.test(selfManagedLatestVersion)) {
          selfManagedLatestVersion = 'v' + selfManagedLatestVersion
        }
      }

      const allComponentTitles = componentsList
        .map(c => (c.title || '').trim())
        .filter(t => t && !['home', 'shared', 'search'].includes(t.toLowerCase()))

      if (!allComponentTitles.length) {
        throw new Error('No component titles found for "home" page. Indexing aborted.')
      }

      tag = [...new Set(allComponentTitles)]
      // For Self-Managed, append v<latest-version> to the tag
      if (selfManagedLatestVersion) {
        tag = tag.map(t => t.toLowerCase() === 'self-managed' ? `${t} ${selfManagedLatestVersion}` : t)
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

    // FIXED: keywords now included in index item
    const indexItem = {
      title: documentTitle,
      version: version,
      text: text,
      intro: intro,
      objectID: urlPath + page.pub.url,
      titles: titles,
      keywords: keywords,
      categories: categories,
      commercialNames: commercialNames,
      unixTimestamp: unixTimestamp
    }

    if (component.name !== 'redpanda-labs') {
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
  }

  logger.info(`Indexed ${algoliaCount} pages`)
  return algolia
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
