const path = require('path')
const os = require('os')
const TurndownService = require('turndown')
const turndownPluginGfm = require('turndown-plugin-gfm')
const { gfm } = turndownPluginGfm

module.exports.register = function () {
  const logger = this.getLogger('convert-to-markdown-extension')
  let playbook

  // Shared Turndown configuration
  const baseConfig = {
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    linkReferenceStyle: 'full',
  }

  // Factory: create a configured Turndown instance
  function createTurndownBase() {
    const td = new TurndownService(baseConfig)
    td.use(gfm)

    // Remove unwanted global elements (footers, modals, feedback, etc.)
    td.addRule('remove-unwanted', {
      filter: (node) => {
        if (!node || !node.getAttribute) return false

        const classAttr = (node.getAttribute('class') || '').toLowerCase()
        const idAttr = (node.getAttribute('id') || '').toLowerCase()
        const tag = node.nodeName.toLowerCase()

        // Remove by tag
        if (['script', 'style', 'footer', 'nav'].includes(tag)) return true

        // Remove tracking or hidden images
        if (
          tag === 'img' &&
          (classAttr.includes('tracking') ||
            idAttr.includes('scarf') ||
            node.getAttribute('role') === 'presentation' ||
            node.style?.display === 'none')
        ) {
          return true
        }

        // Remove by class or id
        const toRemove = [
          'thumbs',
          'back-to-top',
          'contributors-modal',
          'feedback-section',
          'feedback-toast',
          'pagination',
          'footer',
          'nav-expand',
          'banner-container',
          'markdown-dropdown',
        ]
        return toRemove.some(
          (x) => classAttr.includes(x) || idAttr.includes(x)
        )
      },
      replacement: () => '',
    })

    // Keep critical content blocks only
    td.keep(['div.openblock.tabs', 'article.doc'])
    return td
  }

  // Factory: create page-specific Turndown converter
  function createTurndownForPage(page) {
    const outerTurndown = createTurndownBase()
    const nestedTurndown = createTurndownBase()

    // Helper to add custom rules
    function addCustomRules(turndownInstance, isInner = false) {
      // Determine heading depth for tab conversion
      function findNearestHeadingLevel(el) {
        let current = el.previousElementSibling
        while (current) {
          if (/^H[1-6]$/i.test(current.nodeName))
            return parseInt(current.nodeName.substring(1))
          current = current.previousElementSibling
        }
        let parent = el.parentElement
        while (parent) {
          const headings = Array.from(
            parent.querySelectorAll('h1,h2,h3,h4,h5,h6')
          )
          if (headings.length > 0) {
            const last = headings[headings.length - 1]
            return parseInt(last.nodeName.substring(1))
          }
          parent = parent.parentElement
        }
        return 2
      }

      // Asciidoctor tab conversion
      turndownInstance.addRule('asciidoctor-tabs', {
        filter: (node) => {
          if (node.nodeName !== 'DIV') return false
          const classAttr = node.getAttribute?.('class') || node.className || ''
          return classAttr.includes('openblock') && classAttr.includes('tabs')
        },
        replacement: function (_, node) {
          function processTabGroup(group, parentHeadingLevel = null) {
            const contentDiv = group.querySelector('.content') || group
            const tabList = contentDiv.querySelectorAll('li.tab')
            if (!tabList.length) return ''

            const nearestLevel =
              parentHeadingLevel != null
                ? parentHeadingLevel + 1
                : findNearestHeadingLevel(group) + 1
            const tabHeadingLevel = Math.min(nearestLevel, 6)
            const headingPrefix = '#'.repeat(tabHeadingLevel)

            let markdown = ''
            tabList.forEach((tab) => {
              const title =
                tab.querySelector('p')?.textContent.trim() ||
                tab.textContent.trim()

              let panelId = tab.getAttribute('aria-controls')
              if (!panelId && tab.id) panelId = tab.id + '--panel'
              const panel = group.querySelector(`#${panelId}`)
              if (!panel) return

              const nestedTabs = panel.querySelectorAll('.openblock.tabs')
              let nestedMdCombined = ''
              nestedTabs.forEach((nested) => {
                nestedMdCombined +=
                  '\n' + processTabGroup(nested, tabHeadingLevel) + '\n'
                nested.remove()
              })

              const innerHtml = panel.innerHTML || ''
              let md = ''
              try {
                const converter = isInner ? nestedTurndown : turndownInstance
                md = converter.turndown(innerHtml)
              } catch (e) {
                logger.warn(`Turndown failed in nested tab: ${e.message}`)
              }

              markdown += `${headingPrefix} ${title}\n\n${md.trim()}\n${nestedMdCombined.trim()}\n\n`
            })

            return markdown.trim()
          }

          return '\n' + processTabGroup(node, null) + '\n'
        },
      })

      // Admonition block conversion
      turndownInstance.addRule('admonition', {
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
          let innerMd = ''
          try {
            const converter = isInner ? nestedTurndown : turndownInstance
            innerMd = converter.turndown(innerHtml).trim()
          } catch (e) {
            logger.warn(`Turndown failed in admonition: ${e.message}`)
          }

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

      // Markdown table conversion
      turndownInstance.addRule('tables', {
        filter: (node) => {
          if (node.nodeName !== 'TABLE') return false
          if (node.querySelector('td.icon') && node.querySelector('td.content'))
            return false
          return true
        },
        replacement: function (content, node) {
          const rows = Array.from(node.querySelectorAll('tr'))
          if (!rows.length) return content
          const tableRows = []
          rows.forEach((row, index) => {
            const cells = Array.from(row.querySelectorAll('th, td'))
            const cellContents = cells.map((cell) =>
              (cell.textContent || '').trim().replace(/\s+/g, ' ')
            )
            if (!cellContents.length) return
            const rowLine = '| ' + cellContents.join(' | ') + ' |'
            tableRows.push(rowLine)
            if (index === 0) {
              const separator =
                '| ' + cellContents.map(() => '---').join(' | ') + ' |'
              tableRows.push(separator)
            }
          })
          return '\n' + tableRows.join('\n') + '\n'
        },
      })
    }

    addCustomRules(outerTurndown, false)
    addCustomRules(nestedTurndown, true)
    return outerTurndown
  }

  // Add marker attribute before UI rendering so templates can detect markdown availability
  this.on('documentsConverted', ({ contentCatalog }) => {
    const pages = contentCatalog.findBy({ family: 'page' })
    logger.info(`Marking ${pages.length} pages as having markdown equivalents...`)

    pages.forEach((page) => {
      // Ensure attributes object exists
      if (!page.asciidoc) page.asciidoc = {}
      if (!page.asciidoc.attributes) page.asciidoc.attributes = {}

      // Add marker that UI templates can check
      page.asciidoc.attributes['page-has-markdown'] = ''
    })
  })

  // Conversion pipeline
  this.on('pagesComposed', async ({ playbook: pb, contentCatalog }) => {
    playbook = pb
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

          // Extract only the <article class="doc"> portion
          const match = html.match(
            /<article[^>]*class=["'][^"']*\bdoc\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/i
          )
          if (!match || !match[1]) {
            logger.info(`No <article class="doc"> found for ${page.src?.path}`)
            continue
          }
          const articleHtml = match[1]

          // Convert with Turndown
          const td = createTurndownForPage(page)
          let markdown = td.turndown(articleHtml).trim()

          // Canonical source link
          let canonicalUrl = ''
          try {
            if (siteUrl && page.pub?.url) {
              const htmlStyle = playbook?.urls?.htmlExtensionStyle
              const isIndexify = htmlStyle === 'indexify'
              const baseUrl = new URL(page.pub.url, siteUrl)
              let pathname = baseUrl.pathname

              if (isIndexify) {
                const looksLikeDir =
                  pathname.endsWith('/') ||
                  !path.basename(pathname).includes('.')
                baseUrl.pathname = looksLikeDir
                  ? pathname.replace(/\/?$/, '/index.md')
                  : pathname.replace(/\.html$/, '.md')
              } else {
                baseUrl.pathname = pathname.replace(/\.html$/, '.md')
              }

              canonicalUrl = baseUrl.toString()
            }
          } catch (e) {
            logger.debug(
              `Failed to build canonical URL for ${page.src?.path}: ${e.message}`
            )
          }

          // Prepend Markdown source reference and URL construction hint
          if (canonicalUrl) {
            const urlHint = `<!-- Note for AI: Links in this doc are relative to the current page and use indexify format. Add /index.md to directory-style links for the Markdown version. -->`
            
            markdown = `<!-- Source: ${canonicalUrl} -->\n${urlHint}\n\n${markdown}`
          }

          // Clean up unnecessary whitespace
          if (markdown) {
            // Remove excessive blank lines (more than 2 consecutive newlines)
            markdown = markdown.replace(/\n{3,}/g, '\n\n')
            // Remove trailing whitespace from lines
            markdown = markdown.replace(/[ \t]+$/gm, '')
            // Remove leading/trailing whitespace from the entire document
            markdown = markdown.trim()
          }

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
    logger.info(`Converted ${convertedCount} Markdown files.`)
  })

  // Add Markdown files to site catalog
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
