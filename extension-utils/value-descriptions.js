'use strict'

/* How the value macros render text values such as descriptions and examples.
 *
 * A text value comes in one of three source formats:
 *
 *   asciidoc  Property descriptions and examples, and Connect strings while
 *             the Connect data says docs_format: asciidoc.
 *   markdown  Connect strings once the data says docs_format: markdown.
 *   plain     rpk help text, which cobra prints as written.
 *
 * The inline form (propval:x[description]) renders a value only when it is a
 * single paragraph, through AsciiDoc's inline substitutions, so `code`,
 * emphasis and xrefs render as the reference renders them. A longer value is
 * refused with a message that names the block form (propval::x[description]),
 * which parses the value into the page as blocks: lists, admonitions,
 * listings, tables, includes and env-cloud conditionals all work. Headings
 * render as discrete headings, because a section cannot open inside a block.
 *
 * Plain text is never parsed as markup: it renders as paragraphs, with each
 * indented run (cobra's examples) and each ---- delimited listing (some rpk
 * descriptions carry one) as a literal block.
 */

const { escapeHtml } = require('./html-utils')
const { annotateVerbatimLines } = require('../tools/redpanda-connect/metadata-utils')

const FORMAT_ASCIIDOC = 'asciidoc'
const FORMAT_MARKDOWN = 'markdown'
const FORMAT_PLAIN = 'plain'

// A line that starts a block, or is not prose, in AsciiDoc: indented
// (literal) text, a list item or continuation, an admonition label, a
// heading, a block attribute line, a delimiter, a comment, a preprocessor
// directive, or a description list term.
const ASCIIDOC_BLOCK_LINE = /^(?:\s|[*.-]{1,5}\s|\d+\.\s|\+\s*$|--\s*$|(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION):\s|={1,6}\s|\[.*\]\s*$|-{4,}|\.{4,}|={4,}|\*{4,}|_{4,}|\+{4,}|\/\/|\|===|`{3,}|~{3,}|(?:ifn?def|ifeval|endif|include)::)|\S:{2,4}(?:\s|$)/
// The same for Markdown: indented code, list items, headings, quotes,
// fences, and table rows.
const MARKDOWN_BLOCK_LINE = /^(?:\s{4}|\s*[-*+]\s|\s*\d+[.)]\s|#{1,6}\s|>|`{3,}|~{3,}|\|)/

const INLINE_SUBS = ['specialcharacters', 'quotes', 'attributes', 'replacements', 'macros', 'post_replacements']

/**
 * Whether a text value is one paragraph, the only shape the inline form
 * renders.
 */
function isSingleParagraph (text, format = FORMAT_ASCIIDOC) {
  // Leading blank lines and trailing space go; leading indentation stays,
  // because an indented first line is a literal block.
  const lines = String(text == null ? '' : text).replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '').split('\n')
  if (lines.some((line) => !line.trim())) return false
  if (format === FORMAT_PLAIN) return !lines.some((line) => /^\s/.test(line))
  const rx = format === FORMAT_MARKDOWN ? MARKDOWN_BLOCK_LINE : ASCIIDOC_BLOCK_LINE
  return !lines.some((line) => rx.test(line))
}

/**
 * One paragraph as inline HTML, substituted in the context of the node the
 * macro renders in, so attribute references and xrefs resolve for the page.
 */
function inlineHtml (parent, text, format = FORMAT_ASCIIDOC) {
  const trimmed = String(text == null ? '' : text).trim()
  if (format === FORMAT_PLAIN) return escapeHtml(trimmed)
  const source = format === FORMAT_MARKDOWN ? markdownToAsciidoc(trimmed) : trimmed
  return parent.$apply_subs(source, INLINE_SUBS)
}

/**
 * A heading line in AsciiDoc source becomes a discrete heading, with the
 * blank line a block needs before it. Lines in listings and fences are left
 * alone.
 */
function discreteHeadings (text) {
  const out = []
  for (const { line, verbatim } of annotateVerbatimLines(text)) {
    if (!verbatim && /^={1,6}\s+\S/.test(line) && out[out.length - 1] !== '[discrete]') {
      if (out.length && out[out.length - 1].trim() !== '') out.push('')
      out.push('[discrete]')
    }
    out.push(line)
  }
  return out.join('\n')
}

