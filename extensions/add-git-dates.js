'use strict'

/**
 * Adds Git commit dates to pages as attributes.
 *
 * This extension:
 * 1. Gets the first commit date (when file was created) -> git-created-date
 * 2. Gets the last commit date (when file was modified) -> git-modified-date
 * 3. Adds these to page.asciidoc.attributes for use in templates and Markdown export
 *
 * IMPORTANT: This extension listens to 'documentsConverted' (before template rendering)
 * so that the dates are available to Handlebars helpers that query contentCatalog during
 * template rendering. The dates are used in:
 * - Structured data (JSON-LD datePublished/dateModified)
 * - Markdown frontmatter export (git-created-date, git-modified-date)
 *
 * Performance note: Uses git log with file paths to minimize overhead.
 * Only runs on pages that have origin info (skips virtual/generated pages).
 */

const { execFileSync } = require('child_process')
const path = require('path')

module.exports.register = function () {
  const logger = this.getLogger('add-git-dates-extension')

  this.on('documentsConverted', ({ contentCatalog }) => {
    const startTime = Date.now()
    let processedCount = 0
    let skippedCount = 0
    let errorCount = 0

    contentCatalog.getPages().forEach((page) => {
      // Skip pages without origin (virtual/generated pages)
      if (!page.src?.origin?.url || !page.src?.origin?.worktree) {
        skippedCount++
        return
      }

      // Skip if not a Git repository
      if (page.src.origin.url.startsWith('http') && !page.src.origin.gitdir) {
        skippedCount++
        return
      }

      try {
        // Ensure asciidoc.attributes exists
        if (!page.asciidoc) page.asciidoc = {}
        if (!page.asciidoc.attributes) page.asciidoc.attributes = {}

        const worktree = page.src.origin.worktree
        const startPath = page.src.origin.startPath || ''
        const relativeFilePath = startPath ? path.join(startPath, page.src.path) : page.src.path

        // Get first commit date (when file was created)
        // --follow tracks file renames
        // --diff-filter=A finds the commit where file was added
        // --reverse shows oldest commits first
        const createdDateOutput = execFileSync(
          'git',
          ['-C', worktree, 'log', '--follow', '--diff-filter=A', '--format=%aI', '--reverse', '--', relativeFilePath],
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
        ).split('\n')[0].trim()

        // Get last commit date (when file was last modified)
        const modifiedDateOutput = execFileSync(
          'git',
          ['-C', worktree, 'log', '-1', '--format=%aI', '--', relativeFilePath],
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
        ).trim()

        if (createdDateOutput) {
          // Convert to YYYY-MM-DD format for consistency with other dates
          const createdDate = new Date(createdDateOutput).toISOString().substring(0, 10)
          page.asciidoc.attributes['git-created-date'] = createdDate
        }

        if (modifiedDateOutput) {
          // Convert to YYYY-MM-DD format
          const modifiedDate = new Date(modifiedDateOutput).toISOString().substring(0, 10)
          page.asciidoc.attributes['git-modified-date'] = modifiedDate
        }

        processedCount++
      } catch (error) {
        errorCount++
        logger.debug(`Failed to get Git dates for ${page.src.path}: ${error.message}`)
      }
    })

    const duration = Date.now() - startTime
    logger.info(`Git dates added: processed=${processedCount}, skipped=${skippedCount}, errors=${errorCount}, duration=${duration}ms`)
  })
}
