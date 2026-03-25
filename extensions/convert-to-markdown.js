const path = require('path')
const os = require('os')
const yaml = require('js-yaml')
const { toMarkdownUrl } = require('../extension-utils/url-utils')
const TurndownService = require('turndown')
const turndownPluginGfm = require('turndown-plugin-gfm')
const { gfm } = turndownPluginGfm

/**
 * Converts AsciiDoc page attributes to YAML frontmatter
 * @param {Object} page - The page object with asciidoc attributes
 * @returns {string} YAML frontmatter string or empty string if no attributes
 */
function generateFrontmatter(page) {
  const frontmatter = {}

  // Add title
  if (page.asciidoc?.doctitle) {
    frontmatter.title = page.asciidoc.doctitle
  }

  // Add navigation title if different from doctitle
  if (page.asciidoc?.navtitle && page.asciidoc.navtitle !== page.asciidoc?.doctitle) {
    frontmatter.navtitle = page.asciidoc.navtitle
  }

  // Get all page attributes
  const attrs = page.asciidoc?.attributes || {}

  // Allowlist of attributes to include in frontmatter
  // Explicitly opt-in to attributes that are useful for AI consumption
  const allowedAttributes = [
    'title',
    'navtitle',
    'description',
    'categories',
    'page-component-name',
    'page-component-title',
    'page-component-version',
    'page-version',
    'page-relative-src-path',
    'page-edit-url',
    'page-topic-type',
    'personas',
    'docname',
    'page-beta',
    'page-beta-text',
    'page-is-nearing-eol',
    'page-is-past-eol',
    'page-eol-date',
    'page-git-created-date',
    'page-git-modified-date',
  ]

  // Add allowed page attributes to frontmatter
  Object.keys(attrs).forEach(key => {
    const value = attrs[key]

    // Allow all learning-objective-* attributes (learning-objective-1, -2, -3, etc.)
    const isLearningObjective = key.startsWith('learning-objective-')

    // Only include attributes in our allowlist or learning objectives
    if (!allowedAttributes.includes(key) && !isLearningObjective) return

    // Only include page-beta-text if page-beta is true
    if (key === 'page-beta-text' && !attrs['page-beta']) {
      return
    }

    // Skip empty attributes (AsciiDoc boolean flags)
    if (value === '') {
      // Special handling for version fields - use actual version from page source
      if (key === 'page-version') {
        frontmatter[key] = page.src?.version || 'master'
        return
      }
      if (key === 'page-component-version') {
        frontmatter[key] = page.src?.version || 'master'
        return
      }
      // Preserve important boolean flags
      if (key.startsWith('page-')) {
        frontmatter[key] = true
      }
      return
    }

    // Include the attribute
    frontmatter[key] = value
  })

  // Transform EOL fields to be more user-friendly
  if (frontmatter['page-is-nearing-eol'] || frontmatter['page-is-past-eol']) {
    let eolStatus = 'supported'
    if (frontmatter['page-is-past-eol'] === 'true' || frontmatter['page-is-past-eol'] === true) {
      eolStatus = 'past end-of-life'
    } else if (frontmatter['page-is-nearing-eol'] === 'true' || frontmatter['page-is-nearing-eol'] === true) {
      eolStatus = 'nearing end-of-life'
    }
    frontmatter['support-status'] = eolStatus
    // Keep original fields for compatibility
  }

  // Transform beta fields to be more user-friendly
  if (frontmatter['page-beta'] === 'true' || frontmatter['page-beta'] === true) {
    let betaStatus = 'beta'
    if (frontmatter['page-beta-text']) {
      betaStatus = `beta - ${frontmatter['page-beta-text']}`
    }
    frontmatter['release-status'] = betaStatus
  }

  // Return empty string if no frontmatter
  if (Object.keys(frontmatter).length === 0) return ''

  // Convert to YAML format using js-yaml library for proper escaping
  let yamlContent = yaml.dump(frontmatter, {
    lineWidth: -1, // Disable line wrapping
    noRefs: true, // Disable anchors/aliases
    quotingType: '"', // Use double quotes
    forceQuotes: false, // Only quote when necessary
  })

  // Add helpful comments for EOL (end-of-life) fields
  // Find the first EOL-related field and add comment before it
  if (frontmatter['page-is-nearing-eol'] || frontmatter['page-is-past-eol'] || frontmatter['support-status']) {
    const eolFieldRegex = /^(page-is-nearing-eol:|page-is-past-eol:|support-status:)/m
    if (!yamlContent.includes('# EOL =')) {
      yamlContent = yamlContent.replace(
        eolFieldRegex,
        '# EOL = End-of-Life (support lifecycle status)\n$1'
      )
    }
  }

  // Add helpful comments for beta fields
  if (frontmatter['page-beta'] || frontmatter['release-status']) {
    const betaFieldRegex = /^(page-beta:|release-status:)/m
    if (!yamlContent.includes('# Beta release')) {
      yamlContent = yamlContent.replace(
        betaFieldRegex,
        '# Beta release status\n$1'
      )
    }
  }

  return `---\n${yamlContent}---\n\n`
}

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
              const baseUrl = new URL(page.pub.url, siteUrl)
              // Convert HTML URL to markdown URL using shared utility
              baseUrl.pathname = toMarkdownUrl(baseUrl.pathname)
              canonicalUrl = baseUrl.toString()
            }
          } catch (e) {
            logger.debug(
              `Failed to build canonical URL for ${page.src?.path}: ${e.message}`
            )
          }

          // Generate YAML frontmatter from AsciiDoc attributes
          const frontmatter = generateFrontmatter(page)
          if (frontmatter) {
            logger.debug(`Generated frontmatter for ${page.src?.path}`)
          }

          // Prepend frontmatter first, then source reference and AI-friendly note
          if (canonicalUrl) {
            const componentName = page.src?.component || '';
            const urlHint = componentName
              ? `<!-- Note for AI: This is a Markdown export. For aggregated content, see /llms.txt (curated overview), /${componentName}-full.txt (this component only), or /llms-full.txt (complete documentation). -->`
              : `<!-- Note for AI: This is a Markdown export. For aggregated content, see /llms.txt (curated overview) or /llms-full.txt (complete documentation). -->`;

            markdown = `${frontmatter}<!-- Source: ${canonicalUrl} -->\n${urlHint}\n\n${markdown}`
          } else if (frontmatter) {
            // If no canonical URL but we have frontmatter, still add it
            markdown = `${frontmatter}${markdown}`
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

      // Convert HTML path to markdown path using shared utility
      const mdOutPath = toMarkdownUrl(htmlOut)

      siteCatalog.addFile({
        contents: page.markdownContents,
        out: { path: mdOutPath },
      })
      logger.debug(`Added Markdown: ${mdOutPath}`)
    }
  })
}
