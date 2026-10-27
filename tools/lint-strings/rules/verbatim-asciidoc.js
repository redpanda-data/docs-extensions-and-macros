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
 *   - nothing after the closing bracket, not even whitespace: the Markdown
 *     converter in the Connect binaries only treats a line ending in `]` as
 *     a directive;
 *   - never the single-line form `ifndef::env-cloud[text]`;
 *   - never in a Summary, which renders as one line, or in an example
 *     summary;
 *   - never inside a code fence;
 *   - never `ifndef::env-cloud[]` inside `ifdef::env-cloud[]` or the
 *     reverse, whose inner text renders for neither audience.
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
// list, bracketed text, then optional trailing whitespace (reported).
const CONDITIONAL_LINE = /^(\s*)(ifdef|ifndef|ifeval|endif)::([^\s[\]]*)\[(.*)\](\s*)$/
// Listing and literal delimiters, and Markdown fences with an optional
// language tag (```yaml). Tracked so a directive inside one is reported; the
// preprocessor still evaluates it there.
const CODE_FENCE = /^(?:(-{4,}|\.{4,})|(`{3,})([\w.+#-]*))[ \t]*$/

/**
 * Which summary a declaration is, or null. Summaries render as one line, and
 * connect's docs test rejects a conditional in any JSON `summary` key, which
 * includes example summaries.
 */
function summaryKind (decl) {
  const meta = decl.meta || {}
  if (meta.kind === 'summary' || (meta.kind === 'bloblang' && meta.part === 'summary')) return 'a Summary'
  if (meta.kind === 'example-summary' || meta.kind === 'bloblang-example') return 'an example summary'
  return null
}

/**
 * Advance the code-fence state over one fence line. An AsciiDoc block closes
 * only on a delimiter of the same character and length; a Markdown fence
 * closes on a bare fence at least as long as the opener.
 */
function stepFence (fence, match) {
  const [, adoc, ticks, lang] = match
  if (fence === null) return adoc ? { char: adoc[0], length: adoc.length } : { char: '`', length: ticks.length }
  if (adoc) return fence.char === adoc[0] && fence.length === adoc.length ? null : fence
  return fence.char === '`' && !lang && ticks.length >= fence.length ? null : fence
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

    const summary = summaryKind(decl)
    if (summary) {
      say(`Contains an AsciiDoc conditional in ${summary}. A summary renders as one line, so it cannot hold a conditional block; keep the summary the same for both audiences and put the differing paragraph in the Description.`)
      return issues
    }

    const lines = text.split('\n')
    const open = []
    let fence = null
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const fenceMatch = line.match(CODE_FENCE)
      if (fenceMatch) {
        fence = stepFence(fence, fenceMatch)
        continue
      }
      const m = line.match(CONDITIONAL_LINE)
      if (!m) {
        if (CONDITIONAL_TOKEN.test(line)) {
          say(`"${line.trim().slice(0, 60)}" is not a directive on a line of its own at column 0. Put ifdef::env-cloud[], ifndef::env-cloud[] and endif::[] each on their own line with nothing before them.`)
        }
        continue
      }
      const [, indent, kind, attribute, body, trailing] = m
      const label = `${kind}::${attribute}[${body}]`
      // What is between the brackets decides how Asciidoctor reads the line.
      const bracket = body === '' ? 'empty' : body.trim() === '' ? 'whitespace' : 'text'
      if (fence !== null) {
        // Reported on its own: the form checks below assume prose around
        // the block, and a fence line is not prose.
        say(`${label} is inside a code fence. Keep conditionals out of code fences; wrap the whole paragraph or block instead.`)
        continue
      }
      if (indent) {
        // Asciidoctor and the Connect Markdown converter both read an
        // indented directive as text, so it neither opens nor closes a block
        // here either: the never-closed and no-matching-opener errors below
        // then report the block it leaves unbalanced.
        say(`${label} is indented. A directive starts at column 0, or AsciiDoc and the Connect binaries treat it as text and it does not open or close a block.`)
        continue
      }
      if (trailing) {
        say(`${label} has trailing whitespace after the closing bracket. The Connect binaries only treat a line ending in ] as a directive, so CLI readers would see the directive and the text for the other audience. Remove everything after the ].`, 'error')
      }

      if (kind === 'ifeval') {
        say(`${label} uses ifeval. env-cloud is the only attribute a doc string may test, with ifdef::env-cloud[] or ifndef::env-cloud[].`)
        open.push({ label, line: i })
        continue
      }
      if (kind === 'endif') {
        if (attribute && attribute !== CONDITIONAL_ATTRIBUTE) say(`${label} names "${attribute}". env-cloud is the only attribute; close the block with endif::[].`)
        if (bracket !== 'empty') {
          // Asciidoctor rejects an endif with anything in its brackets and
          // leaves the block open, so it does not close one here either: the
          // never-closed error below then reports the block it leaves open.
          say(`${label} has ${bracket === 'text' ? 'text' : 'whitespace'} inside its brackets. Asciidoctor rejects it and leaves the block open, so the text after it is hidden from one audience. Write endif::[] with nothing between the brackets.`, 'error')
        } else if (open.length === 0) say(`${label} has no matching ifdef::env-cloud[] or ifndef::env-cloud[] before it.`, 'error')
        else open.pop()
        if (i < lines.length - 1 && lines[i + 1].trim() !== '') say(`${label} needs a blank line after it, so the paragraph inside ends where the block ends.`)
        continue
      }
      // ifdef / ifndef
      if (attribute !== CONDITIONAL_ATTRIBUTE) say(`${label} tests "${attribute}". env-cloud is the only attribute a doc string may test.`)
      if (bracket === 'whitespace') {
        // Asciidoctor reads any bracket content, whitespace included, as the
        // single-line form, which opens no block: the text that follows shows
        // for both audiences. So it is not pushed as an opener, and the endif
        // that follows reports no matching opener.
        say(`${label} has whitespace inside its brackets. Asciidoctor then reads it as the single-line form, which opens no block, so the text after it shows for both audiences. Write ${kind}::${attribute}[] with nothing between the brackets.`, 'error')
      } else if (bracket === 'text') {
        say(`${label} is the single-line form. Use the block form: the directive alone on its line, the whole paragraph inside, then endif::[] on its own line.`)
      } else {
        if (attribute === CONDITIONAL_ATTRIBUTE) {
          const opposite = kind === 'ifdef' ? 'ifndef' : 'ifdef'
          const outer = open.find((o) => o.kind === opposite && o.attribute === CONDITIONAL_ATTRIBUTE)
          if (outer) say(`${label} is inside ${outer.label}, so the text between them renders for neither audience. Close the outer block with endif::[] before opening the other one.`)
        }
        open.push({ label, kind, attribute, line: i })
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
