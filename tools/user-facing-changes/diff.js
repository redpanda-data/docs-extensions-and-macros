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
const QUOTED_HEADER = /^diff --git (?:"a\/((?:[^"\\]|\\.)*)"|a\/(\S+)) (?:"b\/((?:[^"\\]|\\.)*)"|b\/(.+))$/

/**
 * Undo git's C-style quoting of a path (core.quotePath): `\303\251` is the
 * UTF-8 bytes of an accented letter, `\t` a tab, `\"` a quote.
 */
function unquote (s) {
  const bytes = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); continue }
    const n = s[i + 1]
    if (/[0-7]/.test(n)) { bytes.push(parseInt(s.slice(i + 1, i + 4), 8)); i += 3; continue }
    const map = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }
    bytes.push(map[n] !== undefined ? map[n] : n.charCodeAt(0))
    i++
  }
  return Buffer.from(bytes).toString('utf8')
}

/** A `--- a/x` or `+++ b/x` path: quoted or not, without git's trailing TAB. */
function headerPath (rest) {
  const t = rest.replace(/\t.*$/, '')
  const q = /^"[ab]\/((?:[^"\\]|\\.)*)"$/.exec(t)
  if (q) return unquote(q[1])
  return t.replace(/^[ab]\//, '')
}

function fileHeader (raw) {
  if (!raw.startsWith('diff --git ')) return null
  if (raw.includes('"')) {
    const q = QUOTED_HEADER.exec(raw)
    if (q) return [raw, q[1] !== undefined ? unquote(q[1]) : q[2], q[3] !== undefined ? unquote(q[3]) : q[4]]
  }
  return FILE_HEADER.exec(raw)
}
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
  // Lines the current hunk still holds on each side. While either is
  // positive a line is hunk content, so a removed line whose text starts
  // `-- ` (`--- x` once the sign is added) is never read as a header.
  let remOld = 0
  let remNew = 0
  const lines = String(diffText || '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const inHunk = hunk !== null && (remOld > 0 || remNew > 0) && raw.length > 0 && ' +-\\'.includes(raw[0])
    const fh = inHunk ? null : fileHeader(raw)
    if (fh) {
      file = { path: fh[2], oldPath: fh[1], isNew: false, isDeleted: false, isBinary: false, hunks: [] }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    if (!inHunk && (hunk === null || !raw.length || !' +-\\'.includes(raw[0]) || raw.startsWith('+++ ') || raw.startsWith('--- '))) {
      // Between the file header and the first hunk, or a malformed line.
      if (/^new file mode/.test(raw)) file.isNew = true
      else if (/^deleted file mode/.test(raw)) file.isDeleted = true
      else if (/^Binary files /.test(raw) || /^GIT binary patch/.test(raw)) file.isBinary = true
      else if (raw.startsWith('rename to ')) file.path = headerPath(raw.slice('rename to '.length).replace(/^"(.*)"$/, '"b/$1"'))
      else if (raw.startsWith('rename from ')) file.oldPath = headerPath(raw.slice('rename from '.length).replace(/^"(.*)"$/, '"a/$1"'))
      else if (raw.startsWith('+++ b/') || raw.startsWith('+++ "b/')) file.path = headerPath(raw.slice(4))
      else if (raw.startsWith('--- a/') || raw.startsWith('--- "a/')) file.oldPath = headerPath(raw.slice(4))
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
        remOld = hunk.oldCount
        remNew = hunk.newCount
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
      remOld = hunk.oldCount
      remNew = hunk.newCount
      continue
    }
    const sign = raw[0]
    if (sign === '\\') continue // "\ No newline at end of file"
    const text = raw.slice(1)
    if (sign === ' ') {
      hunk.lines.push({ sign, text, oldLine, newLine })
      oldLine++
      newLine++
      remOld--
      remNew--
    } else if (sign === '-') {
      hunk.lines.push({ sign, text, oldLine, newLine: null })
      oldLine++
      remOld--
    } else if (sign === '+') {
      hunk.lines.push({ sign, text, oldLine: null, newLine })
      newLine++
      remNew--
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
    // Same-side lines inside the window, plus the other side's lines that
    // touch one of them in the hunk itself (a -/+ pair stays together).
    // Adjacency is judged on the hunk as written, so a deleted line that a
    // context line separates from the window is not pulled in.
    const all = hunk.lines
    const inWindow = (l) => l[key] !== null && l[key] >= from && l[key] <= to
    const keep = all.map((l) => whole || inWindow(l))
    if (!whole) {
      for (let i = 0; i < all.length; i++) {
        if (!inWindow(all[i])) continue
        for (let j = i - 1; j >= 0 && all[j][key] === null; j--) keep[j] = true
        for (let j = i + 1; j < all.length && all[j][key] === null; j++) keep[j] = true
      }
    }
    const kept = all.filter((_, i) => keep[i])
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
