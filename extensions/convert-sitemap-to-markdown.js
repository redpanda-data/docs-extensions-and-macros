/**
 * Antora extension that generates markdown versions of sitemap.xml files.
 *
 * For each sitemap.xml in the published site, creates a corresponding sitemap.md
 * with a human-readable and AI-friendly markdown format.
 *
 * Usage in playbook:
 * ```yaml
 * antora:
 *   extensions:
 *   - require: '@redpanda-data/docs-extensions-and-macros/extensions/convert-sitemap-to-markdown'
 * ```
 */

const fs = require('fs')
const path = require('path')
const { parseStringPromise } = require('xml2js')

module.exports.register = function ({ config }) {
  const logger = this.getLogger('convert-sitemap-to-markdown')

  this
    .on('sitePublished', async ({ playbook, siteCatalog }) => {
      const startTime = Date.now()
      const outputDir = playbook.output.dir

      logger.info('Sitemap to markdown converter starting...')
      logger.info(`Output directory: ${outputDir}`)

      try {
        // Find all sitemap.xml files
        const sitemapFiles = findSitemapFiles(outputDir)

        if (sitemapFiles.length === 0) {
          logger.info('No sitemap.xml files found')
          return
        }

        logger.info(`Found ${sitemapFiles.length} sitemap file(s)`)

        // Convert each sitemap and collect all URLs
        const allUrls = []
        for (const sitemapPath of sitemapFiles) {
          const urls = await convertSitemapToMarkdown(sitemapPath, logger)
          if (urls) {
            allUrls.push(...urls)
          }
        }

        // Create combined master sitemap if we have multiple sitemaps
        if (sitemapFiles.length > 1 && allUrls.length > 0) {
          await createMasterSitemap(outputDir, sitemapFiles, allUrls, logger)
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2)
        logger.info(`Generated ${sitemapFiles.length} sitemap markdown file(s) in ${duration}s`)
      } catch (error) {
        logger.error(`Failed to generate sitemap markdown: ${error.message}`)
        throw error
      }
    })
}

/**
 * Recursively find all sitemap XML files in a directory
 * Matches: sitemap.xml, sitemap-0.xml, sitemap-ROOT.xml, sitemap-home.xml, etc.
 */
function findSitemapFiles(dir) {
  const sitemaps = []

  function search(currentDir) {
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name)

        if (entry.isDirectory()) {
          search(fullPath)
        } else if (/^sitemap(-[^/]+)?\.xml$/.test(entry.name)) {
          // Matches sitemap.xml, sitemap-*.xml (any suffix)
          sitemaps.push(fullPath)
        }
      }
    } catch (error) {
      // Ignore directories we can't read
    }
  }

  search(dir)
  return sitemaps.sort() // Sort to ensure consistent order
}

/**
 * Create a master combined sitemap from all individual sitemaps
 */
async function createMasterSitemap(outputDir, sitemapFiles, allUrls, logger) {
  const masterPath = path.join(outputDir, 'sitemap-all.md')

  let markdown = '# Complete Documentation Sitemap\n\n'
  markdown += `> Combined view of all ${allUrls.length} documentation pages from ${sitemapFiles.length} sitemap(s)\n\n`

  // Add overview of source sitemaps
  markdown += '## Source Sitemaps\n\n'
  for (const sitemapPath of sitemapFiles) {
    const basename = path.basename(sitemapPath)
    const mdName = basename.replace(/\.xml$/, '.md')
    markdown += `- [${basename}](${mdName})\n`
  }
  markdown += '\n'

  // Add all URLs grouped by component
  if (allUrls.length > 0) {
    markdown += convertUrlsetToMarkdown(allUrls)
  }

  fs.writeFileSync(masterPath, markdown, 'utf8')
  logger.info(`Generated master sitemap: sitemap-all.md (${allUrls.length} pages)`)
}

/**
 * Convert a sitemap.xml file to sitemap.md
 * Returns the URLs found in this sitemap for aggregation
 */
