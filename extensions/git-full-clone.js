'use strict'

/**
 * Configure Antora to use full git clones instead of shallow clones.
 * This is needed for accurate git dates from the full commit history.
 *
 * Overrides the default shallow clone behavior by modifying content sources
 * to set git depth to 0 (full clone).
 */

module.exports.register = function ({ config }) {
  const logger = this.getLogger('git-full-clone-extension')

  this.once('playbookBuilt', ({ playbook }) => {
    // Modify each content source to use full clones
    if (playbook.content && playbook.content.sources) {
      playbook.content.sources.forEach(source => {
        if (source.url && source.url.startsWith('http')) {
          // Set git depth to 0 for remote repos (full clone)
          if (!source.git) source.git = {}
          source.git.depth = 0
        }
      })
      logger.info('Configured remote content sources to use full git clones (depth=0)')
    }
  })
}
