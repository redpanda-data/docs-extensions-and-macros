'use strict'

/**
 * Adds markdown URL entries to sitemap.xml files for AI-friendly documentation.
 *
 * This extension enhances Antora's generated sitemaps by adding <url> entries
 * for markdown versions of pages alongside the HTML versions. This improves
 * compatibility with agent-friendly documentation tools that expect markdown
 * URLs to be discoverable in sitemaps.
 *
 * The extension:
 * - Finds all sitemap XML files in the site catalog
 * - For each HTML URL entry, adds a corresponding .md URL entry
 * - Preserves lastmod dates from the HTML versions
 * - Works with both main sitemaps and component-specific sitemaps
 *
 * @see https://agentdocsspec.com/spec/#llms-txt-freshness
 */

const { parseStringPromise } = require('xml2js')
const { toMarkdownUrl } = require('../extension-utils/url-utils')

module.exports.register = function () {
  const logger = this.getLogger('add-markdown-urls-to-sitemap-extension')

  this.on('beforePublish', async ({ siteCatalog }) => {
    try {
      // Find all sitemap XML files
      // Includes both sitemap.xml (single component) and sitemap-*.xml (multiple components)
      const sitemapFiles = siteCatalog.getFiles().filter(file => {
        const path = file.out.path
        // Include sitemap.xml OR sitemap-*.xml (but not the sitemap index which would be handled separately)
        return path.endsWith('.xml') && (path === 'sitemap.xml' || path.startsWith('sitemap-'))
      })

      if (sitemapFiles.length === 0) {
        logger.info('No component sitemap files found')
        return
      }

      logger.info(`Processing ${sitemapFiles.length} sitemap file(s)...`)
      let totalAdded = 0

      for (const sitemapFile of sitemapFiles) {
        const added = await addMarkdownUrlsToSitemap(sitemapFile, logger)
        totalAdded += added
      }

      logger.info(`Added ${totalAdded} markdown URL entries across ${sitemapFiles.length} sitemap(s)`)
    } catch (error) {
      logger.error(`Failed to add markdown URLs to sitemaps: ${error.message}`)
      // Don't throw - sitemap enhancement is not critical
    }
  })
}

/**
 * Add markdown URL entries to a single sitemap file
 * @param {Object} sitemapFile - The sitemap file from site catalog
 * @param {Object} logger - Logger instance
 * @returns {number} Number of markdown URLs added
 */
async function addMarkdownUrlsToSitemap(sitemapFile, logger) {
  try {
    const xmlContent = sitemapFile.contents.toString('utf8')
    const parsed = await parseStringPromise(xmlContent, {
      explicitArray: true,
      xmlns: false,  // Don't create namespace objects
      tagNameProcessors: [],  // Keep tag names as-is
    })

    if (!parsed || !parsed.urlset || !parsed.urlset.url) {
      logger.debug(`No URLs found in ${sitemapFile.out.path}`)
      return 0
    }

    const urlEntries = parsed.urlset.url
    const newEntries = []

    // For each HTML URL, create a markdown URL entry
    for (const entry of urlEntries) {
      if (!entry.loc || !entry.loc[0]) continue

      // xml2js might parse loc as object or string, handle both
      let htmlUrl = entry.loc[0]
      if (typeof htmlUrl === 'object' && htmlUrl._) {
        htmlUrl = htmlUrl._
      }

      if (typeof htmlUrl !== 'string') {
        logger.debug(`Skipping non-string URL: ${JSON.stringify(htmlUrl)}`)
        continue
      }

      // Skip if it's already a markdown URL or special file
      if (htmlUrl.endsWith('.md') || htmlUrl.endsWith('.txt') || htmlUrl.endsWith('.xml')) {
        continue
      }

      // Convert HTML URL to markdown URL
      const urlObj = new URL(htmlUrl)
      const mdPath = toMarkdownUrl(urlObj.pathname)
      const mdUrl = `${urlObj.origin}${mdPath}`

      // Create new entry for markdown URL with same lastmod
      const mdEntry = {
        loc: [mdUrl],
      }

      if (entry.lastmod && entry.lastmod[0]) {
        mdEntry.lastmod = entry.lastmod
      }

      newEntries.push(mdEntry)
    }

    if (newEntries.length === 0) {
      logger.debug(`No markdown URLs to add for ${sitemapFile.out.path}`)
      return 0
    }

    // Add markdown entries to the sitemap
    parsed.urlset.url.push(...newEntries)

    // Rebuild XML with xml2js builder
    const builder = new (require('xml2js')).Builder({
      xmldec: { version: '1.0', encoding: 'UTF-8' },
      xmlns: true,
      renderOpts: {
        pretty: true,
        indent: '  ',
      },
    })

    const newXml = builder.buildObject(parsed)

    // Update the file contents
    sitemapFile.contents = Buffer.from(newXml, 'utf8')

    logger.debug(`Added ${newEntries.length} markdown URLs to ${sitemapFile.out.path}`)
    return newEntries.length
  } catch (error) {
    logger.error(`Error processing ${sitemapFile.out.path}: ${error.message}`)
    return 0
  }
}