async function convertSitemapToMarkdown(sitemapPath, logger) {
  const xmlContent = fs.readFileSync(sitemapPath, 'utf8')
  const outputPath = sitemapPath.replace(/\.xml$/, '.md')

  try {
    const parsed = await parseStringPromise(xmlContent)

    let markdown = '# Sitemap\n\n'
    markdown += `> Documentation sitemap generated from ${path.basename(sitemapPath)}\n\n`

    let urls = []

    // Handle standard sitemap
    if (parsed.urlset && parsed.urlset.url) {
      urls = parsed.urlset.url
      markdown += convertUrlsetToMarkdown(urls)
    }

    // Handle sitemap index
    if (parsed.sitemapindex && parsed.sitemapindex.sitemap) {
      markdown += convertSitemapIndexToMarkdown(parsed.sitemapindex.sitemap)
    }

    fs.writeFileSync(outputPath, markdown, 'utf8')
    logger.debug(`Generated ${path.basename(outputPath)}`)

    return urls
  } catch (error) {
    logger.warn(`Failed to parse ${sitemapPath}: ${error.message}`)
    return []
  }
}

/**
 * Convert URL entries to markdown
 */
function convertUrlsetToMarkdown(urls) {
  let markdown = '## Pages\n\n'
  markdown += `Total pages: ${urls.length}\n\n`

  // Group URLs by component/path
  const groups = groupUrlsByPath(urls)

  for (const [groupName, groupUrls] of Object.entries(groups)) {
    markdown += `### ${groupName}\n\n`

    for (const url of groupUrls) {
      const loc = url.loc ? url.loc[0] : ''
      const lastmod = url.lastmod ? url.lastmod[0] : ''
      const changefreq = url.changefreq ? url.changefreq[0] : ''
      const priority = url.priority ? url.priority[0] : ''

      if (loc) {
        markdown += `- [${extractPageTitle(loc)}](${loc})`

        const metadata = []
        if (lastmod) metadata.push(`modified: ${lastmod}`)
        if (changefreq) metadata.push(`frequency: ${changefreq}`)
        if (priority) metadata.push(`priority: ${priority}`)

        if (metadata.length > 0) {
          markdown += ` (${metadata.join(', ')})`
        }

        markdown += '\n'
      }
    }

    markdown += '\n'
  }

  return markdown
}

/**
 * Convert sitemap index to markdown
 */
function convertSitemapIndexToMarkdown(sitemaps) {
  let markdown = '## Sitemap Index\n\n'
  markdown += `This sitemap index contains ${sitemaps.length} sub-sitemap(s):\n\n`

  for (const sitemap of sitemaps) {
    const loc = sitemap.loc ? sitemap.loc[0] : ''
    const lastmod = sitemap.lastmod ? sitemap.lastmod[0] : ''

    if (loc) {
      // Convert .xml URL to .md for markdown version
      const mdUrl = loc.replace(/\.xml$/, '.md')
      const basename = path.basename(loc)

      markdown += `- [${basename}](${mdUrl})`
      if (lastmod) {
        markdown += ` (modified: ${lastmod})`
      }
      markdown += '\n'
    }
  }

  markdown += '\n'
  return markdown
}

/**
 * Group URLs by their path prefix for better organization
 */
function groupUrlsByPath(urls) {
  const groups = {}

  for (const url of urls) {
    const loc = url.loc ? url.loc[0] : ''
    if (!loc) continue

    // Extract component from URL path
    const urlPath = new URL(loc).pathname
    const parts = urlPath.split('/').filter(p => p)

    let groupName = 'Root'
    if (parts.length > 0) {
      // Use first meaningful path segment as group
      groupName = parts[0]

      // Capitalize and format
      groupName = groupName
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
    }

    if (!groups[groupName]) {
      groups[groupName] = []
    }
    groups[groupName].push(url)
  }

  // Sort groups alphabetically
  const sortedGroups = {}
  Object.keys(groups).sort().forEach(key => {
    sortedGroups[key] = groups[key]
  })

  return sortedGroups
}

/**
 * Extract a readable page title from URL
 */
function extractPageTitle(url) {
  const urlPath = new URL(url).pathname
  const parts = urlPath.split('/').filter(p => p)

  if (parts.length === 0) return 'Home'

  // Get the last meaningful part
  let title = parts[parts.length - 1]

  // Remove .html extension
  title = title.replace(/\.html$/, '')

  // Convert dashes to spaces and capitalize
  title = title
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

  return title
}
