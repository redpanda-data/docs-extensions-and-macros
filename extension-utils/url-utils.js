'use strict'

/**
 * Shared URL utility functions for extensions
 */

/**
 * Convert HTML URL to markdown URL
 * @param {string} htmlUrl - The HTML URL (e.g., '/path/to/page/' or '/path/to/page/index.html')
 * @returns {string} - The markdown URL (e.g., '/path/to/page.md')
 */
function toMarkdownUrl(htmlUrl) {
  if (!htmlUrl) return ''

  // Handle root path
  if (htmlUrl === '/' || htmlUrl === '/index.html') {
    return '/index.md'
  }

  // Remove trailing slash
  let mdUrl = htmlUrl.replace(/\/$/, '')

  // Replace /index.html with .md
  mdUrl = mdUrl.replace(/\/index\.html$/, '.md')

  // Replace .html with .md
  mdUrl = mdUrl.replace(/\.html$/, '.md')

  // If it doesn't end with .md yet, add it
  if (!mdUrl.endsWith('.md')) {
    mdUrl += '.md'
  }

  return mdUrl
}

module.exports = {
  toMarkdownUrl,
}
