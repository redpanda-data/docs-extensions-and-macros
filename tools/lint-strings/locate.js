'use strict'

/**
 * Locate a rule's finding on the source lines of its declaration, so diff
 * mode can report only what a PR's changed lines contain.
 *
 * Diff mode lints every declaration a PR touches, and a long description is
 * one declaration however many lines it spans. Without this, a PR that edits
 * one line of a connector's Description gets findings for every untouched
 * paragraph of it, and the review then comments on lines the PR never
 * changed (redpanda-data/connect#4860).
 *
 * A rule opts in by giving each issue `at`: the offsets in decl.string of the
 * offending text, as [{ index, length, label? }]. An issue with no `at` is
 * about the declaration as a whole (a missing description, a name echo) and is
 * kept whenever the declaration was changed. A rule can also give
 * `messageFor(kept)`, which rewrites the message to name only the offsets that
 * survive, so a finding listing five bare tokens names just the one on the
 * changed line.
 */

// How far past the previous match a word may be found before it counts as
// missing. The gap between two literals of one string is quotes, a `+`, a
// newline and indentation; a word further away than this is not the next
// word of the string, and matching it would misalign every word after it.
const MAX_GAP = 200

/**
 * Map each offset of decl.string to the source line it was written on.
 *
 * Strings reach the linter from Go raw strings, concatenated literals,
 * clang-format-wrapped C++ literals, proto and YAML comments, so there is no
 * one transform to invert. Instead the string's words (runs of letters,
 * digits and underscores, which survive every one of those encodings) are
 * found in the declaration's source text in order, each searched for just
 * after the previous one. A word that is not found nearby (an escape, a
 * value built at runtime) is left unmapped rather than guessed.
 *
 * @returns {Array<{start, end, line}>|null} Mapped words in string order, or
 *   null when the declaration has no source text to map against
 */
function wordLines (decl) {
  const text = decl.string
  const source = decl.declaration_text
  if (typeof text !== 'string' || typeof source !== 'string' || decl.line_start == null) return null

  // Line number of each source offset, computed once.
  const lineStarts = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1)
  const lineAt = (offset) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return decl.line_start + lo
  }

  const words = []
  let cursor = 0
  const re = /[A-Za-z0-9_]+/g
  let match
  while ((match = re.exec(text)) !== null) {
    const found = source.indexOf(match[0], cursor)
    // The first word may sit after any amount of call syntax.
    if (found === -1 || (words.length > 0 && found - cursor > MAX_GAP + match[0].length)) continue
    words.push({ start: match.index, end: match.index + match[0].length, line: lineAt(found) })
    cursor = found + match[0].length
  }
  return words
}

/**
 * Source lines that a string range [index, index + length) sits on. A range
 * with no word of its own (an em dash, a backtick) takes the lines of the
 * words either side of it, since it was written on one of them. Empty when
 * the range cannot be placed.
 */
function linesOfRange (words, index, length) {
  const end = index + Math.max(length, 1)
  const inside = words.filter((w) => w.start < end && w.end > index)
  if (inside.length > 0) return [...new Set(inside.map((w) => w.line))]
  let before = null
  let after = null
  for (const w of words) {
    if (w.end <= index) before = w
    else if (w.start >= end) { after = w; break }
  }
  if (!before || !after) return []
  return [...new Set([before.line, after.line])]
}

/**
 * Decide whether an issue stays in a diff-mode report.
 *
 * @param {Object} decl - The declaration the issue was raised on
 * @param {Object} issue - The rule's issue ({ message, at?, messageFor? })
 * @param {Set<number>} lineSet - Lines the diff changed in decl.file
 * @param {Function} getWords - () => wordLines(decl), memoized by the caller
 * @returns {{ keep: boolean, message?: string, line?: number }}
 */
function filterIssue (decl, issue, lineSet, getWords) {
  const at = Array.isArray(issue.at) ? issue.at : []
  if (at.length === 0) return { keep: true, message: issue.message }
  const words = getWords()
  if (!words) return { keep: true, message: issue.message }

  const kept = []
  let line = null
  for (const entry of at) {
    const lines = linesOfRange(words, entry.index, entry.length || 0)
    // Text that cannot be placed is kept: missing a finding the PR made is
    // worse than repeating one it did not.
    if (lines.length === 0) {
      kept.push(entry)
      continue
    }
    const changed = lines.filter((l) => lineSet && lineSet.has(l))
    if (changed.length === 0) continue
    kept.push(entry)
    const first = Math.min(...changed)
    if (line === null || first < line) line = first
  }

  if (kept.length === 0) return { keep: false }
  const message = kept.length < at.length && typeof issue.messageFor === 'function'
    ? issue.messageFor(kept)
    : issue.message
  return line === null ? { keep: true, message } : { keep: true, message, line }
}

module.exports = { wordLines, linesOfRange, filterIssue, MAX_GAP }
