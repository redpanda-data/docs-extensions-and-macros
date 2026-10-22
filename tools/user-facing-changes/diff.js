'use strict'

/**
 * Unified diff parsing for the user-facing change detectors.
 *
 * Every detector compares the two sides of a change rather than reading
 * hunks directly, because a hunk is a window: a changed default inside a
 * property initializer shows as `-128` / `+256` with the description as
 * context and the property's name three lines above the window
 * (streaming-enterprise PR 203 is exactly that). The parser here keeps
 * both line numberings per hunk line so a detector can rebuild each side
 * of a file from the hunks when no checkout is available, and can quote
 * the hunk lines that cover a declaration as evidence.
 */

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/**
 * Parse unified diff text (any -U context, including --unified=0).
 *
 * @param {string} diffText
 * @returns {Array<{path: string, oldPath: string, isNew: boolean, isDeleted: boolean, isBinary: boolean,
 *   hunks: Array<{oldStart: number, oldCount: number, newStart: number, newCount: number, header: string,
 *   lines: Array<{sign: string, text: string, oldLine: number|null, newLine: number|null}>}>}>}
 */
function parseDiff (diffText) {
  const files = []
  let file = null
  let hunk = null
  let oldLine = 0
  let newLine = 0
  const lines = String(diffText || '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const fh = FILE_HEADER.exec(raw)
    if (fh) {
      file = { path: fh[2], oldPath: fh[1], isNew: false, isDeleted: false, isBinary: false, hunks: [] }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    if (hunk === null || !raw.length || !' +-\\'.includes(raw[0]) || raw.startsWith('+++ ') || raw.startsWith('--- ')) {
      // Between the file header and the first hunk, or a malformed line.
      if (/^new file mode/.test(raw)) file.isNew = true
      else if (/^deleted file mode/.test(raw)) file.isDeleted = true
      else if (/^Binary files /.test(raw) || /^GIT binary patch/.test(raw)) file.isBinary = true
      else if (raw.startsWith('rename to ')) file.path = raw.slice('rename to '.length)
      else if (raw.startsWith('rename from ')) file.oldPath = raw.slice('rename from '.length)
      else if (raw.startsWith('+++ b/')) file.path = raw.slice(6)
      else if (raw.startsWith('--- a/')) file.oldPath = raw.slice(6)
      const hh = HUNK_HEADER.exec(raw)
      if (hh) {
        hunk = {
          oldStart: parseInt(hh[1], 10),
          oldCount: hh[2] === undefined ? 1 : parseInt(hh[2], 10),
          newStart: parseInt(hh[3], 10),
          newCount: hh[4] === undefined ? 1 : parseInt(hh[4], 10),
          header: hh[5].trim(),
          lines: []
        }
        file.hunks.push(hunk)
        oldLine = hunk.oldStart
        newLine = hunk.newStart
      }
      continue
    }
    const hh = HUNK_HEADER.exec(raw)
    if (hh) {
      hunk = {
        oldStart: parseInt(hh[1], 10),
        oldCount: hh[2] === undefined ? 1 : parseInt(hh[2], 10),
        newStart: parseInt(hh[3], 10),
        newCount: hh[4] === undefined ? 1 : parseInt(hh[4], 10),
        header: hh[5].trim(),
        lines: []
      }
      file.hunks.push(hunk)
      oldLine = hunk.oldStart
      newLine = hunk.newStart
      continue
    }
    const sign = raw[0]
    if (sign === '\\') continue // "\ No newline at end of file"
    const text = raw.slice(1)
    if (sign === ' ') {
      hunk.lines.push({ sign, text, oldLine, newLine })
      oldLine++
      newLine++
    } else if (sign === '-') {
      hunk.lines.push({ sign, text, oldLine, newLine: null })
      oldLine++
    } else if (sign === '+') {
      hunk.lines.push({ sign, text, oldLine: null, newLine })
      newLine++
    }
  }
  return files
}

/**
 * Rebuild one side of a file from its hunks alone: each hunk becomes a
 * snippet of that side's text (context plus that side's own lines) with
 * the line number its first line has on that side. A declaration that
 * starts above the hunk or ends below it is cut, which the parsers detect
 * as unbalanced and report as unresolved rather than guess at.
 *
 * @param {object} file - one entry from parseDiff
 * @param {'base'|'head'} side
 * @returns {Array<{startLine: number, text: string}>}
 */
function sideSnippets (file, side) {
  const own = side === 'base' ? '-' : '+'
  const snippets = []
  for (const hunk of file.hunks) {
    const kept = hunk.lines.filter((l) => l.sign === ' ' || l.sign === own)
    if (kept.length === 0) continue
    snippets.push({
      startLine: side === 'base' ? hunk.oldStart : hunk.newStart,
      text: kept.map((l) => l.text).join('\n'),
      // git's function-context hint: the enclosing declaration, which a
      // parser can use when the opener itself is above the window.
      header: hunk.header
    })
  }
  return snippets
}

/**
 * The lines on `side` of the diff that changed (own-side lines only).
 * @returns {Set<number>}
 */
function changedLines (file, side) {
  const own = side === 'base' ? '-' : '+'
  const key = side === 'base' ? 'oldLine' : 'newLine'
  const out = new Set()
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) if (l.sign === own) out.add(l[key])
  }
  return out
}

