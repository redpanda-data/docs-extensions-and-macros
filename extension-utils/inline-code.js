'use strict'

/**
 * Code tokens in CLI help text, found and formatted by one set of patterns.
 *
 * CLI help text carries no backticks (pflag and urfave/cli take the first
 * backtick span of a flag usage string as the --help value placeholder), so
 * the generators that publish it put code values in inline code themselves.
 * The lint rule missing-inline-code (tools/lint-strings/rules/common.js)
 * finds the same tokens with the same patterns, so a surface that declares a
 * kind in convention.auto_inline_code is one whose generator calls
 * formatInlineCode for that kind.
 */

/**
 * Tokens that are code and read as code, so they belong in inline code.
 * Backticks are the portable choice: a single-backtick span is inline code in
 * both AsciiDoc and Markdown, so one rule covers every surface regardless of
 * which format the generator emits.
 *
 * Deliberately narrow. The lint rule posts inline suggestions on engineering
 * PRs, and the generators apply these to published text, so a false positive
 * costs more than a miss:
 *
 *   * snake_case with at least two segments - in this domain that is always an
 *     identifier (`default_topic_partitions`), never prose;
 *   * long flags (`--tolerate-data-loss`);
 *   * absolute paths with at least two segments (`/etc/redpanda/redpanda.yaml`,
 *     `/v1/topics`).
 *
 * Not included, on purpose: dotted keys (`segment.bytes`) collide with
 * sentence boundaries and abbreviations; bare `true`/`false` and numbers
 * appear in ordinary prose; single-segment lowercase words are unrecoverable
 * from prose without a symbol table.
 */
const CODE_TOKEN_PATTERNS = Object.freeze([
  { id: 'identifier', re: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g },
  { id: 'flag', re: /(?<![\w-])--[a-z][a-z0-9]*(?:-[a-z0-9]+)*\b/g },
  // A path may not end in a period, so "served from /v1/brokers." reports
  // `/v1/brokers`, not the sentence's full stop with it.
  { id: 'path', re: /(?<![\w/])\/[a-z][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_.{}-]*[a-zA-Z0-9_{}-])+\/?/g }
])

const blank = (m) => ' '.repeat(m.length)

/**
 * Blank out the spans where a code token is expected to appear bare, so
 * only prose is left:
 *
 *   * backticked spans - already marked up;
 *   * URLs, Markdown link targets, and AsciiDoc macro targets and anchor
 *     ids - a path inside a link is part of the link, and backticking it
 *     would break the link.
 *
 * Replaced with spaces rather than removed so match indices stay meaningful.
 */
function maskNonProse (text) {
  let out = String(text || '')
  // Backticked spans first: a URL inside backticks is already marked up.
  out = out.replace(/`[^`]*`/g, blank)
  // Markdown links: mask the whole construct, target included.
  out = out.replace(/\[[^\]]*\]\([^)]*\)/g, blank)
  // Bare URLs, and AsciiDoc's url[text] form.
  out = out.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, blank)
  // AsciiDoc macro targets and anchor ids: xref:components:processors/
  // schema_registry_encode.adoc[...] names a page, <<avro_raw_json,...>>
  // and [[field_paths]] name an anchor. Backticking either breaks the link.
  // The label in brackets stays prose.
  out = out.replace(/\b(?:xref|link|image|include|glossterm|config_ref|anchor):[^\s[]*(?=\[)/g, blank)
  out = out.replace(/<<[^,>]*/g, blank)
  out = out.replace(/\[\[[^\]]*\]\]|\[#[^\]]*\]/g, blank)
  return out
}

/**
 * Like maskNonProse, but blanks whole constructs a formatter must never
 * touch: code blocks (fenced, ----, ....), and links with their labels.
 * URLs are left in, so the url kind can find them.
 */
function maskForFormatting (text) {
  let out = String(text || '')
  out = out.replace(/^(```|-{4,}|\.{4,})[^\n]*$[\s\S]*?^\1[ \t]*$/gm, blank)
  out = out.replace(/`[^`]*`/g, blank)
  out = out.replace(/\[[^\]]*\]\([^)]*\)/g, blank)
  // AsciiDoc url[text] and macro[text] links, label included.
  out = out.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s[\]]+\[[^\]]*\]/gi, blank)
  out = out.replace(/\b(?:xref|link|image|include|glossterm|config_ref|anchor|mailto):[^\s[]*\[[^\]]*\]/g, blank)
  out = out.replace(/<<[^>]*>>/g, blank)
  out = out.replace(/\[\[[^\]]*\]\]|\[#[^\]]*\]/g, blank)
  return out
}

// A link to a docs site page is a link, never a code value: the url-to-xref
// extension and the rpk generator turn it into an xref, which a code span
// would stop.
const DOCS_SITE_URL_RX = /^https?:\/\/docs\.redpanda\.com(?:[/?#]|$)/

const URL_RX = /(?<![\w/])https?:\/\/[^\s`<>"'()[\]]+/g
const TRAILING_PUNCTUATION = /[.,;:!?]+$/

