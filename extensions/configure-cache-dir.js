'use strict'

/**
 * Configure Antora cache directory from environment variable.
 * This enables Netlify (or other CI) to cache git repositories between builds.
 *
 * Set ANTORA_CACHE_DIR environment variable to a relative path in your build directory.
 * Netlify automatically caches `.cache` directory between builds.
 */

const path = require('path')

module.exports.register = function ({ config }) {
  const logger = this.getLogger('configure-cache-dir-extension')

  this.once('playbookBuilt', ({ playbook }) => {
    const cacheDirEnv = process.env.ANTORA_CACHE_DIR

    if (cacheDirEnv) {
      // Convert relative path to absolute
      const cacheDir = path.isAbsolute(cacheDirEnv)
        ? cacheDirEnv
        : path.join(process.cwd(), cacheDirEnv)

      // Set runtime cache directory
      if (!playbook.runtime) playbook.runtime = {}
      if (!playbook.runtime.cache_dir) {
        playbook.runtime.cache_dir = cacheDir
        logger.info(`Using custom cache directory: ${cacheDir}`)
      }
    }
  })
}
