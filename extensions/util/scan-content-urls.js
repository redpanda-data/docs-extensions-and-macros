'use strict'

/**
 * Scans AsciiDoc content for http(s) URLs that appear in prose, skipping
 * URLs that never reach a rendered page, or that live in a code context where
 * rewriting or checking them would be wrong:
 *
 * - delimited listing (----), literal (....), passthrough (++++) and comment
 *   (////) blocks
 * - fenced blocks (```), including a language info string (```bash, ```yml).
 *   Asciidoctor treats the info string as part of the delimiter, so a fence
 *   opened as ```bash still closes on a bare ``` line
 * - line comments (//), which Asciidoctor drops entirely
 * - inline code spans (`...`)
 *
 * URLs holding an unresolved attribute reference (https://github.com/{project-github}/...)
 * are returned with hasAttributeReference set, because a caller cannot check
 * or rewrite one: this scanner runs at contentClassified, before Asciidoctor
 * substitutes attributes, so the braces are still literal here even though the
 * published URL is fine.
 *
 * Each match records enough position information for a caller to splice a
 * replacement into the original content.
 *
 * Match shape:
 * - url: the URL with any trailing sentence punctuation trimmed
 * - label: text of a directly attached AsciiDoc link label ([...]), or null.
 *   A label may span line breaks, which is common in generated content where
 *   long lines are wrapped; its newlines are collapsed to single spaces
 * - start/end: absolute offsets in content covering the whole replaceable
 *   span (including a leading link: macro prefix and the label, if present)
 * - hasLinkPrefix: true when the URL was written as link:https://...[...]
 * - inAttributeEntry: true when the URL appears in an attribute entry line
 *   (for example ":url-docs: https://..."), where a caller may want to leave
 *   the value untouched
 * - inAttributeValue: true when the URL is a macro attribute value (for
 *   example image:d.png[alt,link=https://...]); rewriting one of these to an
 *   xref macro would corrupt the surrounding macro, but the URL is still a
 *   real link target worth checking
 * - hasAttributeReference: true when the URL contains a {name} attribute
 *   reference that has not been substituted yet
 */

const URL_RX = /(link:)?(https?:\/\/[^\s\][)"'<>]+)(\[[^\]]*\])?/g
// Sentence punctuation, and the AsciiDoc formatting markup that closes around a
// URL written as *emphasis* or **bold** (`**https://example.com/page**`), which
// is not part of the URL.
const TRAILING_PUNCT_RX = /[.,;:!?*_]+$/
const ATTRIBUTE_ENTRY_RX = /^:!?[a-zA-Z0-9_][a-zA-Z0-9_-]*!?:(?:\s|$)/
// A line comment. Asciidoctor drops these before rendering, so any URL on one
// is not a link on the published page: generator provenance notes, Doc
// Detective test steps, and writers' editorial asides all live here.
const LINE_COMMENT_RX = /^\s*\/\//
// An attribute reference that substitution has not resolved yet.
const ATTRIBUTE_REFERENCE_RX = /\{[a-zA-Z0-9_][a-zA-Z0-9_-]*\}/
// Cap on how far a wrapped label may run, so an unmatched bracket somewhere in
// prose cannot swallow the rest of the document.
const MAX_WRAPPED_LABEL_LENGTH = 500

function blockDelimiter (line) {
  // Comment blocks are four or more forward slashes; tested first so a ////
  // line is not mistaken for the start of a line comment.
  if (/^\/{4,}$/.test(line)) return '/'
  if (/^-{4,}$/.test(line)) return '-'
  if (/^\.{4,}$/.test(line)) return '.'
  // A fenced block may carry a language info string (```bash, ```yml), which
  // Asciidoctor accepts on the opening delimiter. Matching only bare backticks
  // meant every annotated code block was scanned as prose, which is where the
  // config defaults (https://api.openai.com/v1) and truncated shell examples
  // (.../releases/download/v<version>/...) in the weekly report came from.
  if (/^`{3,}\S*$/.test(line)) return '`'
  if (/^\+{4,}$/.test(line)) return '+'
  return null
}

function scanContentUrls (content) {
  const matches = []
  const lines = content.split('\n')
  let offset = 0
  let openDelimiter = null
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const delimiter = blockDelimiter(line)
    if (delimiter) {
      if (openDelimiter === delimiter) openDelimiter = null
      else if (!openDelimiter) openDelimiter = delimiter
    } else if (!openDelimiter && !LINE_COMMENT_RX.test(line)) {
      scanLine(line, offset, matches, content)
    }
    offset += rawLine.length + 1
  }
  return matches
}

/**
 * Reads a link label that opens on this line but closes on a later one, which
 * happens whenever a generator wraps long lines. Returns the label text with
 * its line breaks collapsed, plus the offset just past the closing bracket.
 * A blank line ends the search: that is a paragraph break, so the bracket
 * belongs to something else.
 */
function readWrappedLabel (content, openIndex) {
  if (content[openIndex] !== '[') return
  const limit = Math.min(content.length, openIndex + MAX_WRAPPED_LABEL_LENGTH)
  const closeIndex = content.indexOf(']', openIndex + 1)
  if (closeIndex === -1 || closeIndex > limit) return
  const raw = content.slice(openIndex + 1, closeIndex)
  if (/\n[ \t]*\n/.test(raw)) return
  return { label: raw.replace(/\s*\n\s*/g, ' '), end: closeIndex + 1 }
}

function scanLine (line, offset, matches, content) {
  const inAttributeEntry = ATTRIBUTE_ENTRY_RX.test(line)
  for (const match of line.matchAll(URL_RX)) {
    const [, linkPrefix, rawUrl, rawLabel] = match
    const backticksBefore = (line.slice(0, match.index).match(/`/g) || []).length
    if (backticksBefore % 2 === 1) continue
    const prefixLength = linkPrefix ? linkPrefix.length : 0
    const start = offset + match.index
    let url = rawUrl
    let label = rawLabel ? rawLabel.slice(1, -1) : null
    let end = start + prefixLength + url.length + (rawLabel ? rawLabel.length : 0)
    if (!rawLabel) {
      const wrapped = readWrappedLabel(content, start + prefixLength + url.length)
      if (wrapped) {
        label = wrapped.label
        end = wrapped.end
      } else {
        url = url.replace(TRAILING_PUNCT_RX, '')
        end = start + prefixLength + url.length
      }
    }
    // A URL directly after an attribute assignment (link=, window=, ...) is a
    // macro attribute value, not a standalone link.
    const before = line.slice(0, match.index)
    matches.push({
      url,
      label,
      start,
      end,
      hasLinkPrefix: Boolean(linkPrefix),
      inAttributeEntry,
      inAttributeValue: /[\w-]=["']?$/.test(before),
      hasAttributeReference: ATTRIBUTE_REFERENCE_RX.test(url),
    })
  }
}

module.exports = { scanContentUrls }
