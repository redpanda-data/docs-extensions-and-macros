'use strict'

const fs = require('fs')
const path = require('path')

/**
 * doc-tools check-rendered-html: scan the rendered HTML of one Antora
 * component for AsciiDoc that did not convert. Every rule here is a symptom a
 * reader sees on the published page and that the Antora log does not report:
 *
 *   literal-backtick     a backtick in prose, outside code. Two backticks for
 *                        an empty enum option, or a glued backtick such as
 *                        `name`can, both land here.
 *   literal-xref         the text `xref:` outside code: a cross reference that
 *                        was never parsed as a macro.
 *   literal-include      the text `include::` outside code.
 *   leftover-attribute   a `{page-...}` or `{env-...}` reference left in the
 *                        output because the attribute was not set.
 *   table-markup         `|===` in the output: a table that did not parse.
 *   unresolved-include   Asciidoctor's "Unresolved include directive" text,
 *                        checked everywhere, code blocks included.
 *   unresolved-xref      a link Antora marked with the `unresolved` class.
 *   empty-section        a heading followed directly by a heading of the same
 *                        or a higher level, so the section has no content.
 *
 * Only the page body (`article.doc`) is scanned, so the site navigation and
 * footer never count. Findings are reported per page; the command exits 0
 * unless --strict, because the published docs still have known instances.
 */

const RULES = Object.freeze({
  'literal-backtick': 'Literal backtick outside code',
  'literal-xref': 'Literal xref: text outside code',
  'literal-include': 'Literal include:: text outside code',
  'leftover-attribute': 'Leftover {page-*} or {env-*} attribute reference',
  'table-markup': 'Literal |=== table markup',
  'unresolved-include': 'Unresolved include directive',
  'unresolved-xref': 'Unresolved xref (link with the unresolved class)',
  'empty-section': 'Empty section (heading followed directly by another heading of the same or higher level)'
})

// Text inside these elements is code (or not prose at all), where a backtick
// or `include::` is legitimate content.
const CODE_ELEMENTS = new Set(['code', 'pre', 'kbd', 'samp', 'tt', 'script', 'style', 'textarea', 'svg', 'math'])

const TEXT_RULES = [
  { id: 'literal-backtick', re: /`/g },
  { id: 'literal-xref', re: /\bxref:/g },
  { id: 'literal-include', re: /include::/g },
  { id: 'leftover-attribute', re: /\{(?:page|env)-[A-Za-z0-9_-]+\}/g },
  { id: 'table-markup', re: /\|===/g }
]
const UNRESOLVED_INCLUDE_RE = /Unresolved include directive/g

const DEFAULTS = Object.freeze({
  component: 'connect',
  maxSamples: 3,
  maxPages: 100,
  contextChars: 40
})

function snippet (text, index, length, contextChars) {
  const start = Math.max(0, index - contextChars)
  const end = Math.min(text.length, index + length + contextChars)
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`.replace(/\s+/g, ' ').trim()
}

function headingLevel (node) {
  if (!node || node.type !== 'tag') return 0
  const m = /^h([1-6])$/.exec(node.name)
  return m ? Number(m[1]) : 0
}

function isBlankText (node) {
  return node.type === 'text' ? !node.data.trim() : node.type === 'comment'
}

function hasClass (node, cls) {
  const value = node.attribs && node.attribs.class
  return !!value && value.split(/\s+/).includes(cls)
}

/**
 * Check one HTML document. Returns { findings: { ruleId: { count, samples } } }.
 */
function checkHtml (html, { contextChars = DEFAULTS.contextChars, maxSamples = DEFAULTS.maxSamples } = {}) {
  const cheerio = require('cheerio')
  const $ = cheerio.load(html)
  const article = $('article.doc').get(0) || $('body').get(0) || $.root().get(0)
  const findings = {}
  const add = (id, sample) => {
    const f = findings[id] || (findings[id] = { count: 0, samples: [] })
    f.count++
    if (sample && f.samples.length < maxSamples && !f.samples.includes(sample)) f.samples.push(sample)
  }

  // Text rules. A text node is "in code" when any ancestor is a code element.
  const walk = (node, inCode) => {
    if (node.type === 'text') {
      const text = node.data
      UNRESOLVED_INCLUDE_RE.lastIndex = 0
      const unresolved = UNRESOLVED_INCLUDE_RE.test(text)
      if (unresolved) {
        UNRESOLVED_INCLUDE_RE.lastIndex = 0
        let m
        while ((m = UNRESOLVED_INCLUDE_RE.exec(text))) add('unresolved-include', snippet(text, m.index, m[0].length, contextChars))
      }
      if (inCode) return
      for (const rule of TEXT_RULES) {
        // The unresolved-include message quotes the include:: line; count it
        // once, as unresolved-include, not again as literal text.
        if (unresolved && rule.id === 'literal-include') continue
        rule.re.lastIndex = 0
        let m
        while ((m = rule.re.exec(text))) add(rule.id, snippet(text, m.index, m[0].length, contextChars))
      }
      return
    }
    if (node.type !== 'tag' && node.type !== 'root' && node.type !== 'script' && node.type !== 'style') return
    const childInCode = inCode || CODE_ELEMENTS.has(node.name)
    if (node.name === 'a' && hasClass(node, 'unresolved')) {
      add('unresolved-xref', `${$(node).text().trim()} -> ${node.attribs.href || ''}`.trim())
    }
    for (const child of node.children || []) walk(child, childInCode)
  }
  walk(article, false)

  // Empty sections. Asciidoctor wraps each section in div.sectN with the
  // heading first; a level-1 section's content sits in div.sectionbody. A
  // section is empty when nothing but its heading (and blank text) is in it.
  // A section that holds only subsections is not empty: its heading is
  // followed by a LOWER-level heading.
  $(article).find('div.sect1, div.sect2, div.sect3, div.sect4, div.sect5, div.sect6').each((_, sect) => {
    const children = (sect.children || []).filter((c) => !isBlankText(c))
    const heading = children.find((c) => headingLevel(c) > 0)
    if (!heading) return
    let content = children.filter((c) => c !== heading)
    content = content.flatMap((c) => (c.type === 'tag' && hasClass(c, 'sectionbody') ? (c.children || []).filter((x) => !isBlankText(x)) : [c]))
    if (content.length === 0) add('empty-section', $(heading).text().trim())
  })

  return { findings }
}

function listHtmlFiles (dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && entry.name.endsWith('.html')) out.push(full)
    }
  }
  return out.sort()
}

