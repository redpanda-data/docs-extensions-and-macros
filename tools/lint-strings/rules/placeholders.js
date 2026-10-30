'use strict'

/**
 * unexplained-placeholder: an editable placeholder in a code block that
 * nothing near the block explains.
 *
 * The docs UI (redpanda-data/docs-ui src/js/11-editable-placeholders.js)
 * turns text in a code block into an editable field, so a reader can type a
 * value once and have it fill in every block on the page. A doc string that
 * holds a code block (a Connect component description with a [source,yaml]
 * example, for instance) ships those placeholders to the page, and the page
 * is generated, so the explanation has to live in the same string.
 *
 * Detection mirrors the docs UI exactly:
 *   - only source blocks, which Asciidoctor renders as `pre > code`:
 *     [source,lang] or [,lang] over ---- or ...., ``` fences, and
 *     [source,lang] over a paragraph. A plain ---- listing and a literal block
 *     have no <code> element and are left alone;
 *   - not when the block has the no-placeholders role;
 *   - not when the language is one of SKIP_LANGS (exact, case and all);
 *   - every match of EDITABLE against the block's escaped text, after
 *     callout markers are removed, except <none>.
 *
 * A placeholder counts as explained when, inside the same string, the
 * paragraph before the block or the few paragraphs after it name it
 * (<pipe-name>, `pipe-name`, or "pipe name" in words), a callout list follows
 * a callout on its line, prose names the field or flag it is the whole value
 * of, a code comment on or above its line describes it, or an earlier block
 * in the string already explained it. The docs-team-standards style lint
 * (scripts/style_lint.py, Redpanda.Placeholder) applies the same rules to
 * .adoc pages.
 */

