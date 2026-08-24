'use strict'

/**
 * Shared Go source scanning helpers for the rpk, crd, and connect surfaces.
 *
 * Same philosophy as the metrics scanner (surfaces/metrics.js): a
 * comment-masked regex/paren scanner over real source text, never a compiler.
 * Go adds two string shapes the C++ scanner does not have: raw strings
 * (`...` backticks, no escapes, literal newlines) and rune literals ('x').
 * All helpers preserve offsets and newlines so line numbers stay exact.
 */

/**
 * Replace // and /* *\/ comments with spaces, preserving every offset and
 * newline. String and rune literal contents are left untouched, so a "//"
 * inside a string never masks anything.
 */
function maskComments (content) {
  const out = content.split('')
  let i = 0
  while (i < content.length) {
    const ch = content[i]
    if (ch === '"' || ch === '`' || ch === "'") {
      i = skipString(content, i)
      continue
    }
    if (ch === '/' && content[i + 1] === '/') {
      while (i < content.length && content[i] !== '\n') out[i++] = ' '
      continue
    }
    if (ch === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2)
      const stop = end === -1 ? content.length : end + 2
      while (i < stop) {
        if (content[i] !== '\n') out[i] = ' '
        i++
      }
      continue
    }
    i++
  }
  return out.join('')
}

/**
 * Skip a Go string/rune literal starting at index; returns the index after
 * it. Interpreted strings ("...") and runes ('x') honor backslash escapes;
 * raw strings (`...`) have no escapes and may span lines.
 */
function skipString (content, start) {
  const quote = content[start]
  let i = start + 1
  if (quote === '`') {
    while (i < content.length && content[i] !== '`') i++
    return Math.min(i + 1, content.length)
  }
  while (i < content.length) {
    if (content[i] === '\\') {
      i += 2
      continue
    }
    if (content[i] === quote) return i + 1
    i++
  }
  return content.length
}

/**
 * Walk forward from an opening delimiter and return the index of its
 * balanced closing delimiter, skipping string/rune literals. Assumes
 * comment-masked content. Returns -1 when unbalanced.
 */
