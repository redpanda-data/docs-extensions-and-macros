'use strict'

const { execFileSync } = require('child_process')

/**
 * The lines a unified diff adds or changes, per file: a map of repo-relative
 * path -> Set of new-side line numbers. A file listed with no hunks (a binary
 * file, or a mode change) maps to 'all', so a check that scopes by line
 * treats all of it as changed. Deleted files are not listed.
 *
 * @param {string} text - Output of `git diff` (any context size).
 * @returns {Map<string, Set<number>|'all'>}
 */
function changedLines (text) {
  const changed = new Map()
  let current = null
  let newLine = 0
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/)
      current = m ? m[2] : null
      if (current) changed.set(current, 'all')
      continue
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim()
      if (target === '/dev/null') {
        if (current) changed.delete(current)
        current = null
      } else {
        current = target.replace(/^b\//, '')
        if (!changed.has(current)) changed.set(current, 'all')
      }
      continue
    }
    if (line.startsWith('--- ') || current === null) continue
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      if (changed.get(current) === 'all') changed.set(current, new Set())
      newLine = Number(hunk[1])
      continue
    }
    const lines = changed.get(current)
    if (!(lines instanceof Set)) continue
    if (line.startsWith('+')) {
      lines.add(newLine)
      newLine++
    } else if (line.startsWith(' ')) {
      newLine++
    }
  }
  return changed
}

/**
 * changedLines() for `git diff <base>...HEAD` in `cwd`: what the branch
 * changed since it left <base>, not what <base> gained since.
 */
function changedLinesSince (base, cwd) {
  const text = execFileSync('git', ['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U0', `${base}...HEAD`],
    { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return changedLines(text)
}

module.exports = { changedLines, changedLinesSince }
