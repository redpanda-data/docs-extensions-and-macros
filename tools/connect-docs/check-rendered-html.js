'use strict'

const fs = require('fs')
const path = require('path')

/**
 * doc-tools check-rendered-html: scan the rendered HTML of one or more Antora
 * component paths for AsciiDoc that did not convert, and for links that go
 * nowhere. Every rule here is a symptom a reader sees on the published page
 * and that the Antora log does not report:
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
 *   broken-anchor        a link fragment (`#x`, `../kafka/#tls`) that matches
 *                        no `id` (or `a[name]`) on the target page.
 *   broken-link          a relative or root-relative link to a page under a
 *                        link root (by default `connect/` and
 *                        `cloud-data-platform/develop/connect/`) that is not in
 *                        the build.
 *
 * Links are checked against the built site only: external links, `mailto:`
 * and the like are ignored, and a link into a path outside every link root,
 * or into a link root the build does not contain (a trimmed build), is counted
 * as unchecked, never as a finding.
 *
 * Only the page body (`article.doc`) is scanned, so the site navigation and
 * footer never count. Findings are reported per page; the command exits 0
 * unless --strict, because the published docs still have known instances.
 * With a changed-pages list, findings are split into those on the listed
 * pages and the rest, and --strict fails only on the listed pages.
 */

