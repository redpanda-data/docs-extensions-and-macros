'use strict'

/**
 * Small source-text helpers shared by the detectors. All of them preserve
 * line structure: a comment is replaced by spaces, never removed, so an
 * offset into the stripped text maps to the same line in the original.
 */

/**
 * True when the `'` at `i` is a C++14 digit separator (`30'000ms`,
 * `0xFF'FF`, `1'000'000'000`) rather than the start of a char literal: it
 * sits between two digits (hex digits included) inside a token that starts
 * with a decimal digit. `u8'a'` and `L'x'` start with a letter, so they stay
 * char literals. Treating a separator as a quote unbalances every bracket
 * after it, which hid any property whose initializer held an odd number of
 * them.
 */
function isDigitSeparator (text, i) {
  if (text[i] !== '\'') return false
  if (!/[0-9A-Fa-f]/.test(text[i - 1] || '') || !/[0-9A-Fa-f]/.test(text[i + 1] || '')) return false
  let j = i - 1
  while (j >= 0 && /[0-9A-Za-z_'.]/.test(text[j])) j--
  return /[0-9]/.test(text[j + 1] || '')
}

/**
 * Replace C, C++ and Go comments with spaces, leaving string literals
 * (including Go raw strings and C++ raw strings) intact. Newlines inside a
 * block comment survive so line counting is unaffected.
 */
function stripComments (text) {
  const src = String(text || '')
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (c === '/' && next === '*') {
      out += '  '
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < n) { out += '  '; i += 2 }
      continue
    }
    if (c === '\'' && isDigitSeparator(src, i)) { out += c; i++; continue }
    if (c === '"' || c === '\'' || c === '`') {
      // C++ raw string: R"delim( ... )delim"
      if (c === '"' && src[i - 1] === 'R' && /[^A-Za-z0-9_]/.test(src[i - 2] || ' ')) {
        const close = src.indexOf('(', i)
        const delim = close === -1 ? null : src.slice(i + 1, close)
        if (delim !== null && /^[^\s()\\]{0,16}$/.test(delim)) {
          const endToken = `)${delim}"`
          const end = src.indexOf(endToken, close)
          const stop = end === -1 ? n : end + endToken.length
          out += src.slice(i, stop)
          i = stop
          continue
        }
      }
      const quote = c
      let j = i + 1
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\' && quote !== '`') j++
        else if (src[j] === '\n' && quote !== '`') break
        j++
      }
      out += src.slice(i, Math.min(j + 1, n))
      i = j + 1
      continue
    }
    out += c
    i++
  }
  return out
}

const PAIRS = { '(': ')', '{': '}', '[': ']' }

/**
 * Index of the bracket that closes the one at `open`, skipping strings and
 * nested brackets of any kind, or -1 when the text ends first. The text
 * must already be comment-free.
 */
function matchBracket (text, open) {
  const stack = []
  const n = text.length
  for (let i = open; i < n; i++) {
    const c = text[i]
    if (c === '"' || c === '\'' || c === '`') {
      if (isDigitSeparator(text, i)) continue
      i = skipString(text, i)
      continue
    }
    if (PAIRS[c]) stack.push(PAIRS[c])
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.length === 0) return -1
      const want = stack.pop()
      if (want !== c) return -1
      if (stack.length === 0) return i
    }
  }
  return -1
}

function skipString (text, i) {
  const quote = text[i]
  const n = text.length
  if (isDigitSeparator(text, i)) return i
  if (quote === '"' && text[i - 1] === 'R') {
    const close = text.indexOf('(', i)
    const delim = close === -1 ? '' : text.slice(i + 1, close)
    const end = text.indexOf(`)${delim}"`, close)
    return end === -1 ? n : end + delim.length + 1
  }
  let j = i + 1
  while (j < n && text[j] !== quote) {
    if (text[j] === '\\' && quote !== '`') j++
    else if (text[j] === '\n' && quote !== '`') return j
    j++
  }
  return j
}

/**
 * Split an argument list at top-level commas. Brackets of all kinds and
 * string literals protect their commas; angle brackets protect theirs only
 * when they read as a template argument list (an identifier, `>` or `:`
 * directly before `<`, and no `>=`, `->` or `>>` operator shapes), so a
 * comparison in a lambda body does not unbalance the split.
 */
function splitArgs (text) {
  const args = []
  let depth = 0
  let angle = 0
  let start = 0
  const n = text.length
  for (let i = 0; i < n; i++) {
    const c = text[i]
    if (c === '"' || c === '\'' || c === '`') { i = skipString(text, i); continue }
    if (PAIRS[c]) { depth++; continue }
    if (c === ')' || c === '}' || c === ']') { depth--; continue }
    if (c === '<') {
      // A template argument list follows its name directly
      // (`std::vector<int, alloc>`); a comparison has a space before `<`
      // (`v < 3`), which is how clang-format writes both.
      const prev = text[i - 1] || ' '
      if (/[A-Za-z0-9_>:]/.test(prev) && text[i + 1] !== '<' && text[i + 1] !== '=') angle++
      continue
    }
    if (c === '>' && angle > 0) {
      if (text[i - 1] === '-' || text[i + 1] === '=') continue
      angle--
      continue
    }
    if (c === ',' && depth === 0 && angle === 0) {
      args.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  const last = text.slice(start).trim()
  if (last.length > 0 || args.length > 0) args.push(last)
  return args
}

/**
 * The value of an argument that is one or more adjacent string literals
 * (`"a" "b"` is one C++ literal), or null when it is anything else.
 */
function literalValue (arg) {
  const s = String(arg || '').trim()
  if (!s.startsWith('"')) return null
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s[i] !== '"') return null
    let j = i + 1
    let piece = ''
    while (j < s.length && s[j] !== '"') {
      if (s[j] === '\\') {
        const esc = s[j + 1]
        piece += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc
        j += 2
        continue
      }
      piece += s[j++]
    }
    if (j >= s.length) return null
    out += piece
    i = j + 1
    while (i < s.length && /\s/.test(s[i])) i++
  }
  return out
}

/** Line number (1-based) of a character offset, relative to `startLine`. */
function lineAt (text, offset, startLine = 1) {
  let line = startLine
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

/** Collapse whitespace so two spellings of one value compare equal. */
function normalize (text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

module.exports = { isDigitSeparator, stripComments, matchBracket, skipString, splitArgs, literalValue, lineAt, normalize }
