'use strict'

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

/**
 * Configure Antora to use full git clones instead of shallow clones.
 * This is needed for accurate git dates from the full commit history.
 *
 * Two-phase approach:
 * 1. Set depth=0 in playbook to request full clones (doesn't always work due to Antora internals)
 * 2. After content aggregation, unshallow any repos that are still shallow
 *
 * Configuration options:
 * - skipUnshallow: Set to true to skip the unshallow phase (for air-gapped environments)
 * - unshallowTimeout: Timeout in milliseconds per repo (default: 60000)
 *
 * Example:
 * antora:
 *   extensions:
 *   - require: '@redpanda-data/docs-extensions-and-macros/extensions/git-full-clone'
 *     skipUnshallow: false
 *     unshallowTimeout: 120000  # 2 minutes for very large repos
 *
 * Production considerations:
 * - First build will unshallow repos (~1-5 seconds per repo)
 * - Subsequent builds with warm cache skip unshallow (already full clones)
 * - Large repos (10k+ commits) may take longer - increase timeout if needed
 * - Requires network access during build (for git fetch --unshallow)
 * - For CI/CD, consider pre-populating Antora cache with full clones
 */

module.exports.register = function ({ config, playbook }) {
  const logger = this.getLogger('git-full-clone-extension')

  logger.info('✓ git-full-clone extension loaded')

  // Phase 1: Try modifying playbook during registration
  if (playbook?.content?.sources) {
    logger.info('Phase 1: Modifying playbook during registration')
    let remoteCount = 0
    playbook.content.sources.forEach(source => {
      if (source.url && source.url.startsWith('http')) {
        const oldDepth = source.git?.depth
        if (!source.git) source.git = {}
        source.git.depth = 0
        remoteCount++
        logger.info(`  → ${source.url}: depth ${oldDepth || 'default'} → 0 (full clone)`)
      }
    })
    logger.info(`✓ Configured ${remoteCount} remote content sources for full clones`)
  }

  // Phase 2: After content is aggregated, unshallow any repos that are still shallow
  this.on('contentAggregated', ({ contentAggregate }) => {
    // Allow disabling unshallow phase via config (for air-gapped environments or if git dates not needed)
    const skipUnshallow = config?.skipUnshallow || false
    if (skipUnshallow) {
      logger.info('Phase 2: Skipping unshallow (skipUnshallow: true)')
      return
    }

    logger.info('Phase 2: Checking for shallow clones to unshallow')
    const processedRepos = new Set()
    let unshallowedCount = 0
    const unshallowTimeout = config?.unshallowTimeout || 60000 // Default 60 seconds per repo

    for (const aggregate of contentAggregate) {
      for (const origin of aggregate.origins || []) {
        const gitdir = origin.gitdir
        if (!gitdir || processedRepos.has(gitdir)) continue
        processedRepos.add(gitdir)

        // Check if this is a shallow clone
        const shallowFile = path.join(gitdir, 'shallow')
        if (fs.existsSync(shallowFile)) {
          const startTime = Date.now()
          try {
            logger.info(`  → Unshallowing ${path.basename(gitdir)}...`)

            // Use git fetch --unshallow to convert to full clone
            execSync('git fetch --unshallow', {
              cwd: gitdir,
              stdio: 'pipe',
              timeout: unshallowTimeout,
              env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
            })

            const duration = Date.now() - startTime
            unshallowedCount++
            logger.info(`    ✓ Successfully unshallowed ${path.basename(gitdir)} (${duration}ms)`)
          } catch (err) {
            const duration = Date.now() - startTime
            if (err.killed) {
              logger.warn(`    ✗ Unshallow timeout after ${duration}ms for ${path.basename(gitdir)} (increase unshallowTimeout if needed)`)
            } else {
              logger.warn(`    ✗ Failed to unshallow ${path.basename(gitdir)}: ${err.message}`)
            }
            logger.warn(`    ⚠️  Git dates may be inaccurate for this repo - consider using a pre-cloned cache`)
          }
        } else {
          logger.debug(`  → ${path.basename(gitdir)} is already a full clone`)
        }
      }
    }

    if (unshallowedCount > 0) {
      logger.info(`✓ Unshallowed ${unshallowedCount} repositories`)
    } else {
      logger.info('✓ All repositories are already full clones')
    }
  })
}
