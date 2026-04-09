'use strict'

/**
 * Adds llms.txt directive to HTML pages for agent-friendly documentation.
 *
 * This extension injects a blockquote directive pointing to /llms.txt near the top
 * of each documentation page's <article> content. This helps AI agents discover
 * the documentation index according to the Agent-Friendly Docs spec.
 *
 * The directive is styled to be visually hidden but remains in the HTML for agents
 * to discover when they fetch pages.
 *
 * @see https://agentdocsspec.com/spec/#llms-txt-directive
 */

const { formatLlmsDirective } = require('../extension-utils/llms-utils')

module.exports.register = function () {
  const logger = this.getLogger('add-llms-directive-extension')

  this.on('pagesComposed', ({ contentCatalog }) => {
    const pages = contentCatalog.getPages()
    let processedCount = 0

    pages.forEach(page => {
      if (!page.contents) return

      try {
        const html = page.contents.toString('utf8')

        // Find the <article class="doc"> tag and inject directive after it
        // The directive should appear near the top of content for agent discovery
        const articleMatch = html.match(/(<article[^>]*class=["'][^"']*\bdoc\b[^"']*["'][^>]*>)([\s\S]*?)(<\/article>)/i)

        if (!articleMatch) {
          logger.debug(`No <article class="doc"> found in ${page.src?.path}`)
          return
        }

        const [fullMatch, openTag, articleContent, closeTag] = articleMatch

        // Find where to inject: after breadcrumbs and h1, but before main content
        // Look for the end of the h1.page or first content element
        let injectionPoint = -1

        // Try to find h1.page (title) - inject after it
        const h1Match = articleContent.match(/<h1[^>]*class=["'][^"']*\bpage\b[^"']*["'][^>]*>.*?<\/h1>/i)
        if (h1Match) {
          injectionPoint = articleContent.indexOf(h1Match[0]) + h1Match[0].length
        } else {
          // Fallback: inject after breadcrumbs if present, or at start of article
          const breadcrumbsMatch = articleContent.match(/<nav[^>]*class=["'][^"']*\bbreadcrumbs\b[^"']*["'][^>]*>[\s\S]*?<\/nav>/i)
          if (breadcrumbsMatch) {
            injectionPoint = articleContent.indexOf(breadcrumbsMatch[0]) + breadcrumbsMatch[0].length
          } else {
            injectionPoint = 0
          }
        }

        if (injectionPoint === -1) {
          logger.debug(`Could not find injection point in ${page.src?.path}`)
          return
        }

        // Get component name for component-specific link
        const componentName = page.src?.component || ''

        // Generate the directive in markdown blockquote format
        const directiveMarkdown = formatLlmsDirective(componentName)

        // Convert markdown blockquote to HTML blockquote
        // Remove leading '> ' and convert markdown links to HTML
        let directiveText = directiveMarkdown.replace(/^>\s*/, '')

        // Convert markdown links [text](url) to HTML <a> tags
        // Add tabindex="-1" and aria-hidden="true" to remove from tab order and hide from assistive tech
        directiveText = directiveText.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" tabindex="-1" aria-hidden="true">$1</a>')

        // Add tabindex="-1" and aria-hidden="true" to blockquote to fully hide from assistive tech
        const directiveHtml = `\n<blockquote class="llms-directive" tabindex="-1" aria-hidden="true">\n<p>${directiveText}</p>\n</blockquote>\n`

        // Inject the directive
        const newArticleContent =
          articleContent.slice(0, injectionPoint) +
          directiveHtml +
          articleContent.slice(injectionPoint)

        // Reconstruct the article HTML
        let newHtml = html.replace(fullMatch, openTag + newArticleContent + closeTag)

        // Add CSS to hide the directive visually (screen-reader-only pattern)
        // This keeps it in HTML for agents but hidden from visual users
        const cssTag = `<style>.llms-directive{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}</style>`

        // Inject CSS before </head> if not already present
        if (!html.includes('.llms-directive{')) {
          newHtml = newHtml.replace('</head>', `${cssTag}\n</head>`)
        }

        // Update page contents
        page.contents = Buffer.from(newHtml, 'utf8')
        processedCount++

      } catch (err) {
        logger.error(`Error adding llms directive to ${page.src?.path}: ${err.message}`)
      }
    })

    logger.info(`Added llms.txt directive to ${processedCount} HTML pages`)
  })
}