/**
 * Parse AsciiDoc or Markdown source into a block, as a page's own lines are
 * parsed: through the preprocessor, so ifdef::env-cloud[] and include::
 * directives apply with the page's attributes and include processor.
 */
function parseInto (processor, block, text, format) {
  const source = format === FORMAT_MARKDOWN ? markdownToAsciidoc(text) : discreteHeadings(String(text).trim())
  const lines = source.split('\n')
  const Opal = global.Opal
  if (Opal && Opal.Asciidoctor && Opal.Asciidoctor.PreprocessorReader && Opal.Asciidoctor.Parser) {
    const reader = Opal.Asciidoctor.PreprocessorReader.$new(block.getDocument(), lines)
    Opal.Asciidoctor.Parser.$parse_blocks(reader, block)
  } else {
    processor.parseContent(block, lines)
  }
  return block
}

/**
 * Plain text as paragraphs and literal blocks: blank lines separate
 * paragraphs, and an indented run, with the blank lines inside it, is one
 * literal block, dedented. A listing between ---- lines is a literal block
 * too, without the delimiters and the [,bash] line before them.
 */
function plainSegments (text) {
  const lines = String(text == null ? '' : text).replace(/\s+$/, '').replace(/^\s*\n/, '').split('\n')
  const segments = []
  let current
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const end = /^-{4,}\s*$/.test(line) && (!current || current.kind !== 'literal') ? lines.findIndex((l, j) => j > i && l.trim() === line.trim()) : -1
    if (end !== -1) {
      if (current && /^\[[^\]]*\]\s*$/.test(current.lines[current.lines.length - 1])) {
        current.lines.pop()
        if (!current.lines.length) segments.pop()
      }
      segments.push({ kind: 'literal', lines: lines.slice(i + 1, end) })
      current = undefined
      i = end
      continue
    }
    if (!line.trim()) {
      const next = lines.slice(i + 1).find((l) => l.trim())
      if (current && current.kind === 'literal' && next && /^\s/.test(next)) current.lines.push('')
      else current = undefined
      continue
    }
    const kind = /^\s/.test(line) ? 'literal' : 'paragraph'
    if (!current || current.kind !== kind) {
      current = { kind, lines: [] }
      segments.push(current)
    }
    current.lines.push(line)
  }
  for (const segment of segments) {
    if (segment.kind !== 'literal') continue
    const indent = Math.min(...segment.lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length))
    segment.lines = segment.lines.map((l) => l.slice(indent))
  }
  return segments
}

function plainHtml (text) {
  return plainSegments(text).map((segment) => segment.kind === 'literal'
    ? `<div class="literalblock">\n<div class="content">\n<pre>${escapeHtml(segment.lines.join('\n'))}</pre>\n</div>\n</div>`
    : `<div class="paragraph">\n<p>${escapeHtml(segment.lines.join('\n'))}</p>\n</div>`).join('\n')
}

/**
 * The block form of a text value: an open block with the macro's roles,
 * holding the value parsed (AsciiDoc, Markdown) or as literal text (plain).
 */
function textBlock (processor, parent, { text, format = FORMAT_ASCIIDOC, role }) {
  if (format === FORMAT_PLAIN) {
    return processor.createBlock(parent, 'pass', `<div class="openblock ${escapeHtml(role)}">\n<div class="content">\n${plainHtml(text)}\n</div>\n</div>`, {})
  }
  const block = processor.createBlock(parent, 'open', [], { role })
  return parseInto(processor, block, text, format)
}

/**
 * The block form of a short value, or of a placeholder: the macro's inline
 * HTML in a paragraph of its own.
 */
function htmlParagraph (processor, parent, html) {
  return processor.createBlock(parent, 'pass', `<div class="paragraph">\n<p>${html}</p>\n</div>`, {})
}

/**
 * A rich value ({kind: 'text', text, format} or {kind: 'list', items,
 * format}) as inline HTML, or undefined when it is not a single paragraph
 * (a list renders inline only when every item is one), so the caller can
 * refuse it and name the block form.
 */