/**
 * Whether text[start, end) is a whole token, so a code span around it
 * renders as one: AsciiDoc prints the backticks of a span that touches a
 * word character (name:`web`), and a quote before a backtick is curved-quote
 * syntax ("`x`"). Before it: the start, whitespace, an opening bracket or a
 * table cell bar. After it: the end or whitespace, after any closing
 * punctuation. A name inside a longer token (topic:partition_id,
 * approval_policy=on-request, 'seastar::dma_read', {placeholder}) is left
 * as written.
 */
function isWholeToken (text, start, end) {
  const before = start === 0 ? '' : text[start - 1]
  if (before && !/[\s([<|]/.test(before)) return false
  let j = end
  while (j < text.length && /[.,;:!?)\]}'"]/.test(text[j])) j++
  return j === text.length || /\s/.test(text[j])
}

/** Characters a snake_case name extends over: dotted keys are one token. */
const IDENT_CHAR = /[A-Za-z0-9_]/

/**
 * Where each code token of the requested kinds sits in `text`, as
 * non-overlapping { start, end, kind } spans in text order.
 */
function codeSpans (text, kinds) {
  const source = String(text || '')
  const masked = maskForFormatting(source)
  const spans = []

  if (kinds.includes('url')) {
    URL_RX.lastIndex = 0
    let m
    while ((m = URL_RX.exec(masked)) !== null) {
      const trail = m[0].match(TRAILING_PUNCTUATION)
      const core = trail ? m[0].slice(0, -trail[0].length) : m[0]
      if (core.length > 'https://'.length && !DOCS_SITE_URL_RX.test(core)) {
        spans.push({ start: m.index, end: m.index + core.length, kind: 'url' })
      }
    }
  }
  // Never find a path or name inside a URL.
  const proseOnly = masked.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, blank)

  for (const { id, re } of CODE_TOKEN_PATTERNS) {
    if (!kinds.includes(id)) continue
    re.lastIndex = 0
    let m
    while ((m = re.exec(proseOnly)) !== null) {
      let start = m.index
      let end = m.index + m[0].length
      if (id === 'identifier') {
        // A dotted key that holds a snake_case segment (rpk.admin_api,
        // redpanda.cluster_id) is one name, not a prefix plus a name.
        while (start > 1 && proseOnly[start - 1] === '.' && IDENT_CHAR.test(proseOnly[start - 2])) {
          start -= 2
          while (start > 0 && IDENT_CHAR.test(proseOnly[start - 1])) start--
        }
        while (proseOnly[end] === '.' && IDENT_CHAR.test(proseOnly[end + 1] || '')) {
          end += 1
          while (end < proseOnly.length && IDENT_CHAR.test(proseOnly[end])) end++
        }
      }
      if (id === 'flag') {
        // As codeFlags did: a flag starts a token or follows a comma
        // (--a,--b). A quote before it is curved-quote syntax.
        if (start > 0 && !/[\s([<|,]/.test(source[start - 1])) continue
        // An =value belongs to the flag (--format=json). Commas inside the
        // value do too (--additional-controllers=a,b); a trailing sentence
        // mark does not.
        const value = proseOnly.slice(end).match(/^=[^\s)`]*[^\s)`,.;:!?]/)
        if (value) end += value[0].length
      } else if (!isWholeToken(source, start, end)) {
        continue
      }
      spans.push({ start, end, kind: id })
    }
  }

  // Keep the earliest, then the longest, of any overlapping spans.
  spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))
  const kept = []
  for (const span of spans) {
    if (kept.length && span.start < kept[kept.length - 1].end) continue
    kept.push(span)
  }
  return kept
}

/**
 * Text with every code token of the given kinds in inline code (single
 * backticks). Text already in backticks, in a code block or in a link is
 * left alone, so formatting twice changes nothing.
 *
 * @param {string} text
 * @param {Object} [options]
 * @param {string[]} [options.kinds] - Any of identifier, flag, path, url.
 *   Defaults to all four.
 * @returns {string}
 */
function formatInlineCode (text, { kinds = ['identifier', 'flag', 'path', 'url'] } = {}) {
  const source = String(text == null ? '' : text)
  const spans = codeSpans(source, kinds)
  if (spans.length === 0) return source
  let out = ''
  let at = 0
  for (const { start, end } of spans) {
    out += source.slice(at, start) + '`' + source.slice(start, end) + '`'
    at = end
  }
  return out + source.slice(at)
}

module.exports = { CODE_TOKEN_PATTERNS, maskNonProse, codeSpans, formatInlineCode, DOCS_SITE_URL_RX }
