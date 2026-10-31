'use strict'

/**
 * LSP constants and result builders shared by every feature module. The
 * values are the protocol's enum numbers, kept here so feature modules have
 * no dependency on vscode-languageserver.
 */

const SEVERITY = { error: 1, warning: 2, information: 3, hint: 4 }
const COMPLETION_KIND = { field: 5, property: 10, value: 12, snippet: 15, file: 17, reference: 18, enumMember: 20 }
const SOURCE = 'redpanda-docs'

/** An LSP Diagnostic from this server. `severity` is a SEVERITY key. */
function diagnostic (r, message, severity, code) {
  return { range: r, message, severity: SEVERITY[severity] || SEVERITY.warning, source: SOURCE, code }
}

/** An LSP Hover with Markdown contents; `r` may be null. */
function markdownHover (value, r) {
  const out = { contents: { kind: 'markdown', value } }
  if (r) out.range = r
  return out
}

module.exports = { SEVERITY, COMPLETION_KIND, SOURCE, diagnostic, markdownHover }
