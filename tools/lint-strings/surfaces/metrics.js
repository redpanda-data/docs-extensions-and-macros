'use strict'

const fs = require('fs')
const path = require('path')

const { SourceCache } = require('../source-text')

/**
 * Metrics surface: `sm::description(...)` / `ss::metrics::description(...)`
 * help strings in the C++ sources.
 *
 * This is a purpose-built regex/paren scanner, NOT the Docker metrics scrape
 * used for doc generation: the scrape reads `# HELP` lines from a live
 * cluster and cannot give file:line spans, which diff-anchored linting and
 * PR suggestion blocks need. The scanner:
 * - finds each description(...) call,
 * - captures the balanced-paren argument (string/comment aware),
 * - concatenates adjacent string literals (clang-format wraps help strings),
 * - records the exact 1-indexed line span of the call, and
 * - resolves the metric name from the first string argument of the enclosing
 *   make_gauge/make_counter/make_histogram/make_total_bytes/... call.
 *
 * Non-literal arguments (constants, fmt::format(...) calls) become an
 * info-level "unverifiable" finding - never an error.
 */

const CONVENTION = {
  case: 'capitalized',
  terminal_period: false,
  verbatim_asciidoc: true
}

const DESCRIPTION_CALL = /\b(?:sm|ss::metrics)::description\s*\(/g
const MAKE_CALL = /\b(?:sm::|ss::metrics::)?make_[a-z0-9_]+\s*\(/g

/**
 * Replace // and C-style comments with spaces, preserving every offset and
 * newline, so the scanner never matches description() calls mentioned in
 * comments. String literal contents are left untouched.
 */
function maskComments (content) {
  const out = content.split('')
  let i = 0
  while (i < content.length) {
    const ch = content[i]
    if (ch === '"' || ch === "'") {
      i = skipLiteral(content, i)
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
 * Walk forward from an opening paren and return the index of its balanced
 * closing paren, skipping string literals, char literals, and comments.
 * Returns -1 when unbalanced (malformed or truncated source).
 */
function findBalancedClose (content, openIndex) {
  let depth = 0
  let i = openIndex
  while (i < content.length) {
    const ch = content[i]
    if (ch === '"' || ch === "'") {
      i = skipLiteral(content, i)
      continue
    }
    if (ch === '/' && content[i + 1] === '/') {
      const eol = content.indexOf('\n', i)
      i = eol === -1 ? content.length : eol + 1
      continue
    }
    if (ch === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2)
      i = end === -1 ? content.length : end + 2
      continue
    }
    if (ch === '(') depth++
    if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

/** Skip a "..." or '...' literal starting at index; returns index after it. */
function skipLiteral (content, start) {
  const quote = content[start]
  let i = start + 1
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
 * True when the paren opened at openIndex is still open at targetIndex
 * (that is, the call encloses the target).
 */
function callEncloses (content, openIndex, targetIndex) {
  let depth = 0
  let i = openIndex
  while (i < content.length && i < targetIndex) {
    const ch = content[i]
    if (ch === '"' || ch === "'") {
      i = skipLiteral(content, i)
      continue
    }
    if (ch === '/' && content[i + 1] === '/') {
      const eol = content.indexOf('\n', i)
      i = eol === -1 ? content.length : eol + 1
      continue
    }
    if (ch === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2)
      i = end === -1 ? content.length : end + 2
      continue
    }
    if (ch === '(') depth++
    if (ch === ')') {
      depth--
      if (depth === 0) return false
    }
    i++
  }
  return depth > 0
}

/**
 * Parse the argument text of a description(...) call.
 * Returns { verifiable, value }: verifiable is true only when the argument
 * consists purely of (adjacent) string literals.
 */
function parseArgument (argText) {
  const literals = []
  let leftover = ''
  let i = 0
  while (i < argText.length) {
    const ch = argText[i]
    if (ch === '"') {
      const end = skipLiteral(argText, i)
      literals.push(argText.slice(i + 1, end - 1))
      i = end
      continue
    }
    if (ch === '/' && argText[i + 1] === '/') {
      const eol = argText.indexOf('\n', i)
      i = eol === -1 ? argText.length : eol + 1
      continue
    }
    if (ch === '/' && argText[i + 1] === '*') {
      const end = argText.indexOf('*/', i + 2)
      i = end === -1 ? argText.length : end + 2
      continue
    }
    leftover += ch
    i++
  }

  if (literals.length > 0 && leftover.trim() === '') {
    return { verifiable: true, value: literals.map(unescapeCpp).join('') }
  }
  return { verifiable: false, value: null }
}

function unescapeCpp (text) {
  return text.replace(/\\(.)/g, (whole, ch) => {
    if (ch === 'n') return '\n'
    if (ch === 't') return '\t'
    return ch
  })
}

/**
 * Resolve the metric name for a description at descIndex: find the nearest
 * preceding make_* call that still encloses it, then read its first argument
 * if that argument is a string literal (adjacent literals concatenated).
 */
function resolveMetricName (content, descIndex) {
  const candidates = []
  MAKE_CALL.lastIndex = 0
  let match
  while ((match = MAKE_CALL.exec(content)) !== null && match.index < descIndex) {
    candidates.push(match)
  }

  for (let c = candidates.length - 1; c >= 0; c--) {
    const openIndex = candidates[c].index + candidates[c][0].length - 1
    if (!callEncloses(content, openIndex, descIndex)) continue

    // First argument: skip whitespace/comments, then read adjacent literals.
    let i = openIndex + 1
    let name = ''
    let sawLiteral = false
    while (i < content.length) {
      const ch = content[i]
      if (/\s/.test(ch)) {
        i++
        continue
      }
      if (ch === '/' && content[i + 1] === '/') {
        const eol = content.indexOf('\n', i)
        i = eol === -1 ? content.length : eol + 1
        continue
      }
      if (ch === '"') {
        const end = skipLiteral(content, i)
        name += unescapeCpp(content.slice(i + 1, end - 1))
        sawLiteral = true
        i = end
        continue
      }
      break
    }
    return sawLiteral ? name : null
  }
  return null
}

/** 1-indexed line number of a character offset. */
function lineOf (content, index) {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

/**
 * Scan one file's content for metric description declarations.
 * Exported for tests.
 *
 * @param {string} content - File content
 * @param {string} file - Repo-relative path (recorded on declarations)
 * @returns {Array} declarations (without declaration_text, added by extract)
 */
function scanFile (content, file) {
  const declarations = []
  // Scan a comment-masked copy: offsets and line numbers are identical, but
  // description() calls mentioned in comments can never match.
  const masked = maskComments(content)
  DESCRIPTION_CALL.lastIndex = 0
  let match
  while ((match = DESCRIPTION_CALL.exec(masked)) !== null) {
    const openIndex = match.index + match[0].length - 1
    const closeIndex = findBalancedClose(masked, openIndex)
    if (closeIndex === -1) continue

    const { verifiable, value } = parseArgument(masked.slice(openIndex + 1, closeIndex))
    declarations.push({
      surface: 'metrics',
      name: resolveMetricName(masked, match.index),
      file,
      line_start: lineOf(masked, match.index),
      line_end: lineOf(masked, closeIndex),
      string: value,
      declaration_text: null,
      convention: CONVENTION,
      meta: { unverifiable: !verifiable }
    })
    DESCRIPTION_CALL.lastIndex = closeIndex + 1
  }
  return declarations
}

/** Recursively collect .cc/.h files, skipping tests and hidden dirs. */
function collectSourceFiles (root, base = root, out = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'tests' || entry.name === 'test' || entry.name === 'node_modules') continue
      collectSourceFiles(fullPath, base, out)
    } else if (/\.(cc|h)$/.test(entry.name)) {
      out.push(path.relative(base, fullPath))
    }
  }
  return out
}

/**
 * Extract metric description declarations.
 *
 * @param {Object} options - { repo, files (Set of repo-relative paths, diff
 *   mode; when omitted, scans all non-test .cc/.h under <repo>/src, or the
 *   whole repo when there is no src/) }
 */
function extract ({ repo, files = null }) {
  let fileList
  if (files) {
    fileList = [...files]
  } else {
    const srcRoot = fs.existsSync(path.join(repo, 'src', 'v')) ? path.join(repo, 'src', 'v') : repo
    fileList = collectSourceFiles(srcRoot).map((f) => path.relative(repo, path.join(srcRoot, f)))
  }

  const cache = new SourceCache(repo)
  const declarations = []
  for (const file of fileList) {
    const absPath = path.isAbsolute(file) ? file : path.join(repo, file)
    if (!fs.existsSync(absPath)) continue
    const content = fs.readFileSync(absPath, 'utf8')
    if (!content.includes('::description')) continue
    for (const decl of scanFile(content, file)) {
      decl.declaration_text = cache.span(file, decl.line_start, decl.line_end)
      declarations.push(decl)
    }
  }
  return declarations
}

/** Surface-specific convention rules. */
const RULES = [
  {
    name: 'trailing-period',
    description: 'Metric descriptions do not end with a period',
    severity: 'warning',
    check: (decl) => {
      const text = (decl.string || '').trim()
      if (!text) return []
      if (/\.$/.test(text)) {
        return [{ message: `Metric description ends with a period: "...${text.slice(-50)}". The metrics convention is no terminal period.` }]
      }
      return []
    }
  },
  {
    name: 'unverifiable-description',
    description: 'Description argument is not a plain string literal',
    severity: 'info',
    runOnUnverifiable: true,
    check: (decl) => {
      if (decl.meta && decl.meta.unverifiable) {
        return [{ message: 'Description is built from a constant or expression (not adjacent string literals), so it cannot be verified here. Check the referenced value manually.' }]
      }
      return []
    }
  }
]

module.exports = {
  name: 'metrics',
  convention: CONVENTION,
  extract,
  scanFile,
  rules: RULES
}