const SKIP_LANGS = new Set(['xml', 'html', 'rust', 'coffeescript', 'text', 'bloblang', 'blobl'])
const EDITABLE = /&lt;.[^&A-Z]+&gt;/g
// Asciidoctor's callout markers at the end of a line (<1>, <.>, // <1>,
// <!--1-->). They render as conum elements, not text.
const CALLOUT = /(?:(?:\/\/|#|--|;;) ?)?(\\)?<!?(|--)(\d+|\.)\2>(?=(?: ?\\?<!?\2(?:\d+|\.)\2>)*$)/gm
const COLIST = /^<(\d+|\.)>\s/
const ATTR_LINE = /^\[(.*)\]$/
const TITLE_LINE = /^\.[^\s.]/
const HEADING = /^={1,6}\s/
const LIST_ITEM = /^(\*+|-|\.+|\d+\.|<(\d+|\.)>)\s|^\S.*::(\s|$)/
// Code the UI matches by accident: generics, operators, closing or
// self-closing tags, format verbs, schema notation.
const NOT_A_NAME = /^[/=]|[=,@%|"'(){};]|\/$/
const PARAGRAPHS_AFTER = 3

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Positional and named entries of a block attribute line, quotes kept whole. */
function splitAttrs (body) {
  const parts = []
  let cur = ''
  let quote = null
  for (const ch of body) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === ',') {
      parts.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  parts.push(cur.trim())
  return parts
}

/** { style, lang, roles, subs } from the attribute lines above a block. */
function blockAttrs (lines) {
  let style = null
  let lang = null
  let subs = null
  const roles = new Set()
  for (const line of lines) {
    const m = line.trim().match(ATTR_LINE)
    if (!m || m[1].startsWith('[')) continue // an anchor [[id]]
    const parts = splitAttrs(m[1])
    const positional = parts.filter((x) => !/^[\w-]+=/.test(x))
    for (const x of parts) {
      const eq = x.indexOf('=')
      if (eq < 0) continue
      const k = x.slice(0, eq).trim()
      const v = x.slice(eq + 1).replace(/^["' ]+|["' ]+$/g, '')
      if (k === 'role') v.split(/\s+/).filter(Boolean).forEach((r) => roles.add(r))
      else if (k === 'subs') subs = v
    }
    if (positional.length) {
      const first = positional[0]
      for (const r of first.matchAll(/\.([\w-]+)/g)) roles.add(r[1])
      const name = first.split(/[#.%]/)[0].trim()
      if (name || positional.length > 1) style = name
      if (positional.length > 1 && positional[1]) lang = positional[1].trim()
    }
  }
  if (style === '' && lang) style = 'source' // [,bash] is shorthand for [source,bash]
  return { style, lang, roles, subs }
}

/**
 * Source blocks and hidden lines (every delimited verbatim, comment, or
 * passthrough line, which is never prose that could explain a placeholder).
 */
function codeBlocks (lines) {
  const blocks = []
  const hidden = new Set()
  const n = lines.length
  let i = 0
  while (i < n) {
    const t = lines[i].replace(/\s+$/, '')
    let j = i - 1
    const attrs = []
    while (j >= 0 && (ATTR_LINE.test(lines[j].trim()) || TITLE_LINE.test(lines[j]))) attrs.unshift(lines[j--])
    let { style, lang, roles, subs } = blockAttrs(attrs)
    const fence = t.match(/^(`{3,})([\w.+#-]*)\s*$/)
    if (fence || /^(-{4,}|\.{4,}|\/{4,}|\+{4,})$/.test(t)) {
      const close = fence ? fence[1] : t
      let k = i + 1
      while (k < n && lines[k].replace(/\s+$/, '') !== close) k++
      const end = Math.min(k, n - 1)
      for (let x = i; x <= end; x++) hidden.add(x)
      if (fence) {
        style = 'source'
        lang = fence[2] || lang
      }
      if (style === 'source' && '-.`'.includes(t[0])) {
        blocks.push({ start: j + 1, end, content: lines.slice(i + 1, k), first: i + 1, lang, roles, subs })
      }
      i = k + 1
      continue
    }
    if (style === 'source' && attrs.length && t && !ATTR_LINE.test(t.trim()) && !TITLE_LINE.test(t)) {
      // [source,lang] over a paragraph: the paragraph is the code.
      let k = i
      while (k < n && lines[k].trim()) k++
      blocks.push({ start: j + 1, end: k - 1, content: lines.slice(i, k), first: i, lang, roles, subs })
      for (let x = i; x < k; x++) hidden.add(x)
      i = k
      continue
    }
    i++
  }
  return { blocks, hidden }
}

/** [{ name, offset }] the docs UI makes editable in this block. */
function editablePlaceholders (block) {
  if (block.roles.has('no-placeholders') || SKIP_LANGS.has(block.lang)) return []
  const subs = block.subs || ''
  if (subs === 'none' || /-special/.test(subs)) return [] // < and > reach the page as markup
  const text = block.content.map((line) => line.replace(CALLOUT, '')).join('\n')
  const html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const found = []
  const seen = new Set()
  for (const m of html.matchAll(EDITABLE)) {
    const name = m[0].replace(/<[^>]*>/g, '').replace(/&lt;|&gt;/g, '')
    if (name.trim() === 'none' || seen.has(name)) continue
    seen.add(name)
    found.push({ name, offset: html.slice(0, m.index).split('\n').length - 1 })
  }
  return found
}

/** Visible prose lines in [start, end): no comments, no code-block content. */
function prose (lines, start, end, hidden) {
  const out = []
  for (let i = start; i < end; i++) {
    if (hidden.has(i)) continue
    const t = lines[i].trim()
    if (t.startsWith('//') || /^(ifn?def|ifeval|endif|include)::/.test(t)) continue
    out.push(t)
  }
  return out
}

/** Up to `limit` paragraphs after a block, stopping at the next heading. A list counts as one. */
function windowAfter (lines, block, hidden, limit = PARAGRAPHS_AFTER) {
  const text = []
  let paragraphs = 0
  let inPara = false
  for (const t of prose(lines, block.end + 1, lines.length, hidden)) {
    if (HEADING.test(t)) break
    if (!t || ['+', '--', '===='].includes(t) || ATTR_LINE.test(t)) {
      if (inPara && !t) inPara = false
      continue
    }
    if (!inPara) {
      if (!LIST_ITEM.test(t) || !text.length || !LIST_ITEM.test(text[text.length - 1])) paragraphs++
      if (paragraphs > limit) break
      inPara = true
    }
    text.push(t)
  }
  return text
}

/** The paragraph that leads in to a block, if it is right above it. */
function windowBefore (lines, block, hidden) {
  const text = []
  let i = block.start - 1
  while (i >= 0 && !hidden.has(i) && (/^(\+|--|={4,})?$/.test(lines[i].trim()) || ATTR_LINE.test(lines[i].trim()) || /^\S.*::$/.test(lines[i].trim()))) i--
  while (i >= 0 && !hidden.has(i) && lines[i].trim() && !HEADING.test(lines[i])) {
    if (!lines[i].trim().startsWith('//')) text.unshift(lines[i].trim())
    i--
  }
  return text
}

/** <name>, any case, or `name` for a multi-word name. */
function names (text, name) {
  const low = text.join('\n').toLowerCase()
  const n = name.toLowerCase()
  return low.includes(`<${n}>`) || (/[-_]/.test(name) && low.includes(`\`${n}\``))
}

/** The name said in words: "the chart name" for <chart-name>. */
function namesInWords (text, name) {
  const words = name.toLowerCase().split(/[-_\s]+/).filter(Boolean)
  if (!words.length || !words.every((w) => /^[a-z0-9]+$/.test(w))) return false
  const phrase = new RegExp(`\\b(?:${words.map(escapeRe).join('\\s+')}|${escapeRe(words.join(''))})\\b`)
  return phrase.test(text.join('\n').toLowerCase())
}

/** The field or flag the placeholder is the whole value of, named in prose. */
function namesKey (text, line, name) {
  const whole = escapeRe(`<${name}>`) + '(?=$|[\\s"\',;)\\]}\\\\])'
  const joined = text.join('\n')
  let m = line.match(new RegExp(`(--?[\\w-]+)[ =]["']?${whole}`))
  if (m && (new RegExp('`' + escapeRe(m[1]) + '(?:[ =][^`]*)?`').test(joined) || namesInWords(text, m[1].replace(/^-+/, '')))) return true
  m = line.match(new RegExp(`([\\w-]+)["']?\\s*[:=]\\s*["']?${whole}`))
  return Boolean(m && new RegExp('`(?:[\\w.\\[\\]-]*\\.)?' + escapeRe(m[1]) + '[:=]?`').test(joined))
}

/** A trailing comment on the line, or a comment line right above it. */
function commentsOn (line, previous, name) {
  const rest = line.slice(line.indexOf(`<${name}>`) + name.length + 2)
  return /\s(#|\/\/|--)\s+\w/.test(rest) || /^\s*(#|\/\/|--)\s*\w/.test(previous)
}

/** A "Replace <name> ..." sentence, or a list item or table row that starts with it. */
function definedEarlier (text, name) {
  const n = name.toLowerCase()
  const lead = new RegExp('^(?:[*.-]+\\s+|[a-z]?\\|\\s*)?[`+]*' + escapeRe(`<${n}>`))
  return text.some((t) => {
    const low = t.toLowerCase()
    return low.includes(`<${n}>`) && (low.includes('replace') || lead.test(low))
  })
}

/** [{ name, line, accidental }] for every unexplained editable placeholder in the text. */
function unexplainedPlaceholders (text) {
  const lines = text.split('\n')
  const { blocks, hidden } = codeBlocks(lines)
  const explained = new Set()
  const reported = new Set()
  const out = []
  for (const b of blocks) {
    const found = editablePlaceholders(b)
    if (!found.length) continue
    const before = windowBefore(lines, b, hidden)
    const after = windowAfter(lines, b, hidden)
    const near = before.concat(windowAfter(lines, b, hidden, 1))
    const earlier = prose(lines, 0, b.start, hidden)
    const hasColist = after.some((t) => COLIST.test(t))
    for (const { name, offset } of found) {
      const line = b.content[offset] || ''
      const previous = offset > 0 ? b.content[offset - 1] || '' : ''
      CALLOUT.lastIndex = 0
      const ok = explained.has(name) || names(before.concat(after), name) || definedEarlier(earlier, name) ||
        namesKey(before.concat(after), line, name) || namesInWords(near, name) || commentsOn(line, previous, name) ||
        (hasColist && new RegExp(CALLOUT.source, 'm').test(line))
      if (ok) {
        explained.add(name)
        continue
      }
      if (reported.has(name)) continue
      reported.add(name)
      out.push({ name, line: b.first + offset + 1, accidental: NOT_A_NAME.test(name) })
    }
  }
  return out
}

const PLACEHOLDER_RULE = {
  name: 'unexplained-placeholder',
  description: 'Editable code-block placeholder that nothing near the block explains',
  severity: 'warning',
  check: (decl) => {
    const text = decl.string || ''
    if (!text.includes('<') || (decl.convention && decl.convention.verbatim_asciidoc === false)) return []
    return unexplainedPlaceholders(text).map(({ name, line, accidental }) => ({
      message: accidental
        ? `The docs UI makes "<${name}>" (line ${line} of this string) an editable placeholder, because it is inside a code block. If a reader isn't meant to replace it, add role="no-placeholders" to the block; if they are, give it a lowercase, hyphenated name and explain it after the block.`
        : `"<${name}>" (line ${line} of this string) is an editable placeholder on the docs page, but nothing near its code block says what to replace it with. After the block, add a sentence such as "Replace \`<${name}>\` with ...", a "where" list, or a callout. Name it for the value, such as <pipe-name> rather than <pipe>.`
    }))
  }
}

module.exports = { PLACEHOLDER_RULE, unexplainedPlaceholders, editablePlaceholders, codeBlocks }
