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
 * Performance optimization: Uses isomorphic-git to walk the entire git log ONCE per
 * repository, building a filepath→dates map. This is O(commits) instead of O(files * commits).
 * For a repo with 1000 files and 5000 commits, this reduces operations from 5M to 5K.
 *
 * Attribute naming: Uses page- prefix so attributes appear in page.attributes
 * in Handlebars templates (Antora strips the prefix when exposing to UI model).
 *
 * Only runs on pages that have origin info (skips virtual/generated pages).
 */

const path = require('path')
const fs = require('fs')

/**
 * Resolve isomorphic-git from Antora's dependencies
 * @param {Object} context - Extension context with module info
 * @returns {Object} isomorphic-git module
 */
function requireGit (context) {
  return require(
    require.resolve('isomorphic-git', {
      paths: [require.resolve('@antora/content-aggregator', { paths: context.module.paths }) + '/..']
    })
  )
}

/**
 * Format timestamp to ISO date string (YYYY-MM-DD)
 * @param {number} timestamp - Unix timestamp in seconds
 * @returns {string} ISO date string
 */
function formatDate (timestamp) {
  return new Date(timestamp * 1000).toISOString().substring(0, 10)
}

/**
 * Build a map of filepath -> {created, modified} dates from git log
 * Walks the entire log once, tracking first and last commit for each MODIFIED file
 *
 * This compares each commit's tree with its parent to find which files actually changed,
 * rather than just looking at all files in the tree (which would give incorrect dates).
 *
 * @param {Object} git - isomorphic-git module
 * @param {string} gitdir - Path to .git directory
 * @param {string} ref - Git ref (branch/tag/commit)
 * @param {Object} logger - Logger instance
 * @returns {Promise<Map<string, {created: string, modified: string}>>}
 */
async function buildFileDateMap (git, gitdir, ref, logger) {
  const fileDates = new Map()
  const cache = {}

  try {
    // Get all commits - walking from newest to oldest
    const commits = await git.log({
      fs,
      gitdir,
      ref,
      cache,
    })

    logger.info(`Walking ${commits.length} commits for ${path.basename(gitdir)} (ref: ${ref})`)

    // Build tree cache to avoid re-reading trees
    const treeCache = new Map()

    // Process commits from newest to oldest
    // First occurrence = modified date, last occurrence = created date
    for (let i = 0; i < commits.length; i++) {
      const commit = commits[i]
      const timestamp = commit.commit.committer.timestamp
      const date = formatDate(timestamp)

      try {
        const currentTreeOid = commit.commit.tree
        const parentCommits = commit.commit.parent || []

        // Get files in current commit's tree
        const currentFiles = await getTreeFiles(git, gitdir, currentTreeOid, '', cache, treeCache)

        // Get files in parent commit's tree (if parent exists)
        let parentFiles = new Map()
        if (parentCommits.length > 0) {
          const parentCommit = await git.readCommit({ fs, gitdir, oid: parentCommits[0], cache })
          const parentTreeOid = parentCommit.commit.tree
          parentFiles = await getTreeFiles(git, gitdir, parentTreeOid, '', cache, treeCache)
        }

        // Find files that were added or modified (different OID from parent)
        for (const [filepath, oid] of currentFiles) {
          const parentOid = parentFiles.get(filepath)
          const isModified = !parentOid || parentOid !== oid

          if (isModified) {
            if (!fileDates.has(filepath)) {
              // First time seeing this file modified (from newest commit)
              fileDates.set(filepath, { created: date, modified: date })
            } else {
              // Update created date (older commit where file was modified)
              const entry = fileDates.get(filepath)
              entry.created = date
            }
          }
        }
      } catch (err) {
        // Skip commits that can't be read
        logger.debug(`Skipping commit ${commit.oid.substring(0, 7)}: ${err.message}`)
      }
    }
  } catch (err) {
    logger.warn(`Failed to read git log for ${gitdir}: ${err.message}`)
  }

  return fileDates
}

/**
 * Recursively walk a git tree to get all file paths with their OIDs
 * Returns a Map of filepath → OID for comparison between commits
 *
 * @param {Object} git - isomorphic-git module
 * @param {string} gitdir - Path to .git directory
 * @param {string} oid - Tree object ID
 * @param {string} prefix - Current path prefix
 * @param {Object} cache - Git object cache
 * @param {Map} treeCache - Cache of tree OID → files map
 * @returns {Promise<Map<string, string>>} Map of filepath → blob OID
 */
