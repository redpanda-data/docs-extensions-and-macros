'use strict'

/**
 * Convert a string to sentence case, preserving acronyms and proper nouns
 * @param {string} text - The text to convert
 * @returns {string} The text in sentence case
 */
function toSentenceCase(text) {
  if (!text) return ''

  // Map of exact word matches to preserve (case-sensitive)
  const exactPreserve = new Map([
    ['geoip', 'GeoIP'],
    ['GEOIP', 'GeoIP'],
    ['GeoIP', 'GeoIP']
  ])

  // List of acronyms to preserve (will be uppercased)
  const preserveWords = new Set([
    'SQL',
    'JSON',
    'JWT',
    'XML',
    'HTML',
    'URL',
    'URI',
    'HTTP',
    'HTTPS',
    'TLS',
    'SSL',
    'AWS',
    'GCP',
    'API',
    'ID',
    'UUID',
    'CSV'
  ])

  // Split into words
  const words = text.split(/\s+/)

  return words.map((word, index) => {
    // Check if word is in exact preserve map first
    if (exactPreserve.has(word) || exactPreserve.has(word.toLowerCase()) || exactPreserve.has(word.toUpperCase())) {
      const key = exactPreserve.has(word) ? word : (exactPreserve.has(word.toLowerCase()) ? word.toLowerCase() : word.toUpperCase())
      return exactPreserve.get(key)
    }

    // Check if word is in preserve list (case-insensitive check)
    if (preserveWords.has(word.toUpperCase())) {
      return word.toUpperCase()
    }

    // Check if word contains special characters like &
    if (word === '&') {
      return word
    }

    // First word: capitalize first letter, lowercase rest
    if (index === 0) {
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    }

    // Subsequent words: lowercase
    return word.toLowerCase()
  }).join(' ')
}

module.exports = toSentenceCase
