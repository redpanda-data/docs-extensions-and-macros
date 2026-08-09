'use strict'

/**
 * Generates FAQPage JSON-LD structured data for SEO.
 *
 * USAGE:
 *   :page-faq-1-question: How do I install Redpanda?
 *   :page-faq-1-answer: Download from redpanda.com and run the installer. See our xref:get-started:intro.adoc[quickstart guide] for details.
 *   :page-faq-1-anchor: #installation (optional - links to section)
 *
 *   :page-faq-2-question: What are the system requirements?
 *   :page-faq-2-answer: You need at least 2GB RAM and 2 CPU cores for production. For development, xref:deploy:docker-compose.adoc[use Docker Compose].
 *   :page-faq-2-anchor: #requirements
 *
 * The extension:
 * - Generates schema.org FAQPage JSON-LD in <head>
 * - Supports multiple FAQs numbered sequentially (1, 2, 3...)
 * - Anchor is optional and adds URL to the FAQ question
 * - Writers can use AsciiDoc xrefs in answers - they're resolved to full URLs
 * - Xrefs are converted to "link text (URL)" format in JSON-LD
 */

/**
 * Resolve xrefs in text to full URLs
 * @param {string} text - Text containing xref macros
 * @param {Object} currentPage - Current page context
 * @param {Object} contentCatalog - Antora content catalog
 * @param {string} siteUrl - Base site URL
 * @param {Object} logger - Logger instance
 * @returns {string} Text with xrefs resolved to plain text + URLs
 */
function resolveXrefs(text, currentPage, contentCatalog, siteUrl, logger) {
  // Match xref:target[link text] pattern
  const xrefPattern = /xref:([^\[]+)\[([^\]]+)\]/g

  return text.replace(xrefPattern, (match, target, linkText) => {
    try {
      // Resolve the resource using Antora's content catalog
      // This uses Antora's standard API for resolving page references
      const resource = contentCatalog.resolveResource(target, currentPage.src, 'page')

      if (resource && resource.pub && resource.pub.url) {
        const fullUrl = siteUrl ? `${siteUrl}${resource.pub.url}` : `https://docs.redpanda.com${resource.pub.url}`
        return `${linkText} (${fullUrl})`
      } else {
        // Xref couldn't be resolved (page doesn't exist or isn't loaded yet)
        // Fall back to just the link text - this is expected for cross-component refs in local builds
        return linkText
      }
    } catch (error) {
      logger.warn(`FAQ xref resolution error for ${target}: ${error.message}`)
      return linkText // Fallback to just the link text
    }
  })
}

/**
 * Extract FAQ entries from page attributes
 * @param {Object} attributes - Page attributes object
 * @param {Object} page - Current page object
 * @param {Object} contentCatalog - Antora content catalog
 * @param {string} siteUrl - Base site URL
 * @param {Object} logger - Logger instance
 * @returns {Array<{question: string, answer: string, anchor?: string}>}
 */
function extractFaqs(attributes, page, contentCatalog, siteUrl, logger) {
  const faqs = []
  const faqNumbers = new Set()

  // Find all FAQ numbers by scanning for -question attributes
  Object.keys(attributes).forEach(key => {
    const match = key.match(/^page-faq-(\d+)-question$/)
    if (match) {
      faqNumbers.add(parseInt(match[1], 10))
    }
  })

  if (faqNumbers.size === 0) return faqs

  // Extract FAQs in numerical order
  const sortedNumbers = Array.from(faqNumbers).sort((a, b) => a - b)

  sortedNumbers.forEach(num => {
    const question = attributes[`page-faq-${num}-question`]
    const answer = attributes[`page-faq-${num}-answer`]
    const anchor = attributes[`page-faq-${num}-anchor`]

    // Both question and answer are required
    if (!question) {
      logger.warn(`FAQ ${num}: question missing`)
      return
    }

    if (!answer) {
      logger.warn(`FAQ ${num}: answer missing`)
      return
    }

    // Resolve any xrefs in the answer text
    const resolvedAnswer = resolveXrefs(answer.trim(), page, contentCatalog, siteUrl, logger)

    const faq = {
      question: question.trim(),
      answer: resolvedAnswer
    }

    if (anchor) {
      faq.anchor = anchor.trim()
    }

    faqs.push(faq)
  })

  return faqs
}

/**
 * Generate FAQPage JSON-LD structure
 * @param {Array} faqs - Array of FAQ objects
 * @param {string} baseUrl - Base URL for the page
 * @returns {Object} FAQPage JSON-LD object
 */
function generateFaqJsonLd(faqs, baseUrl) {
  const mainEntity = faqs.map(faq => {
    const question = {
      '@type': 'Question',
      'name': faq.question,
      'acceptedAnswer': {
        '@type': 'Answer',
        'text': faq.answer
      }
    }

    // Add URL with anchor if provided
    if (faq.anchor) {
      const anchor = faq.anchor.startsWith('#') ? faq.anchor : `#${faq.anchor}`
      question.url = `${baseUrl}${anchor}`
    }

    return question
  })

  return {
    '@type': 'FAQPage',
    'mainEntity': mainEntity
  }
}

module.exports.register = function () {
  const logger = this.getLogger('add-faq-structured-data-extension')
  let playbook

  this.once('playbookBuilt', ({ playbook: pb }) => {
    playbook = pb
  })

  this.on('documentsConverted', ({ contentCatalog }) => {
    const pages = contentCatalog.getPages()
    const siteUrl = playbook?.site?.url || ''
    let processedCount = 0
    let totalFaqs = 0

    pages.forEach(page => {
      const attributes = page.asciidoc?.attributes
      if (!attributes) return

      // Extract FAQs from attributes and resolve any xrefs
      const faqs = extractFaqs(attributes, page, contentCatalog, siteUrl, logger)

      if (faqs.length === 0) return

      // Store structured FAQ data as JSON for UI template to format
      // Template will generate the JSON-LD structure using page.url
      attributes['page-has-faqs'] = 'true'
      attributes['page-faqs'] = JSON.stringify(faqs)

      processedCount++
      totalFaqs += faqs.length
    })

    if (processedCount > 0) {
      logger.info(`Generated FAQ structured data for ${processedCount} pages (${totalFaqs} total FAQs)`)
    }
  })
}
