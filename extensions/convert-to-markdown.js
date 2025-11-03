const path = require('path')
const os = require('os')
const TurndownService = require('turndown') // https://github.com/mixmark-io/turndown
const turndownPluginGfm = require('turndown-plugin-gfm') // https://github.com/mixmark-io/turndown-plugin-gfm
const { gfm } = turndownPluginGfm

module.exports.register = function () {
  const logger = this.getLogger('convert-to-markdown-extension')
  let playbook // make globally accessible

  // Shared Turndown configuration (consistent Markdown output)
  const baseConfig = {
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    linkReferenceStyle: 'full',
  }

  // Factory: create base Turndown instance
  function createTurndownBase() {
    const td = new TurndownService(baseConfig)
    td.remove('script')
    td.use(gfm)
    return td
  }

  // Factory: create Turndown for a specific page
  function createTurndownForPage(page, siteUrl) {
    const td = createTurndownBase()
    const innerTurndown = createTurndownBase()

    // Compute base URL for relative → absolute links
    let pageBase = null
    if (siteUrl && page?.out?.path) {
      try {
        const pubUrl = page?.pub?.url
        const siteBase = siteUrl.endsWith('/') ? siteUrl : siteUrl + '/'
        pageBase = new URL(pubUrl || '', siteBase)
      } catch {
        pageBase = null
      }
    }

    // Rule: Convert Antora admonitions (<table> style) to Markdown
    td.addRule('admonition', {
      filter: (node) =>
        node.nodeName === 'TABLE' &&
        node.querySelector('td.icon') &&
        node.querySelector('td.content'),
      replacement: function (_, node) {
        const iconCell = node.querySelector('td.icon')
        const contentCell = node.querySelector('td.content')
        if (!iconCell || !contentCell) return ''

        const iconEl = iconCell.querySelector('i')
        const classAttr = iconEl?.className || ''
        const match = classAttr.match(/icon-([a-z]+)/i)
        const type = match ? match[1].toUpperCase() : 'NOTE'

        // Title extraction (optional custom title)
        const titleEl =
          node.querySelector('.title') ||
          contentCell.querySelector('.title') ||
          iconEl?.getAttribute('title')
        const customTitle =
          typeof titleEl === 'string'
            ? titleEl.trim()
            : titleEl?.textContent?.trim() || ''

        const emojiMap = {
          CAUTION: '⚠️',
          WARNING: '⚠️',
          TIP: '💡',
          NOTE: '📝',
          IMPORTANT: '❗',
        }
        const emoji = emojiMap[type] || '📘'

        const innerHtml = contentCell.innerHTML || ''
        const innerMd = innerTurndown.turndown(innerHtml).trim()

        const titleLower = customTitle.toLowerCase()
        const typeLower = type.toLowerCase()
        const header =
          customTitle && titleLower !== typeLower
            ? `${emoji} **${type}: ${customTitle}**`
            : `${emoji} **${type}**`

        const quoted = innerMd
          .split('\n')
          .map((line) => (line.startsWith('>') ? line : `> ${line}`))
          .join('\n')

        return `\n> ${header}\n>\n${quoted}\n`
      },
    })

    // Rule: Convert relative links to absolute Markdown equivalents
    td.addRule('absolute-links', {
      filter: 'a',
      replacement: function (content, node) {
        const href = node.getAttribute('href') || ''
        const text = content || node.textContent || ''
        if (!href) return `[${text}]()`

        // Leave anchors and absolute URLs untouched
        if (href.startsWith('#') || /^(?:[a-z]+:)?\/\//i.test(href))
          return `[${text}](${href})`

        // Prepend siteUrl to /api/ links
        if (/^\/api\//i.test(href)) {
          const base = siteUrl
            ? siteUrl.endsWith('/')
              ? siteUrl.slice(0, -1)
              : siteUrl
            : ''
          const fullApiUrl = base + href
          return `[${text}](${fullApiUrl})`
        }

        // Skip if we can't resolve the site or page base
        if (!siteUrl || !pageBase) return `[${text}](${href})`

        try {
          // Start with resolved absolute URL
          const urlObj = new URL(href, pageBase)
          const htmlStyle = playbook?.urls?.htmlExtensionStyle
          const isIndexify = htmlStyle === 'indexify'

          const pathname = urlObj.pathname

          if (isIndexify) {
            // Directory-style link: ends with '/' or has no file extension
            const looksLikeDir =
              pathname.endsWith('/') ||
              !path.basename(pathname).includes('.') // no .html, .htm, etc.

            if (looksLikeDir) {
              // ensure single trailing slash, then add index.md
              urlObj.pathname = pathname.replace(/\/?$/, '/index.md')
            } else {
              urlObj.pathname = pathname.replace(/\.html$/, '.md')
            }
          } else {
            // Non-indexified: only replace .html → .md
            urlObj.pathname = pathname.replace(/\.html$/, '.md')
          }

          const abs = urlObj.toString()
          return `[${text}](${abs})`
        } catch (e) {
          logger.debug(
            `Link resolution failed: "${href}" on ${page.src?.path}: ${e.message}`
          )
          return `[${text}](${href})`
        }
      },
    })

    // Rule: Properly format tables with correct structure
    td.addRule('tables', {
      filter: 'table',
      replacement: function (content, node) {
        // Extract rows
        const rows = Array.from(node.querySelectorAll('tr'))
        if (!rows.length) return content

        const tableRows = []

        rows.forEach((row, index) => {
          const cells = Array.from(row.querySelectorAll('th, td'))
          const cellContents = cells.map(cell => {
            // Get cell content and clean it up
            const cellText = cell.textContent || ''
            return cellText.trim().replace(/\s+/g, ' ')
          })

          if (cellContents.length > 0) {
            // Format as table row with proper pipes
            const rowContent = '| ' + cellContents.join(' | ') + ' |'
            tableRows.push(rowContent)

            // Add separator row after header (first row)
            if (index === 0) {
              const separator = '| ' + cellContents.map(() => '---').join(' | ') + ' |'
              tableRows.push(separator)
            }
          }
        })

        return tableRows.length > 0 ? '\n' + tableRows.join('\n') + '\n' : content
      },
    })

    // Rule: Clean up table cell content by trimming whitespace
    td.addRule('clean-table-cells', {
      filter: ['th', 'td'],
      replacement: function (content) {
        // Trim whitespace and collapse multiple newlines
        return content.trim().replace(/\n\s*\n/g, '\n')
      },
    })

    return td
  }

  // Convert all documents to Markdown
  this.on('documentsConverted', async ({ playbook: pb, contentCatalog }) => {
    playbook = pb // 👈 store globally
    const siteUrl = playbook.site?.url || ''
    const pages = contentCatalog.getPages()
    logger.info(
      `Converting ${pages.length} pages to Markdown${
        siteUrl ? ` (site.url=${siteUrl})` : ''
      }...`
    )

    const concurrency = Math.max(2, Math.floor(os.cpus().length / 2))
    const queue = [...pages]
    let convertedCount = 0

    async function processQueue() {
      while (queue.length) {
        const page = queue.shift()
        if (!page?.contents) continue

        try {
          const html = page.contents.toString().trim()
          if (!html) continue

          const td = createTurndownForPage(page, siteUrl)
          const markdown = td.turndown(html).trim()
          if (markdown) {
            page.markdownContents = Buffer.from(markdown, 'utf8')
            convertedCount++
          }
        } catch (err) {
          logger.error(
            `Error converting ${page.src?.path || 'unknown'}: ${err.message}`
          )
          logger.debug(err.stack)
        }
      }
    }

    const workers = Array.from({ length: concurrency }, processQueue)
    await Promise.all(workers)

    logger.info(`✅ Converted ${convertedCount} Markdown files.`)
  })

  // Add .md files to site catalog before publishing
  this.on('beforePublish', ({ siteCatalog, contentCatalog }) => {
    const pages = contentCatalog.getPages((p) => p.markdownContents)
    if (!pages.length) {
      logger.info('No Markdown files to publish.')
      return
    }

    logger.info(`Adding ${pages.length} Markdown files to site catalog...`)
    for (const page of pages) {
      const htmlOut = page.out?.path
      if (!htmlOut) continue
      const mdOutPath = htmlOut.replace(/\.html$/, '.md')

      siteCatalog.addFile({
        contents: page.markdownContents,
        out: { path: mdOutPath },
      })
      logger.debug(`Added Markdown: ${mdOutPath}`)
    }
  })
}
