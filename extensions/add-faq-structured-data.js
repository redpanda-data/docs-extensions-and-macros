'use strict'

/**
 * Generates FAQPage JSON-LD structured data for SEO.
 *
 * SIMPLE USAGE (auto-extract from sections):
 *   :page-faq-1-anchor: #installation
 *   :page-faq-2-anchor: #requirements
 *
 *   [#installation]
 *   == How do I install Redpanda?
 *   Download from...
 *
 * The extension automatically extracts:
 *   - Question: Heading text
 *   - Answer: Section content
 *
 * OVERRIDE USAGE (manual question/answer):
 *   :page-faq-1-question: Custom question text
 *   :page-faq-1-answer: Custom answer text
 *   :page-faq-1-anchor: #section (optional)
 *
 * MIXED USAGE:
 *   :page-faq-1-anchor: #auto-extracted
 *   :page-faq-2-question: Manual FAQ
 *   :page-faq-2-answer: With custom text
 *
 * The extension:
 * - Supports multiple FAQs numbered sequentially (1, 2, 3...)
 * - Creates schema.org FAQPage JSON-LD in <head>
 * - Uses manual question/answer if provided, otherwise auto-extracts
 */

const cheerio = require('cheerio')

/**
 * Strip HTML tags and clean up text
 * @param {string} html - HTML string
 * @returns {string} Plain text
 */
function stripHtml(html) {
  if (!html) return ''
  const $ = cheerio.load(html)
  return $.text().trim().replace(/\s+/g, ' ')
}

/**
 * Extract FAQ entries from page attributes and content
 *
 * Priority:
 * 1. If question/answer provided manually, use those
 * 2. If only anchor provided, extract from HTML section
 *
 * @param {Object} attributes - Page attributes object
 * @param {Buffer} contents - Page HTML content
 * @param {Object} logger - Logger instance
 * @returns {Array<{question: string, answer: string, anchor?: string}>}
 */
function extractFaqs(attributes, contents, logger) {
  const faqs = []
  const faqNumbers = new Set()

  // Find all FAQ numbers by scanning for any FAQ attribute
  Object.keys(attributes).forEach(key => {
    const match = key.match(/^page-faq-(\d+)-(anchor|question|answer)$/)
    if (match) {
      faqNumbers.add(parseInt(match[1], 10))
    }
  })

  if (faqNumbers.size === 0) return faqs

  // Parse HTML content (lazy - only if needed)
  let $ = null

  // Extract FAQs in numerical order
  const sortedNumbers = Array.from(faqNumbers).sort((a, b) => a - b)

  sortedNumbers.forEach(num => {
    const manualQuestion = attributes[`page-faq-${num}-question`]
    const manualAnswer = attributes[`page-faq-${num}-answer`]
    const anchor = attributes[`page-faq-${num}-anchor`]

    let question = manualQuestion
    let answer = manualAnswer

    // If question or answer missing, try to extract from HTML section
    if ((!question || !answer) && anchor) {
      // Lazy load cheerio only if we need to extract from HTML
      if (!$) {
        $ = cheerio.load(contents.toString())
      }

      // Remove leading # if present
      const anchorId = anchor.startsWith('#') ? anchor.substring(1) : anchor

      // Find the section with this ID
      const $section = $(`#${anchorId}, [id="${anchorId}"]`).first()

      if (!$section.length) {
        logger.warn(`FAQ anchor not found: ${anchor}`)
        return
      }

      // Extract question from heading if not provided
      if (!question) {
        if ($section.is('h1, h2, h3, h4, h5, h6')) {
          question = stripHtml($section.html())
        } else {
          const $heading = $section.find('h1, h2, h3, h4, h5, h6').first()
          if ($heading.length) {
            question = stripHtml($heading.html())
          } else {
            const $prevHeading = $section.prevAll('h1, h2, h3, h4, h5, h6').first()
            if ($prevHeading.length) {
              question = stripHtml($prevHeading.html())
            }
          }
        }
      }

      // Extract answer from section content if not provided
      if (!answer) {
        let $content
        if ($section.is('h1, h2, h3, h4, h5, h6')) {
          // Get content between this heading and next heading of same/higher level
          const headingLevel = parseInt($section.prop('tagName').substring(1))
          const selector = Array.from({ length: headingLevel }, (_, i) => `h${i + 1}`).join(', ')
          $content = $section.nextUntil(selector).not('h1, h2, h3, h4, h5, h6')
        } else {
          $content = $section.children().not('h1, h2, h3, h4, h5, h6')
        }
        answer = stripHtml($content.html())
      }
    }

    // Validate we have both question and answer
    if (!question) {
      logger.warn(`FAQ ${num}: question not found (provide manually or ensure section heading exists)`)
      return
    }

    if (!answer) {
      logger.warn(`FAQ ${num}: answer not found (provide manually or ensure section content exists)`)
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
      if (!attributes || !page.contents) return

      // Extract FAQs from attributes and HTML content
      const faqs = extractFaqs(attributes, page.contents, logger)

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