async function getTreeFiles (git, gitdir, oid, prefix, cache, treeCache) {
  // Check tree cache first
  if (treeCache.has(oid)) {
    return treeCache.get(oid)
  }

  const files = new Map()

  try {
    const { tree } = await git.readTree({
      fs,
      gitdir,
      oid,
      cache,
    })

    for (const entry of tree) {
      const filepath = prefix ? `${prefix}/${entry.path}` : entry.path

      if (entry.type === 'blob') {
        files.set(filepath, entry.oid)
      } else if (entry.type === 'tree') {
        // Recurse into subdirectory
        const subfiles = await getTreeFiles(git, gitdir, entry.oid, filepath, cache, treeCache)
        for (const [subpath, suboid] of subfiles) {
          files.set(subpath, suboid)
        }
      }
    }

    // Cache this tree's files
    treeCache.set(oid, files)
  } catch (err) {
    // Skip trees that can't be read
  }

  return files
}

module.exports.register = function () {
  const logger = this.getLogger('add-git-dates-extension')
  const context = this

  // Run on documentsConverted after Antora builds page.asciidoc.attributes
  this.on('documentsConverted', async ({ contentCatalog }) => {
    const startTime = Date.now()
    let processedCount = 0
    let skippedCount = 0

    // Load isomorphic-git
    let git
    try {
      git = requireGit(context)
    } catch (err) {
      logger.error(`Failed to load isomorphic-git: ${err.message}`)
      return
    }

    // Group pages by BOTH gitdir AND ref (since same repo can have multiple branches/versions)
    const pagesByRepoAndRef = new Map()

    contentCatalog.getPages().forEach((page) => {
      const origin = page.src?.origin
      if (!origin?.url) {
        skippedCount++
        return
      }

      // Need gitdir for isomorphic-git (works for both local and bare repos)
      const gitdir = origin.gitdir || (origin.worktree ? path.join(origin.worktree, '.git') : null)
      if (!gitdir) {
        skippedCount++
        return
      }

      // Ensure asciidoc.attributes exists
      if (!page.asciidoc) page.asciidoc = {}
      if (!page.asciidoc.attributes) page.asciidoc.attributes = {}

      const startPath = origin.startPath || ''
      const relativeFilePath = startPath ? path.join(startPath, page.src.path) : page.src.path
      const ref = origin.refhash || origin.refname || 'HEAD'

      // Create composite key: gitdir + ref to handle multiple branches per repo
      const repoRefKey = `${gitdir}::${ref}`

      // Group by repo AND ref
      if (!pagesByRepoAndRef.has(repoRefKey)) {
        pagesByRepoAndRef.set(repoRefKey, {
          gitdir,
          ref,
          pages: []
        })
      }
      pagesByRepoAndRef.get(repoRefKey).pages.push({ page, relativeFilePath })
    })

    const totalPages = Array.from(pagesByRepoAndRef.values()).reduce((sum, r) => sum + r.pages.length, 0)
    const repoCount = new Set(Array.from(pagesByRepoAndRef.values()).map(r => r.gitdir)).size
    logger.info(`Processing ${totalPages} pages across ${repoCount} repos (${pagesByRepoAndRef.size} branches) for git dates (skipped ${skippedCount} virtual/generated)`)

    // Process each repository + ref combination
    for (const [repoRefKey, { gitdir, ref, pages }] of pagesByRepoAndRef) {
      const repoStartTime = Date.now()

      try {
        // Build the filepath -> dates map for this repo + ref
        const fileDateMap = await buildFileDateMap(git, gitdir, ref, logger)

        // Apply dates to pages
        for (const { page, relativeFilePath } of pages) {
          const dates = fileDateMap.get(relativeFilePath)
          if (dates) {
            page.asciidoc.attributes['page-git-created-date'] = dates.created
            page.asciidoc.attributes['page-git-modified-date'] = dates.modified
            processedCount++
          }
        }

        const repoTime = Date.now() - repoStartTime
        logger.debug(`Processed ${pages.length} pages from ${path.basename(gitdir)}@${ref.substring(0,8)} in ${repoTime}ms (map size: ${fileDateMap.size})`)
      } catch (err) {
        logger.warn(`Failed to process repo ${gitdir}@${ref}: ${err.message}`)
      }
    }

    const duration = Date.now() - startTime
    const perPage = totalPages > 0 ? (duration / totalPages).toFixed(1) : 0
    logger.info(`Git dates added: processed=${processedCount}, skipped=${skippedCount}, duration=${duration}ms (${perPage}ms/page)`)
  })
}
