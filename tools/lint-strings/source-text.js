'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Shared helper for surface modules: read the exact source lines of a
 * declaration span so findings can carry `declaration_text` (the text a PR
 * suggestion block would replace).
 */
class SourceCache {
  constructor (repo) {
    this.repo = repo
    this.files = new Map()
  }

  lines (file) {
    if (!this.files.has(file)) {
      const absPath = path.isAbsolute(file) ? file : path.join(this.repo, file)
      try {
        this.files.set(file, fs.readFileSync(absPath, 'utf8').split('\n'))
      } catch (err) {
        this.files.set(file, null)
      }
    }
    return this.files.get(file)
  }

  /**
   * Exact source text of the inclusive 1-indexed span [lineStart, lineEnd],
   * or null when the file or span is unavailable.
   */
  span (file, lineStart, lineEnd) {
    if (lineStart == null || lineEnd == null) return null
    const lines = this.lines(file)
    if (!lines || lineStart < 1 || lineEnd > lines.length) return null
    return lines.slice(lineStart - 1, lineEnd).join('\n')
  }
}

module.exports = { SourceCache }
