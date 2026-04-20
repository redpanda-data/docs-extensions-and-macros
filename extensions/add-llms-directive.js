'use strict'

/**
 * Adds llms.txt directive to HTML pages for agent-friendly documentation.
 *
 * This extension injects a blockquote directive pointing to /llms.txt immediately
 * after the <body> tag of each documentation page. This helps AI agents discover
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

      // Skip field-only pages (marked by generate-fields-only-pages extension)
      if (page.isFieldOnlyPage === true) return

      try {
        const html = page.contents.toString('utf8')

        // Find the <body> tag and inject directive immediately after it
        // This ensures the directive appears early in the HTML for better agent discovery
        const bodyMatch = html.match(/(<body[^>]*>)/i)

        if (!bodyMatch) {
          logger.debug(`No <body> tag found in ${page.src?.path}`)
          return
        }

        const bodyTag = bodyMatch[1]

        // Get component name for component-specific link
        const componentName = page.src?.component || ''

        // Generate the directive in markdown blockquote format
        const directiveMarkdown = formatLlmsDirective(componentName)

        // Convert markdown blockquote to HTML blockquote
        // Remove leading '> ' and convert markdown links to HTML
        let directiveText = directiveMarkdown.replace(/^>\s*/, '')

        // Convert markdown links [text](url) to HTML <a> tags
        // Add space after <a to match afdocs test pattern expectations
        // Add tabindex="-1" and aria-hidden="true" to remove from tab order and hide from assistive tech
        directiveText = directiveText.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" tabindex="-1" aria-hidden="true">$1</a>')

        // Add tabindex="-1" and aria-hidden="true" to blockquote to fully hide from assistive tech
        const directiveHtml = `\n<blockquote class="llms-directive" tabindex="-1" aria-hidden="true">\n<p>${directiveText}</p>\n</blockquote>\n`

        // Inject the directive immediately after the <body> tag
        let newHtml = html.replace(bodyTag, bodyTag + directiveHtml)

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
