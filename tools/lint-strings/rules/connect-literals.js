'use strict'

const { STANDARD } = require('../standards')

/**
 * Two connect rules for text that reaches the page in the wrong form.
 *
 * connect-go-slice-format: fmt.Sprintf("... %v", algs) prints a Go slice
 * as Go syntax, so the page says "[flate gzip lz4 snappy]". The surface
 * records, per declaration, every Sprint or Sprintf argument that formats a
 * slice or map with %v, %s or %q (meta.go_collection_args, see
 * ConnectScanner.goCollectionArgs). That works even when the slice itself
 * cannot be evaluated, which is the usual case: the list is built at init
 * time from a registry. When the source has no such call, the rendered
 * string is checked for the bracketed, space-separated shape instead.
 *
 * connect-quoted-field-name: a field name in quotes ('level', "batch_size")
 * renders as a quoted word, not as the inline code every other field name on
 * the page is. A quoted token counts when it is a field of the same
 * component (meta.component_fields) or a snake_case identifier.
 *
 * Both skip code: fenced and delimited blocks, attribute lines, inline code
 * spans and passthroughs, where quotes and brackets are the code's own
 * syntax.
 */

/** Text with code blocks, attribute lines and inline code blanked to spaces. */
function proseOnly (text) {
  const lines = String(text).split('\n')
  const out = []
  let close = null
  for (const line of lines) {
    const t = line.replace(/\s+$/, '')
    if (close) {
      if (t === close) close = null
      out.push('')
      continue
    }
    const fence = t.match(/^(`{3,})[\w.+#-]*$/)
    if (fence) {
      close = fence[1]
      out.push('')
      continue
    }
    if (/^(-{4,}|\.{4,}|\+{4,}|\/{4,})$/.test(t)) {
      close = t
      out.push('')
      continue
    }
    // Block attribute lines ([source,yaml], [role="x"]) and AsciiDoc
    // table cells starting with a literal style are markup, not prose.
    if (/^\[.*\]$/.test(t.trim())) {
      out.push('')
      continue
    }
    out.push(line)
  }
  return out.join('\n')
    .replace(/pass:[a-z,]*\[[^\]]*\]/g, (m) => ' '.repeat(m.length))
    .replace(/\+\+\+[\s\S]*?\+\+\+/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))
    // A backtick left unclosed on its line was meant to open code: what
    // follows is code with a broken span, not prose with a quoted name.
    .replace(/`[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^\w+])\+[^+\n]+\+(?![\w+])/g, (m, lead) => lead + ' '.repeat(m.length - lead.length))
}

// Go's %v rendering of a []string: "[a b c]". Two or more space-separated
// words in brackets, opened after whitespace, a colon or a parenthesis (so
// an AsciiDoc macro's link text, xref:page.adoc[Page title], is not one), and
// not followed by ( or [ (a Markdown link or a nested attribute list).
const RENDERED_SLICE = /(^|[\s:(])(\[[A-Za-z0-9][\w./-]*(?: [A-Za-z0-9][\w./-]*)+\])(?![([\w])/m

/** The first Go-slice-shaped rendering in prose, or null. */
function renderedSlice (text) {
  const m = proseOnly(text).match(RENDERED_SLICE)
  return m ? m[2] : null
}

// A quoted identifier: 'level', "batch_size", "tls.enabled", and the curly
// forms. The quote must not touch a word character, so contractions
// (doesn't, it's) and possessives never pair up.
const QUOTED = /(?<![\w'"`])(?:'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)'|"([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)"|‘([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)’|“([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)”)(?![\w'"`])/g
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/

/** Quoted tokens that read as field names: [{ quoted, token, why }]. */
function quotedFieldNames (text, fields = null) {
  const out = []
  const seen = new Set()
  for (const m of proseOnly(text).matchAll(QUOTED)) {
    const token = m[1] || m[2] || m[3] || m[4]
    const segments = token.split('.')
    let why = null
    if (fields && (fields.has(token) || fields.has(segments[0]))) why = 'field'
    else if (segments.some((s) => SNAKE.test(s))) why = 'identifier'
    if (!why || seen.has(m[0])) continue
    seen.add(m[0])
    out.push({ quoted: m[0], token, why })
  }
  return out
}

/** Strings that are not AsciiDoc: CLI help and plain-text short descriptions. */
const notAsciiDoc = (decl) => (decl.convention && decl.convention.verbatim_asciidoc === false) ||
  (decl.meta && decl.meta.kind === 'field-short')

const GO_SLICE_RULE = {
  name: 'connect-go-slice-format',
  description: 'A Go slice or map formatted with %v publishes Go syntax, such as [a b c]',
  why: 'The page shows the list as Go prints it, in brackets with no commas, instead of as a readable list of values.',
  standard: STANDARD.connect,
  severity: 'warning',
  // The slice is usually built at init time, so the string is
  // unverifiable; the finding comes from the source, not the text.
  runOnUnverifiable: true,
  check: (decl) => {
    const args = (decl.meta && decl.meta.go_collection_args) || []
    if (args.length > 0) {
      return args.map((a) => ({
        message: `${a.call} formats ${a.arg} (${a.type}) with ${a.verb}, which publishes Go's ${a.type.startsWith('map') ? 'map' : 'slice'} syntax, such as "[a b c]". Drop the list when the page already shows it (an enum field lists its options), or write it as prose with each item in inline code.`
      }))
    }
    if (!decl.string || (decl.meta && decl.meta.unverifiable)) return []
    const found = renderedSlice(decl.string)
    if (!found) return []
    return [{ message: `"${found}" reads as a Go slice printed with %v. Write the list as prose with each item in inline code, or drop it when the page already shows it.` }]
  }
}

const QUOTED_FIELD_RULE = {
  name: 'connect-quoted-field-name',
  description: 'A field name in quotes instead of inline code',
  why: 'Every other field name on the page is inline code, so a quoted one reads as an ordinary word and is harder to match to the config.',
  standard: STANDARD.qualityBar,
  severity: 'warning',
  check: (decl) => {
    if (!decl.string || notAsciiDoc(decl)) return []
    const fields = decl.meta && decl.meta.component_fields
    return quotedFieldNames(decl.string, fields).map(({ quoted, token, why }) => ({
      message: `${quoted} is ${why === 'field' ? 'a field of this component' : 'a snake_case identifier'}, written in quotes, so the page shows a quoted word. Write field names, keys and values as inline code: \`${token}\`. In a Go raw string that is \`+"\`${token}\`"+\`.`
    }))
  }
}

module.exports = { GO_SLICE_RULE, QUOTED_FIELD_RULE, proseOnly, renderedSlice, quotedFieldNames }