function findBalancedClose (content, openIndex, open = '(', close = ')') {
  let depth = 0
  let i = openIndex
  while (i < content.length) {
    const ch = content[i]
    if (ch === '"' || ch === '`' || ch === "'") {
      i = skipString(content, i)
      continue
    }
    if (ch === open) depth++
    if (ch === close) {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

/** Decode a Go interpreted-string body (the text between the quotes). */
function unescapeGo (text) {
  return text.replace(/\\(.)/g, (whole, ch) => {
    if (ch === 'n') return '\n'
    if (ch === 't') return '\t'
    if (ch === 'r') return '\r'
    return ch
  })
}

/**
 * Split argument text on top-level commas (string, paren, brace, and
 * bracket aware). Assumes comment-masked content.
 */
function splitTopLevelArgs (argText) {
  const args = []
  let start = 0
  let depth = 0
  let i = 0
  while (i < argText.length) {
    const ch = argText[i]
    if (ch === '"' || ch === '`' || ch === "'") {
      i = skipString(argText, i)
      continue
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++
    if (ch === ')' || ch === '}' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      args.push(argText.slice(start, i))
      start = i + 1
    }
    i++
  }
  const last = argText.slice(start)
  if (last.trim() !== '' || args.length > 0) args.push(last)
  return args
}

/**
 * Collect same-file string constants: `const x = "..."` and const blocks.
 * Only constants whose value is purely (concatenated) string literals are
 * recorded - anything else stays unresolvable so it can never fake a
 * verifiable description.
 *
 * @param {string} masked - Comment-masked file content
 * @returns {Map<string, string>} identifier -> string value
 */
function collectStringConsts (masked) {
  const consts = new Map()
  const pattern = /\bconst\b/g
  let match
  while ((match = pattern.exec(masked)) !== null) {
    let i = match.index + match[0].length
    while (i < masked.length && /[ \t]/.test(masked[i])) i++
    if (masked[i] === '(') {
      const close = findBalancedClose(masked, i)
      if (close === -1) continue
      collectConstEntries(masked.slice(i + 1, close), consts)
      pattern.lastIndex = close + 1
    } else {
      // Single-const form: the statement ends at the first newline OUTSIDE
      // a string (a raw-string value may span lines), unless that newline
      // follows a `+` continuation - Go allows a string concatenation to
      // wrap across lines with no surrounding parens.
      let j = i
      while (j < masked.length) {
        if (masked[j] === '"' || masked[j] === '`' || masked[j] === "'") {
          j = skipString(masked, j)
          continue
        }
        if (masked[j] === '\n') {
          let k = j - 1
          while (k >= i && /[ \t\r]/.test(masked[k])) k--
          if (k >= i && masked[k] === '+') {
            j++
            continue
          }
          break
        }
        j++
      }
      collectConstEntries(masked.slice(i, j), consts)
      pattern.lastIndex = j
    }
  }
  return consts
}

/** Parse `name [type] = <string expr>` lines inside a const region. */
function collectConstEntries (regionText, consts) {
  // Split on newlines OUTSIDE strings (raw strings may span lines), unless
  // the newline follows a `+` continuation - a string concatenation may
  // wrap across lines with no surrounding parens, and must stay one entry.
  const lines = []
  let start = 0
  let i = 0
  while (i < regionText.length) {
    const ch = regionText[i]
    if (ch === '"' || ch === '`' || ch === "'") {
      i = skipString(regionText, i)
      continue
    }
    if (ch === '\n') {
      let k = i - 1
      while (k >= start && /[ \t\r]/.test(regionText[k])) k--
      if (k >= start && regionText[k] === '+') {
        i++
        continue
      }
      lines.push(regionText.slice(start, i))
      start = i + 1
    }
    i++
  }
  lines.push(regionText.slice(start))

  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:[A-Za-z_][A-Za-z0-9_.]*\s*)?=\s*(.+)$/s)
    if (!m) continue
    const { verifiable, value } = evalStringExpr(m[2], consts)
    if (verifiable) consts.set(m[1], value)
  }
}

/**
 * Evaluate a Go expression expected to produce a string: a sequence of
 * string literals and known identifiers joined by `+`. Anything else
 * (function calls, fmt.Sprintf, selectors, unknown identifiers) makes the
 * result unverifiable - the caller reports it, never guesses.
 *
 * @param {string} exprText - Comment-masked expression text
 * @param {Map<string, string>} [consts] - Same-file string constants
 * @returns {{ verifiable: boolean, value: string|null, sawString: boolean }}
 */
function evalStringExpr (exprText, consts = new Map()) {
  const parts = []
  let verifiable = true
  let sawString = false
  let i = 0
  while (i < exprText.length) {
    const ch = exprText[i]
    if (/\s/.test(ch) || ch === '+') {
      i++
      continue
    }
    if (ch === '"') {
      const end = skipString(exprText, i)
      parts.push(unescapeGo(exprText.slice(i + 1, end - 1)))
      sawString = true
      i = end
      continue
    }
    if (ch === '`') {
      const end = skipString(exprText, i)
      parts.push(exprText.slice(i + 1, end - 1))
      sawString = true
      i = end
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < exprText.length && /[A-Za-z0-9_.]/.test(exprText[j])) j++
      const ident = exprText.slice(i, j)
      // A following "(" means a call - unverifiable.
      let k = j
      while (k < exprText.length && /\s/.test(exprText[k])) k++
      if (exprText[k] === '(') {
        verifiable = false
        const close = findBalancedClose(exprText, k)
        i = close === -1 ? exprText.length : close + 1
        continue
      }
      if (consts.has(ident)) {
        parts.push(consts.get(ident))
        sawString = true
      } else {
        verifiable = false
      }
      i = j
      continue
    }
    // Any other token (&, numbers, composite literals, ...) is not a string.
    verifiable = false
    if (ch === '(' || ch === '{' || ch === '[') {
      const close = findBalancedClose(exprText, i, ch, ch === '(' ? ')' : ch === '{' ? '}' : ']')
      i = close === -1 ? exprText.length : close + 1
      continue
    }
    i++
  }
  if (!sawString) return { verifiable: false, value: null, sawString }
  return { verifiable, value: verifiable ? parts.join('') : null, sawString }
}

/** 1-indexed line number of a character offset. */
function lineOf (content, index) {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

const fs = require('fs')
const path = require('path')

/**
 * Recursively collect .go files under root (repo-relative paths), skipping
 * _test.go files, testdata/fuzzing dirs, and hidden dirs.
 */
function collectGoFiles (root, base = root, out = []) {
  if (!fs.existsSync(root)) return out
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'testdata' || entry.name === 'fuzzing' || entry.name === 'node_modules') continue
      collectGoFiles(fullPath, base, out)
    } else if (entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) {
      out.push(path.relative(base, fullPath))
    }
  }
  return out
}

module.exports = {
  maskComments,
  skipString,
  findBalancedClose,
  unescapeGo,
  splitTopLevelArgs,
  collectStringConsts,
  evalStringExpr,
  lineOf,
  collectGoFiles
}
