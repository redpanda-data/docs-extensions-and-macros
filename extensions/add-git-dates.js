'use strict'

/**
 * Adds Git commit dates to pages as attributes.
 *
 * This extension:
 * 1. Gets the first commit date (when file was created) -> page-git-created-date
 * 2. Gets the last commit date (when file was modified) -> page-git-modified-date
 * 3. Adds these to page.asciidoc.attributes with page- prefix for UI template access
 *
 * Supports both local repos (with worktree) and remote repos (bare clones with gitdir).
 * Antora caches remote repos as bare Git repos in ~/.cache/antora/content/
 *
 * Attribute naming: Uses page- prefix so attributes appear in page.attributes
 * in Handlebars templates (Antora strips the prefix when exposing to UI model).
 * - page.asciidoc.attributes['page-git-created-date'] -> page.attributes['git-created-date']
 * - page.asciidoc.attributes['page-git-modified-date'] -> page.attributes['git-modified-date']
 *
 * IMPORTANT: This extension listens to 'documentsConverted' so dates are set after
 * Antora builds page.asciidoc.attributes but before pagesComposed when other extensions
 * (like convert-to-markdown) generate output. The dates are used in:
 * - Structured data (JSON-LD datePublished/dateModified)
 * - Markdown frontmatter export (page-git-created-date, page-git-modified-date)
 *
 * Performance optimizations:
 * - Uses parallel async execution with concurrency limit (default: 20)
 * - Uses native git commands (not isomorphic-git) for faster execution
 * - Supports both -C (worktree) and --git-dir (bare repo) modes
 *
 * Only runs on pages that have origin info (skips virtual/generated pages).
 */

const { execFile } = require('child_process')
const { promisify } = require('util')
const path = require('path')

const execFileAsync = promisify(execFile)

// Concurrency limit for parallel git operations
const CONCURRENCY_LIMIT = 20

/**
 * Process a batch of promises with concurrency limit
 * @param {Array<Function>} tasks - Array of functions that return promises
 * @param {number} limit - Maximum concurrent operations
 * @returns {Promise<Array>} - Results array
 */
async function processWithConcurrency (tasks, limit) {
  const results = []
  const executing = new Set()

  for (const task of tasks) {
    const promise = Promise.resolve().then(() => task())
    results.push(promise)
    executing.add(promise)

    const clean = () => executing.delete(promise)
    promise.then(clean, clean)

    if (executing.size >= limit) {
      await Promise.race(executing)
    }
  }

  return Promise.all(results)
}

/**
 * Get git dates for a single file
 * @param {string} gitPath - Git worktree path OR bare gitdir path
 * @param {string} filePath - Relative file path
 * @param {boolean} isBareRepo - Whether this is a bare repo (use --git-dir instead of -C)
 * @returns {Promise<{created: string|null, modified: string|null}>}
 */
async function getGitDates (gitPath, filePath, isBareRepo = false) {
  try {
    // Build git args based on repo type
    const gitArgs = isBareRepo
      ? ['--git-dir', gitPath, 'log']
      : ['-C', gitPath, 'log']

    // Run both git log commands in parallel
    const [createdResult, modifiedResult] = await Promise.all([
      // Get first commit date (oldest commit for this file)
      execFileAsync('git', [...gitArgs, '--format=%aI', '--reverse', '--', filePath], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      }).catch(() => ({ stdout: '' })),

      // Get last commit date (most recent commit)
      execFileAsync('git', [...gitArgs, '-1', '--format=%aI', '--', filePath], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      }).catch(() => ({ stdout: '' })),
    ])

    const createdDateOutput = createdResult.stdout.split('\n')[0].trim()
    const modifiedDateOutput = modifiedResult.stdout.trim()

    return {
      created: createdDateOutput ? new Date(createdDateOutput).toISOString().substring(0, 10) : null,
      modified: modifiedDateOutput ? new Date(modifiedDateOutput).toISOString().substring(0, 10) : null,
    }
  } catch (error) {
    return { created: null, modified: null, error: error.message }
  }
}

module.exports.register = function () {
  const logger = this.getLogger('add-git-dates-extension')

  // Run on documentsConverted after Antora builds page.asciidoc.attributes
  // This event runs after AsciiDoc processing but before pagesComposed
  this.on('documentsConverted', async ({ contentCatalog }) => {
    const startTime = Date.now()
    let processedCount = 0
    let skippedCount = 0
    let errorCount = 0

    // Collect pages that need processing
    const pagesToProcess = []

    contentCatalog.getPages().forEach((page) => {
      // Skip pages without origin (virtual/generated pages)
      const origin = page.src?.origin
      if (!origin?.url) {
        skippedCount++
        return
      }

      // Need either worktree (local/checked-out repos) or gitdir (bare repos from remote)
      const worktree = origin.worktree
      const gitdir = origin.gitdir
      if (!worktree && !gitdir) {
        skippedCount++
        return
      }

      // Ensure asciidoc.attributes exists
      if (!page.asciidoc) page.asciidoc = {}
      if (!page.asciidoc.attributes) page.asciidoc.attributes = {}

      const startPath = origin.startPath || ''
      const relativeFilePath = startPath ? path.join(startPath, page.src.path) : page.src.path

      // Use worktree if available (local repos), otherwise use bare gitdir (remote repos)
      const gitPath = worktree || gitdir
      const isBareRepo = !worktree && !!gitdir

      pagesToProcess.push({ page, gitPath, relativeFilePath, isBareRepo })
    })

    logger.info(`Processing ${pagesToProcess.length} pages for git dates (skipped ${skippedCount} virtual/generated pages)`)

    // Create tasks for parallel processing
    const tasks = pagesToProcess.map(({ page, gitPath, relativeFilePath, isBareRepo }) => async () => {
      const dates = await getGitDates(gitPath, relativeFilePath, isBareRepo)

      if (dates.created) {
        page.asciidoc.attributes['page-git-created-date'] = dates.created
      }
      if (dates.modified) {
        page.asciidoc.attributes['page-git-modified-date'] = dates.modified
      }

      return dates.error ? 'error' : 'success'
    })

    // Process with concurrency limit
    const results = await processWithConcurrency(tasks, CONCURRENCY_LIMIT)

    // Count results
    results.forEach((result) => {
      if (result === 'success') {
        processedCount++
      } else {
        errorCount++
      }
    })

    const duration = Date.now() - startTime
    const perPage = pagesToProcess.length > 0 ? (duration / pagesToProcess.length).toFixed(1) : 0
    logger.info(`Git dates added: processed=${processedCount}, skipped=${skippedCount}, errors=${errorCount}, duration=${duration}ms (${perPage}ms/page)`)
  })
}
