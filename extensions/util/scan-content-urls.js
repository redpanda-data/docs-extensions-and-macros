'use strict'

/**
 * Scans AsciiDoc content for http(s) URLs that appear in prose, skipping
 * URLs inside code contexts where rewriting or checking them would be wrong:
 *
 * - delimited listing (----), literal (....), fenced (```), and passthrough
 *   (++++) blocks
 * - inline code spans (`...`)
 *
 * Each match records enough position information for a caller to splice a
 * replacement into the original content.
 *
 * Match shape:
 * - url: the URL with any trailing sentence punctuation trimmed
 * - label: text of a directly attached AsciiDoc link label ([...]), or null
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
 */

const URL_RX = /(link:)?(https?:\/\/[^\s\][)"'<>]+)(\[[^\]]*\])?/g
const TRAILING_PUNCT_RX = /[.,;:!?]+$/
const ATTRIBUTE_ENTRY_RX = /^:!?[a-zA-Z0-9_][a-zA-Z0-9_-]*!?:(?:\s|$)/

function blockDelimiter (line) {
  if (/^-{4,}$/.test(line)) return '-'
  if (/^\.{4,}$/.test(line)) return '.'
  if (/^`{3,}$/.test(line)) return '`'
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
    } else if (!openDelimiter) {
      scanLine(line, offset, matches)
    }
    offset += rawLine.length + 1
  }
  return matches
}

function scanLine (line, offset, matches) {
  const inAttributeEntry = ATTRIBUTE_ENTRY_RX.test(line)
  for (const match of line.matchAll(URL_RX)) {
    const [, linkPrefix, rawUrl, rawLabel] = match
    const backticksBefore = (line.slice(0, match.index).match(/`/g) || []).length
    if (backticksBefore % 2 === 1) continue
    let url = rawUrl
    if (!rawLabel) url = url.replace(TRAILING_PUNCT_RX, '')
    const prefixLength = linkPrefix ? linkPrefix.length : 0
    const start = offset + match.index
    const end = start + prefixLength + url.length + (rawLabel ? rawLabel.length : 0)
    // A URL directly after an attribute assignment (link=, window=, ...) is a
    // macro attribute value, not a standalone link.
    const before = line.slice(0, match.index)
    matches.push({
      url,
      label: rawLabel ? rawLabel.slice(1, -1) : null,
      start,
      end,
      hasLinkPrefix: Boolean(linkPrefix),
      inAttributeEntry,
      inAttributeValue: /[\w-]=["']?$/.test(before),
    })
  }
}

module.exports = { scanContentUrls }
