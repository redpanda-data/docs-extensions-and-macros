'use strict'

/**
 * Rules for verbatim-AsciiDoc surfaces (properties, metrics, crd, connect).
 *
 * These strings ship to docs.redpanda.com with ZERO escaping: a raw `|`
 * breaks the containing table cell, an unknown `{attr}` renders literally or
 * trips attribute-missing handling, and a half-written macro ships as broken
 * markup. rpk is exempt: its formatDescription() transformer rewrites the
 * string before publication.
 */

/**
 * Product attributes that are legitimately available on rendered pages.
 * Anything else inside `{...}` is not substituted and ships broken.
 * Agent-extensible: add attributes here as surfaces grow.
 */
const KNOWN_ATTRIBUTES = new Set([
  'latest-version',
  'latest-redpanda-version',
  'latest-redpanda-tag',
  'latest-console-version',
  'latest-operator-version',
  'latest-connect-version',
  'full-version',
  'page-version',
  'empty'
])

/** AsciiDoc inline macros used in embedded doc strings. */
const MACRO_NAMES = ['xref', 'glossterm', 'config_ref']

/**
 * Scan text for unescaped `|` characters outside backtick spans.
 * Returns the count found.
 */
function countRawPipes (text) {
  let inBacktick = false
  let count = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '`') {
      inBacktick = !inBacktick
      continue
    }
    if (ch === '|' && !inBacktick && text[i - 1] !== '\\') count++
  }
  return count
}

const VERBATIM_ASCIIDOC_RULES = [
  {
    name: 'raw-pipe',
    description: 'Raw unescaped | outside backticks breaks AsciiDoc tables',
    severity: 'error',
    check: (decl) => {
      const text = decl.string || ''
      if (!text.includes('|')) return []
      const count = countRawPipes(text)
      if (count > 0) {
        return [{ message: `Contains ${count} raw unescaped "|" outside backticks. This string is rendered verbatim inside AsciiDoc tables; escape it (\\|) or wrap it in backticks.` }]
      }
      return []
    }
  },
  {
    name: 'unknown-attribute',
    description: '{attr} reference that is not a known product attribute',
    severity: 'warning',
    check: (decl) => {
      const text = decl.string || ''
      const issues = []
      const pattern = /\{([a-z][a-z0-9_-]*)\}/g
      let match
      while ((match = pattern.exec(text)) !== null) {
        // A backslash-escaped \{...} is not substituted; authors escape
        // deliberately (URL path templates, JSON pointers).
        if (match.index > 0 && text[match.index - 1] === '\\') continue
        if (!KNOWN_ATTRIBUTES.has(match[1])) {
          issues.push({ message: `"{${match[1]}}" looks like an AsciiDoc attribute reference but is not a known product attribute. It will not be substituted on the rendered page.` })
        }
      }
      return issues
    }
  },
  {
    name: 'broken-macro',
    description: 'xref:/glossterm:/config_ref: macro with unbalanced brackets',
    severity: 'error',
    check: (decl) => {
      const text = decl.string || ''
      const issues = []
      const pattern = new RegExp(`\\b(${MACRO_NAMES.join('|')}):`, 'g')
      let match
      while ((match = pattern.exec(text)) !== null) {
        const rest = text.slice(match.index + match[0].length)
        // Well-formed: <target>[<label>] with the target free of whitespace
        // and brackets, and the label closed before end of string.
        if (!/^[^\s[\]]*\[[^\]]*\]/.test(rest)) {
          issues.push({ message: `Broken ${match[1]}: macro syntax near "${text.slice(match.index, match.index + 50)}". Expected ${match[1]}:target[label] with balanced brackets.` })
        }
      }
      return issues
    }
  }
]

module.exports = { VERBATIM_ASCIIDOC_RULES, KNOWN_ATTRIBUTES, MACRO_NAMES, countRawPipes }
