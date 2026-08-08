'use strict'

/**
 * Cleans up the AsciiDoc that pandoc produces from a chart's helm-docs README
 * so that it renders correctly as a docs page.
 *
 * docs.redpanda.com URLs are deliberately left as they are: the url-to-xref
 * Antora extension converts them to validated xrefs at site build time.
 */
function formatHelmSpec (doc) {
  return (
    doc
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
  )
}

module.exports = { formatHelmSpec }
