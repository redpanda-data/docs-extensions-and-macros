'use strict'

/**
 * The only registry of docs language server features. Each entry is a feature
 * module (see dispatch.js for the contract). Keep it alphabetical by file,
 * one line per module, so parallel feature PRs conflict on one line at most.
 */

module.exports = [
  require('./metadata'),
  require('./properties'),
]