/**
 * Scan every HTML page of a component in an Antora output directory.
 * `pages` (optional) limits the scan to these paths relative to the site
 * directory, for example the pages a PR changed.
 */
function checkRenderedHtml ({ siteDir, component = DEFAULTS.component, pages, ...opts } = {}) {
  if (!siteDir || !fs.existsSync(siteDir)) throw new Error(`site directory not found: ${siteDir}`)
  const componentDir = component ? path.join(siteDir, component) : siteDir
  if (!fs.existsSync(componentDir)) throw new Error(`component directory not found: ${componentDir} (is --component right?)`)
  let files = listHtmlFiles(componentDir)
  if (pages) {
    const wanted = new Set(pages.map((p) => path.normalize(p)))
    files = files.filter((f) => wanted.has(path.relative(siteDir, f)))
  }
  const totals = Object.fromEntries(Object.keys(RULES).map((id) => [id, 0]))
  const results = []
  for (const file of files) {
    const { findings } = checkHtml(fs.readFileSync(file, 'utf8'), opts)
    const ids = Object.keys(findings)
    if (!ids.length) continue
    for (const id of ids) totals[id] += findings[id].count
    results.push({ page: path.relative(siteDir, file).split(path.sep).join('/'), findings })
  }
  const total = Object.values(totals).reduce((a, b) => a + b, 0)
  results.sort((a, b) => count(b) - count(a) || a.page.localeCompare(b.page))
  return { scanned: files.length, total, totals, pages: results }
}

function count (pageResult) {
  return Object.values(pageResult.findings).reduce((a, f) => a + f.count, 0)
}

function mdCell (text) {
  return String(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/`/g, '&#96;').replace(/</g, '&lt;')
}

function formatMarkdown (result, { strict = false, maxPages = DEFAULTS.maxPages } = {}) {
  const lines = []
  const state = result.total === 0 ? 'clean' : strict ? 'failed' : `${result.total} findings (warning only)`
  lines.push(`## Rendered HTML checks: ${state}`, '')
  lines.push(`Scanned ${result.scanned} pages; ${result.pages.length} have findings.`, '')
  lines.push('| Check | Count |', '|---|---|')
  for (const [id, label] of Object.entries(RULES)) lines.push(`| ${label} | ${result.totals[id]} |`)
  lines.push('')
  if (result.pages.length) {
    lines.push('| Page | Findings | Example |', '|---|---|---|')
    for (const p of result.pages.slice(0, maxPages)) {
      const counts = Object.entries(p.findings).map(([id, f]) => `${id}: ${f.count}`).join(', ')
      const first = Object.values(p.findings)[0]
      lines.push(`| ${mdCell(p.page)} | ${counts} | ${mdCell(first.samples[0] || '')} |`)
    }
    if (result.pages.length > maxPages) lines.push('', `${result.pages.length - maxPages} more pages with findings are not listed.`)
    lines.push('')
  }
  return lines.join('\n')
}

function runCli (siteDir, options = {}) {
  let result
  try {
    const pages = options.pages
      ? fs.readFileSync(options.pages, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
      : undefined
    result = checkRenderedHtml({ siteDir, component: options.component, pages })
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(2)
  }
  const out = options.format === 'json' ? JSON.stringify(result, null, 2) : formatMarkdown(result, { strict: !!options.strict })
  console.log(out)
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true })
    fs.writeFileSync(path.resolve(options.output), out + '\n')
  }
  process.exit(options.strict && result.total > 0 ? 1 : 0)
}

module.exports = {
  DEFAULTS,
  RULES,
  checkHtml,
  checkRenderedHtml,
  formatMarkdown,
  runCli
}