const EXCERPT_LIMIT = 12

/**
 * The diff lines that cover [from, to] on `side`, as evidence: the hunk
 * header first, then each line with its sign. Capped, so a finding never
 * carries a whole file. When the span meets no hunk (the change is on the
 * other side of a pairing), the hunk nearest the span is quoted instead.
 *
 * @param {object} file - one entry from parseDiff
 * @param {'base'|'head'} side
 * @param {number} from
 * @param {number} to
 * @returns {string}
 */
function excerpt (file, side, from, to) {
  const key = side === 'base' ? 'oldLine' : 'newLine'
  const startKey = side === 'base' ? 'oldStart' : 'newStart'
  const countKey = side === 'base' ? 'oldCount' : 'newCount'
  let picked = file.hunks.filter((h) => h[startKey] <= to && h[startKey] + Math.max(h[countKey], 1) - 1 >= from)
  let whole = false
  if (picked.length === 0 && file.hunks.length > 0) {
    const distance = (h) => Math.min(Math.abs(h[startKey] - from), Math.abs(h[startKey] + h[countKey] - to))
    picked = [[...file.hunks].sort((a, b) => distance(a) - distance(b))[0]]
    whole = true
  }
  const out = []
  for (const hunk of picked) {
    const lines = hunk.lines.filter((l) => {
      if (whole) return true
      const n = l[key]
      // Lines on the other side only (no number on this side) are kept when
      // they sit inside the span's window, so a -/+ pair stays together.
      if (n === null) return true
      return n >= from && n <= to
    })
    // Trim other-side-only lines that fall outside the window: keep those
    // adjacent to a kept same-side line.
    const keep = new Array(lines.length).fill(false)
    for (let i = 0; i < lines.length; i++) {
      if (lines[i][key] !== null) {
        keep[i] = true
        for (let j = i - 1; j >= 0 && lines[j][key] === null; j--) keep[j] = true
        for (let j = i + 1; j < lines.length && lines[j][key] === null; j++) keep[j] = true
      }
    }
    const kept = whole ? lines : lines.filter((_, i) => keep[i])
    if (kept.length === 0) continue
    out.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${hunk.header ? ' ' + hunk.header : ''}`)
    for (const l of kept) out.push(`${l.sign}${l.text}`)
    if (out.length >= EXCERPT_LIMIT) break
  }
  if (out.length > EXCERPT_LIMIT) {
    const cut = out.length - EXCERPT_LIMIT
    out.length = EXCERPT_LIMIT
    out.push(`... ${cut} more line(s)`)
  }
  return out.join('\n')
}

module.exports = { parseDiff, sideSnippets, changedLines, excerpt, EXCERPT_LIMIT }
