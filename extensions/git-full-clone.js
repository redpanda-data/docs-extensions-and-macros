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
    logger.info('Phase 2: Checking for shallow clones to unshallow')
    const processedRepos = new Set()
    let unshallowedCount = 0

    for (const aggregate of contentAggregate) {
      for (const origin of aggregate.origins || []) {
        const gitdir = origin.gitdir
        if (!gitdir || processedRepos.has(gitdir)) continue
        processedRepos.add(gitdir)

        // Check if this is a shallow clone
        const shallowFile = path.join(gitdir, 'shallow')
        if (fs.existsSync(shallowFile)) {
          try {
            logger.info(`  → Unshallowing ${path.basename(gitdir)}...`)

            // Use git fetch --unshallow to convert to full clone
            execSync('git fetch --unshallow', {
              cwd: gitdir,
              stdio: 'pipe',
              env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
            })

            unshallowedCount++
            logger.info(`    ✓ Successfully unshallowed ${path.basename(gitdir)}`)
          } catch (err) {
            logger.warn(`    ✗ Failed to unshallow ${path.basename(gitdir)}: ${err.message}`)
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
