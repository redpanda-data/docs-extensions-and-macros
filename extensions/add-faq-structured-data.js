'use strict'

/**
 * Generates FAQPage JSON-LD structured data for SEO.
 *
 * USAGE:
 *   :page-faq-1-question: How do I install Redpanda?
 *   :page-faq-1-answer: Download from redpanda.com and run the installer.
 *   :page-faq-1-anchor: #installation (optional - links to section)
 *
 *   :page-faq-2-question: What are the system requirements?
 *   :page-faq-2-answer: You need at least 2GB RAM and 2 CPU cores.
 *   :page-faq-2-anchor: #requirements
 *
 * The extension:
 * - Generates schema.org FAQPage JSON-LD in <head>
 * - Supports multiple FAQs numbered sequentially (1, 2, 3...)
 * - Anchor is optional and adds URL to the FAQ question
 * - Writers can reference existing page content in answers
 */

/**
 * Extract FAQ entries from page attributes
 * @param {Object} attributes - Page attributes object
 * @param {Object} logger - Logger instance
 * @returns {Array<{question: string, answer: string, anchor?: string}>}
 */
function extractFaqs(attributes, logger) {
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

    const faq = {
      question: question.trim(),
      answer: answer.trim()
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
    let processedCount = 0
    let totalFaqs = 0
    const siteUrl = playbook?.site?.url || 'https://docs.redpanda.com'

    pages.forEach(page => {
      const attributes = page.asciidoc?.attributes
      if (!attributes) return

      // Extract FAQs from attributes
      const faqs = extractFaqs(attributes, logger)

      if (faqs.length === 0) return

      // Generate base URL for the page
      let baseUrl = ''
      if (page.pub?.url) {
        baseUrl = `${siteUrl}${page.pub.url}`
      }

      // Generate FAQPage JSON-LD
      const faqJsonLd = generateFaqJsonLd(faqs, baseUrl)

      // Store as JSON string in page attribute for UI template
      attributes['page-faq-json-ld'] = JSON.stringify(faqJsonLd, null, 2)

      processedCount++
      totalFaqs += faqs.length

      logger.debug(`Added ${faqs.length} FAQs to ${page.src.relative}`)
    })

    if (processedCount > 0) {
      logger.info(`Generated FAQ structured data for ${processedCount} pages (${totalFaqs} total FAQs)`)
    }
  })
}