const RULES = Object.freeze({
  'literal-backtick': 'Literal backtick outside code',
  'literal-xref': 'Literal xref: text outside code',
  'literal-include': 'Literal include:: text outside code',
  'leftover-attribute': 'Leftover {page-*} or {env-*} attribute reference',
  'table-markup': 'Literal |=== table markup',
  'unresolved-include': 'Unresolved include directive',
  'unresolved-xref': 'Unresolved xref (link with the unresolved class)',
  'empty-section': 'Empty section (heading followed directly by another heading of the same or higher level)',
  'broken-anchor': 'Broken anchor (link fragment with no matching id on the target page)',
  'broken-link': 'Broken link (target page not in the build)'
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
  // Site paths whose pages must exist when linked to. A root the build does
  // not contain is skipped, so a trimmed build reports unchecked links there.
  linkRoots: Object.freeze(['connect', 'cloud-data-platform/develop/connect']),
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

function safeDecode (text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

// Every fragment target in a document: element ids and named anchors.
function collectIds ($) {
  const ids = new Set()
  $('[id]').each((_, el) => { ids.add(el.attribs.id) })
  $('a[name]').each((_, el) => { ids.add(el.attribs.name) })
  return ids
}

function loadHtml (html) {
  // cheerio/slim parses with htmlparser2 and leaves out the fetch helpers,
  // whose undici dependency needs Node.js 20 or later.
  const cheerio = require('cheerio/slim')
  return cheerio.load(html)
}

// The origin pages are resolved against. Only its path matters.
const SITE_ORIGIN = 'http://site.invalid'

/**
 * Resolve links from built pages against an Antora output directory.
 * check(fromPage, href) returns { status } where status is one of 'ok',
 * 'external', 'unchecked', 'broken-link' or 'broken-anchor'. Target pages are
 * parsed once and their ids cached.
 */
function createLinkResolver ({ siteDir, linkRoots = DEFAULTS.linkRoots } = {}) {
  const norm = (r) => String(r).replace(/^\/+|\/+$/g, '')
  // A root counts only when the build contains it.
  const roots = [...new Set(linkRoots.map(norm).filter(Boolean))].filter((r) => fs.existsSync(path.join(siteDir, r)))
  const idCache = new Map()
  const fileCache = new Map()
  const isFile = (abs) => {
    if (!fileCache.has(abs)) {
      let ok = false
      try { ok = fs.statSync(abs).isFile() } catch {}
      fileCache.set(abs, ok)
    }
    return fileCache.get(abs)
  }
  const resolveFile = (rel) => {
    const abs = path.join(siteDir, rel)
    if (rel === '' || rel.endsWith('/')) return isFile(path.join(abs, 'index.html')) ? path.join(abs, 'index.html') : null
    for (const candidate of [abs, path.join(abs, 'index.html'), `${abs}.html`]) if (isFile(candidate)) return candidate
    return null
  }
  const idsOf = (file) => {
    if (!idCache.has(file)) idCache.set(file, collectIds(loadHtml(fs.readFileSync(file, 'utf8'))))
    return idCache.get(file)
  }
  return {
    roots,
    // Seed the cache with a page already parsed for its own checks.
    remember (page, ids) { idCache.set(path.join(siteDir, page), ids) },
    check (fromPage, href) {
      const raw = href.trim()
      // Any scheme (http:, mailto:, javascript:, ...) or a protocol-relative URL.
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return { status: 'external' }
      let url
      try {
        url = new URL(raw, `${SITE_ORIGIN}/${fromPage.split(path.sep).join('/')}`)
      } catch {
        return { status: 'unchecked' }
      }
      if (url.origin !== SITE_ORIGIN) return { status: 'external' }
      const rel = safeDecode(url.pathname).replace(/^\/+/, '')
      if (!roots.some((r) => rel === r || rel.startsWith(`${r}/`))) return { status: 'unchecked' }
      const target = resolveFile(rel)
      if (!target) return { status: 'broken-link' }
      const fragment = safeDecode(url.hash.slice(1))
      if (!fragment || !target.endsWith('.html')) return { status: 'ok' }
      return { status: idsOf(target).has(fragment) ? 'ok' : 'broken-anchor' }
    }
  }
}

/**
 * Check one HTML document. Returns { findings: { ruleId: { count, samples } }, links }.
 * Same-page fragments are always checked. Links to other pages are checked
 * only when `resolver` (from createLinkResolver) and `page` (this page's path
 * relative to the site directory) are given.
 */
function checkHtml (html, { contextChars = DEFAULTS.contextChars, maxSamples = DEFAULTS.maxSamples, resolver, page } = {}) {
  const $ = loadHtml(html)
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

  // Links. An unresolved xref is already reported as unresolved-xref.
  const ids = collectIds($)
  if (resolver && page) resolver.remember(page, ids)
  const links = { internal: 0, external: 0, unchecked: 0 }
  $(article).find('a[href]').each((_, a) => {
    if (hasClass(a, 'unresolved')) return
    // A glossterm renders as a tooltip whose href is #<term>, on every
    // page; it was never meant to land on an anchor.
    if (hasClass(a, 'glossary-term')) return
    const href = a.attribs.href.trim()
    if (!href || href === '#') return
    const label = `${$(a).text().replace(/\s+/g, ' ').trim()} -> ${href}`.trim()
    if (href.startsWith('#')) {
      links.internal++
      if (!ids.has(safeDecode(href.slice(1)))) add('broken-anchor', label)
      return
    }
    if (!resolver || !page) return
    const { status } = resolver.check(page, href)
    if (status === 'external') links.external++
    else if (status === 'unchecked') links.unchecked++
    else {
      links.internal++
      if (status !== 'ok') add(status, label)
    }
  })

  return { findings, links }
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

const toPosix = (p) => p.split(path.sep).join('/')
const normPage = (p) => toPosix(path.normalize(String(p).trim())).replace(/^\.?\//, '')

function summarize (pageResults, scanned) {
  const totals = Object.fromEntries(Object.keys(RULES).map((id) => [id, 0]))
  for (const p of pageResults) for (const [id, f] of Object.entries(p.findings)) totals[id] += f.count
  const total = Object.values(totals).reduce((a, b) => a + b, 0)
  return { scanned, total, totals, pages: pageResults }
}

/**
 * Scan every HTML page of one or more component paths in an Antora output
 * directory. `component` is a path under the site directory, or an array of
 * them (for example ['connect', 'cloud-data-platform/develop/connect']).
 * `pages` (optional) limits the scan to these paths relative to the site
 * directory. `changedPages` (optional) splits the result: `changed` holds the
 * findings on those pages, `other` the rest, and `changed.missing` the listed
 * pages that are not in the scan.
 */
function checkRenderedHtml ({ siteDir, component = DEFAULTS.component, pages, changedPages, linkRoots = DEFAULTS.linkRoots, ...opts } = {}) {
  if (!siteDir || !fs.existsSync(siteDir)) throw new Error(`site directory not found: ${siteDir}`)
  const components = (Array.isArray(component) ? component : [component]).filter((c) => c !== undefined && c !== null)
  const dirs = components.length && components.every(Boolean) ? components.map((c) => path.join(siteDir, c)) : [siteDir]
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) throw new Error(`component directory not found: ${dir} (is --component right?)`)
  }
  let files = [...new Set(dirs.flatMap(listHtmlFiles))].sort()
  if (pages) {
    const wanted = new Set(pages.map(normPage))
    files = files.filter((f) => wanted.has(toPosix(path.relative(siteDir, f))))
  }
  // Scanned components are always link roots: their pages are in the build.
  const resolver = createLinkResolver({ siteDir, linkRoots: [...linkRoots, ...components.filter(Boolean)] })
  const links = { internal: 0, external: 0, unchecked: 0 }
  const results = []
  for (const file of files) {
    const page = toPosix(path.relative(siteDir, file))
    const { findings, links: l } = checkHtml(fs.readFileSync(file, 'utf8'), { ...opts, resolver, page })
    for (const k of Object.keys(links)) links[k] += l[k]
    if (!Object.keys(findings).length) continue
    results.push({ page, findings })
  }
  results.sort((a, b) => count(b) - count(a) || a.page.localeCompare(b.page))
  const result = { ...summarize(results, files.length), links, linkRoots: resolver.roots }
  if (changedPages) {
    const listed = new Set(changedPages.map(normPage))
    const scannedPages = new Set(files.map((f) => toPosix(path.relative(siteDir, f))))
    const inChanged = (p) => listed.has(p.page)
    result.changed = {
      ...summarize(results.filter(inChanged), [...listed].filter((p) => scannedPages.has(p)).length),
      listed: listed.size,
      missing: [...listed].filter((p) => !scannedPages.has(p)).sort()
    }
    result.other = summarize(results.filter((p) => !inChanged(p)), files.length - result.changed.scanned)
  }
  return result
}

/**
 * Read a changed-pages file: either one page path per line (relative to the
 * site directory, the `sitePath` that connect-docs-diff reports), or the JSON
 * output of `connect-docs-diff --format json`, whose pages[].sitePath is used.
 */
function readChangedPages (file) {
  const text = fs.readFileSync(file, 'utf8')
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const data = JSON.parse(trimmed)
    const list = Array.isArray(data) ? data : data.pages || []
    return list.map((p) => (typeof p === 'string' ? p : p.sitePath)).filter(Boolean)
  }
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
}

function count (pageResult) {
  return Object.values(pageResult.findings).reduce((a, f) => a + f.count, 0)
}

function mdCell (text) {
  return String(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/`/g, '&#96;').replace(/</g, '&lt;')
}

function pageTable (lines, pageResults, maxPages) {
  if (!pageResults.length) return
  lines.push('| Page | Findings | Example |', '|---|---|---|')
  for (const p of pageResults.slice(0, maxPages)) {
    const counts = Object.entries(p.findings).map(([id, f]) => `${id}: ${f.count}`).join(', ')
    const first = Object.values(p.findings)[0]
    lines.push(`| ${mdCell(p.page)} | ${counts} | ${mdCell(first.samples[0] || '')} |`)
  }
  if (pageResults.length > maxPages) lines.push('', `${pageResults.length - maxPages} more pages with findings are not listed.`)
  lines.push('')
}

function linksLine (lines, result) {
  if (!result.links) return
  const l = result.links
  lines.push(`Links: ${l.internal} checked, ${l.unchecked} not checked (target outside ${result.linkRoots && result.linkRoots.length ? result.linkRoots.map((r) => `${r}/`).join(' and ') : 'the build'}), ${l.external} external.`, '')
}

function formatMarkdown (result, { strict = false, maxPages = DEFAULTS.maxPages } = {}) {
  const lines = []
  if (result.changed) return formatChangedMarkdown(result, { strict, maxPages })
  const state = result.total === 0 ? 'clean' : strict ? 'failed' : `${result.total} findings (warning only)`
  lines.push(`## Rendered HTML checks: ${state}`, '')
  lines.push(`Scanned ${result.scanned} pages; ${result.pages.length} have findings.`, '')
  linksLine(lines, result)
  lines.push('| Check | Count |', '|---|---|')
  for (const [id, label] of Object.entries(RULES)) lines.push(`| ${mdCell(label)} | ${result.totals[id]} |`)
  lines.push('')
  pageTable(lines, result.pages, maxPages)
  return lines.join('\n')
}

function formatChangedMarkdown (result, { strict, maxPages }) {
  const { changed, other } = result
  const lines = []
  const state = changed.total === 0 ? 'clean' : strict ? 'failed' : `${changed.total} findings on changed pages (warning only)`
  lines.push(`## Rendered HTML checks: ${state}`, '')
  lines.push(`Scanned ${result.scanned} pages, ${changed.scanned} of them changed. ${changed.pages.length} changed and ${other.pages.length} other pages have findings.`, '')
  linksLine(lines, result)
  lines.push('| Check | Changed pages | Other pages |', '|---|---|---|')
  for (const [id, label] of Object.entries(RULES)) lines.push(`| ${mdCell(label)} | ${changed.totals[id]} | ${other.totals[id]} |`)
  lines.push('')
  if (changed.missing.length) {
    lines.push(`${changed.missing.length} changed ${changed.missing.length === 1 ? 'page is' : 'pages are'} not in the scan (removed, or outside the scanned components): ${changed.missing.map((p) => `\`${p}\``).join(', ')}`, '')
  }
  lines.push('### Findings on changed pages', '')
  if (changed.pages.length) pageTable(lines, changed.pages, maxPages)
  else lines.push('None.', '')
  if (other.pages.length) {
    lines.push('<details>', `<summary>Findings on other pages (${other.total})</summary>`, '')
    pageTable(lines, other.pages, maxPages)
    lines.push('</details>', '')
  }
  return lines.join('\n')
}

// --component and --link-root take a value more than once, or a comma list.
function splitList (value) {
  if (value === undefined || value === null) return undefined
  const list = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean)
  return list.length ? list : undefined
}

function runCli (siteDir, options = {}) {
  let result
  try {
    const pages = options.pages
      ? fs.readFileSync(options.pages, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
      : undefined
    const changedPages = options.changedPages ? readChangedPages(options.changedPages) : undefined
    result = checkRenderedHtml({
      siteDir,
      component: splitList(options.component) || DEFAULTS.component,
      linkRoots: splitList(options.linkRoot) || DEFAULTS.linkRoots,
      pages,
      changedPages
    })
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
  // With a changed-pages list, only findings on those pages fail --strict.
  const failing = result.changed ? result.changed.total : result.total
  process.exit(options.strict && failing > 0 ? 1 : 0)
}

module.exports = {
  DEFAULTS,
  RULES,
  checkHtml,
  checkRenderedHtml,
  createLinkResolver,
  formatMarkdown,
  readChangedPages,
  runCli
}
