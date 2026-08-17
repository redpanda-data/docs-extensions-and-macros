'use strict'

/**
 * Cleans up the AsciiDoc that pandoc produces from a chart's helm-docs README
 * so that it renders correctly as a docs page.
 *
 * docs.redpanda.com URLs are deliberately left as they are: the url-to-xref
 * Antora extension converts them to validated xrefs at site build time.
 */
function formatHelmSpec (doc) {
  const formatted = doc
    // pandoc escapes footnote-style references inconsistently
    .replace(/(\[\d+\])\]\./g, '$1\\].')
    .replace(/(\[\d+\])\]\]/g, '$1\\]\\]')
    // a section title that is a bare URL has to be a link macro to render
    .replace(/^=== +(https?:\/\/[^[]*)\[([^\]]*)\]/gm, '=== link:++$1++[$2]')
    .replace(/^== # (.*)$/gm, '= $1')
    .replace(/^== description: (.*)$/gm, ':description: $1')
    // helm-docs prints each chart dependency's repository verbatim into the
    // Requirements table, and charts in the redpanda-operator monorepo refer
    // to their subcharts by local path (for example the Redpanda chart's
    // console dependency, repository: file://../../console/chart).
    // Asciidoctor auto-links a bare file:// URL, which publishes a link that
    // can never resolve for a reader, so render these as literal code.
    .replace(/(^|[^`])(file:\/\/[^\s|\]`]+)/gm, '$1`$2`')

  return relocateDescriptionIntoHeader(formatted)
}

/**
 * Moves the first `:description:` attribute up into the document header.
 *
 * Antora resolves page metadata with a header-only parse that stops at the
 * first blank line. The chart README templates emit `:description:` below the
 * title's blank line, so the page shipped the generic site meta description
 * despite carrying one of its own (found on k-connect-helm-spec, DOC-2414).
 *
 * The conversion above turns `== description:` into the attribute but leaves it
 * where pandoc put it, so the move has to happen after it.
 *
 * @param {string} doc - AsciiDoc source.
 * @returns {string} Source with the description in the header.
 */
function relocateDescriptionIntoHeader (doc) {
  const descMatch = doc.match(/^:description:[^\n]*$/m)
  if (!descMatch) return doc

  const headerEnd = doc.indexOf('\n\n')
  // Already inside the header, so there is nothing to move.
  if (headerEnd === -1 || doc.indexOf(descMatch[0]) < headerEnd) return doc

  return doc
    .replace(descMatch[0] + '\n', '')
    .replace(/^(= .+)$/m, `$1\n${descMatch[0]}`)
    .replace(/\n{3,}/g, '\n\n')
}

module.exports = { formatHelmSpec }
