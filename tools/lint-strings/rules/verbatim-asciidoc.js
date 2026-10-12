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

/**
 * AsciiDoc preprocessor conditionals in doc strings that publish to two
 * audiences. Connect spec strings are published on the self-managed Connect
 * docs and on the Redpanda Cloud docs, which set the `env-cloud` attribute,
 * and each Connect binary renders the same strings as Markdown with the
 * attribute set only in the Cloud binaries. An author who wraps text whose
 * behavior differs in Cloud has one convention:
 *
 *   - `env-cloud` is the only attribute;
 *   - block form only: `ifdef::env-cloud[]` or `ifndef::env-cloud[]` alone
 *     on a line at column 0, the whole paragraph inside, `endif::[]` alone on
 *     a line, a blank line before the opening directive and after the closing
 *     one (unless the string starts or ends there);
 *   - never the single-line form `ifndef::env-cloud[text]`;
 *   - never in a Summary, which renders as one line;
 *   - never inside a code fence.
 *
 * Links to pages the other site lacks are handled by the renderers, so a
 * conditional is only for behavior that differs. Not part of
 * VERBATIM_ASCIIDOC_RULES: a surface that publishes to both audiences opts
 * in (connect does); the other verbatim surfaces carry audience conditionals
 * as data, not in the string.
 */
const CONDITIONAL_ATTRIBUTE = 'env-cloud'
const CONDITIONAL_WHY = 'The Cloud docs and the Cloud binaries set env-cloud, and the text inside must read as a whole paragraph in both outputs. See docs/README.md in the connect repo.'
const CONDITIONAL_TOKEN = /\b(?:ifdef|ifndef|ifeval|endif)::/
// A directive on its own line: optional indent (reported), kind, attribute
// list, bracketed text, nothing else.
const CONDITIONAL_LINE = /^(\s*)(ifdef|ifndef|ifeval|endif)::([^\s[\]]*)\[(.*)\]\s*$/
// Listing, literal and Markdown-style fences. Tracked so a directive inside
// one is reported; the preprocessor still evaluates it there.
const CODE_FENCE = /^(-{4,}|\.{4,}|`{3,})\s*$/

/** True for the declaration kinds a surface renders on one line as a Summary. */
function isSummary (decl) {
  const meta = decl.meta || {}
  return meta.kind === 'summary' || (meta.kind === 'bloblang' && meta.part === 'summary')
}

const CONDITIONAL_RULE = {
  name: 'conditional',
  description: 'AsciiDoc conditional that is not a well-formed env-cloud block',
  severity: 'warning',
  check: (decl) => {
    const text = decl.string || ''
    if (!text || !CONDITIONAL_TOKEN.test(text)) return []
    // CLI help is not AsciiDoc; the surface marks those declarations.
    if (decl.convention && decl.convention.verbatim_asciidoc === false) return []
    const issues = []
    const say = (what, severity) => issues.push({ message: `${what} ${CONDITIONAL_WHY}`, ...(severity ? { severity } : {}) })

    if (isSummary(decl)) {
      say('Contains an AsciiDoc conditional in a Summary. A summary renders as one line, so it cannot hold a conditional block; keep the Summary the same for both audiences and put the differing paragraph in the Description.')
      return issues
    }

    const lines = text.split('\n')
    const open = []
    let fence = null
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const fenceMatch = line.match(CODE_FENCE)
      if (fenceMatch) {
        const marker = fenceMatch[1][0]
        if (fence === null) fence = marker
        else if (fence === marker) fence = null
        continue
      }
      const m = line.match(CONDITIONAL_LINE)
      if (!m) {
        if (CONDITIONAL_TOKEN.test(line)) {
          say(`"${line.trim().slice(0, 60)}" is not a directive on a line of its own at column 0. Put ifdef::env-cloud[], ifndef::env-cloud[] and endif::[] each on their own line with nothing before them.`)
        }
        continue
      }
      const [, indent, kind, attribute, body] = m
      const label = `${kind}::${attribute}[${body}]`
      if (fence !== null) {
        // Reported on its own: the form checks below assume prose around
        // the block, and a fence line is not prose.
        say(`${label} is inside a code fence. Keep conditionals out of code fences; wrap the whole paragraph or block instead.`)
        continue
      }
      if (indent) say(`${label} is indented. A directive starts at column 0, or AsciiDoc treats it as text.`)

      if (kind === 'ifeval') {
        say(`${label} uses ifeval. env-cloud is the only attribute a doc string may test, with ifdef::env-cloud[] or ifndef::env-cloud[].`)
        open.push({ label, line: i })
        continue
      }
      if (kind === 'endif') {
        if (body.trim() !== '') say(`${label} carries text in its brackets. Close a block with endif::[] on its own line.`)
        if (attribute && attribute !== CONDITIONAL_ATTRIBUTE) say(`${label} names "${attribute}". env-cloud is the only attribute; close the block with endif::[].`)
        if (open.length === 0) say(`${label} has no matching ifdef::env-cloud[] or ifndef::env-cloud[] before it.`, 'error')
        else open.pop()
        if (i < lines.length - 1 && lines[i + 1].trim() !== '') say(`${label} needs a blank line after it, so the paragraph inside ends where the block ends.`)
        continue
      }
      // ifdef / ifndef
      if (attribute !== CONDITIONAL_ATTRIBUTE) say(`${label} tests "${attribute}". env-cloud is the only attribute a doc string may test.`)
      if (body.trim() !== '') {
        say(`${label} is the single-line form. Use the block form: the directive alone on its line, the whole paragraph inside, then endif::[] on its own line.`)
      } else {
        open.push({ label, line: i })
      }
      if (i > 0 && lines[i - 1].trim() !== '') say(`${label} needs a blank line before it, so the paragraph inside starts where the block starts.`)
    }
    for (const { label } of open) {
      say(`${label} is never closed with endif::[]. Everything after it is hidden from one audience, or the rest of the page is.`, 'error')
    }
    return issues
  }
}

module.exports = { VERBATIM_ASCIIDOC_RULES, CONDITIONAL_RULE, KNOWN_ATTRIBUTES, MACRO_NAMES, countRawPipes }