function richInlineHtml (parent, rich) {
  if (rich.kind === 'list') {
    if (!rich.items.every((item) => isSingleParagraph(item, rich.format))) return undefined
    return rich.items.map((item) => inlineHtml(parent, item, rich.format)).join(', ')
  }
  return isSingleParagraph(rich.text, rich.format) ? inlineHtml(parent, rich.text, rich.format) : undefined
}

/**
 * A rich value as a block: a text value parsed, a list as a bulleted list,
 * or the value's own blockText when it has one (Connect examples render as a
 * YAML listing).
 */
function richBlock (processor, parent, rich, role) {
  const text = rich.blockText !== undefined
    ? rich.blockText
    : rich.kind === 'list'
    ? rich.items.map((item) => (rich.format === FORMAT_PLAIN ? item : `${rich.format === FORMAT_MARKDOWN ? '-' : '*'} ${item}`)).join(rich.format === FORMAT_PLAIN ? '\n\n' : '\n')
    : rich.text
  return textBlock(processor, parent, { text, format: rich.format, role })
}

// ---------------------------------------------------------------------------
// Markdown to AsciiDoc, for Connect strings in docs_format: markdown. Covers
// what doc strings use: paragraphs, emphasis, code spans, links, lists,
// fenced code, headings, block quotes and pipe tables. Anything else passes
// through as text.

function markdownInline (text) {
  const codes = []
  let out = String(text).replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m, ticks, code) => {
    codes.push(code.trim() === code ? code : code.trim())
    return `\u0000${codes.length - 1}\u0000`
  })
  out = out
    .replace(/\{/g, '\\{')
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, label, url) => (/^(?:https?|mailto):/.test(url) ? `${url}[${label}]` : `link:${url}[${label}]`))
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '\u0001$2\u0001')
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, '$1_$2_')
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1_$2_')
    .replace(/\u0001/g, '*')
  return out.replace(/\u0000(\d+)\u0000/g, (m, n) => `\`+${codes[Number(n)]}+\``)
}

const tableCells = (line) => {
  const cells = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/)
  return cells.map((cell) => markdownInline(cell.trim().replace(/\\\|/g, '|')).replace(/\|/g, '\\|'))
}

/**
 * Markdown source as AsciiDoc source.
 */
function markdownToAsciidoc (markdown) {
  const lines = String(markdown == null ? '' : markdown).replace(/\r\n/g, '\n').split('\n')
  const out = []
  const blank = () => { if (out.length && out[out.length - 1] !== '') out.push('') }
  let inList = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/)
    if (fence) {
      blank()
      out.push(fence[2] ? `[source,${fence[2]}]` : '[listing]', '----')
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) out.push(lines[i])
      out.push('----', '')
      inList = false
      continue
    }
    if (!line.trim()) {
      blank()
      inList = false
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (heading) {
      blank()
      out.push('[discrete]', `${'='.repeat(heading[1].length + 1)} ${markdownInline(heading[2])}`, '')
      inList = false
      continue
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      blank()
      const header = tableCells(line)
      out.push('[%header]', '|===', header.map((c) => `| ${c}`).join(' '))
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) out.push('', tableCells(lines[i]).map((c) => `| ${c}`).join(' '))
      i--
      out.push('|===', '')
      inList = false
      continue
    }
    if (/^>\s?/.test(line)) {
      blank()
      out.push('____')
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) out.push(markdownInline(lines[i].replace(/^>\s?/, '')))
      i--
      out.push('____', '')
      inList = false
      continue
    }
    const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
    if (item) {
      if (!inList) blank()
      const depth = Math.floor(item[1].length / 2)
      const marker = /\d/.test(item[2]) ? '.'.repeat(depth + 1) : '*'.repeat(depth + 1)
      out.push(`${marker} ${markdownInline(item[3])}`)
      inList = true
      continue
    }
    out.push(markdownInline(inList ? line.trim() : line))
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

module.exports = {
  FORMAT_ASCIIDOC,
  FORMAT_MARKDOWN,
  FORMAT_PLAIN,
  isSingleParagraph,
  inlineHtml,
  discreteHeadings,
  parseInto,
  plainSegments,
  textBlock,
  htmlParagraph,
  richInlineHtml,
  richBlock,
  markdownInline,
  markdownToAsciidoc,
}
