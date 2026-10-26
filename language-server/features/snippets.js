'use strict'

/**
 * Snippets served as completion items. Every snippet's text is read from the
 * file that is the source of truth for it, when the workspace loads, so a
 * change to a template changes the snippet with no edit here:
 *
 *   page templates   docs-team-standards resources/templates/*-template.adoc
 *   tabs             docs-team-standards resources/antora/context-switchers-tabs.md,
 *                    the first asciidoc example under "Tab syntax"
 *   admonitions      docs-team-standards resources/writing-style/style-guide.md,
 *                    the table under "Admonitions"
 *   // Source:       docs-team-standards skills/fresh-sources/SKILL.md, the
 *                    example under "Provenance comments in drafts"
 *   prop:, propval:  macros/PROPERTY_AND_ENTERPRISE_REFERENCES.adoc in this
 *                    package, the first example of each macro
 *   solution step    redpanda-solutions templates/solution/docs-module/pages/step.adoc
 *   production note  the [.production-note] block in that step template, for
 *                    each topic in the page's own partials/production/
 *   inline test      the repository's own .doc-detective.json: the inline
 *                    statements it declares for AsciiDoc
 *
 * docs-team-standards files come from the redpandaDocs.standardsPath setting
 * (a checkout), else from the copy vendored into this package at vendor/dts
 * with the same layout. With neither, those snippets are not offered and the
 * workspace notes say why. The solutions template is found by walking up from
 * the component root, so it is used only inside the redpanda-solutions repo.
 *
 * Context decides what is offered. A page with no title gets page skeletons
 * (the solution step skeleton in the solutions repo, the topic-type templates
 * elsewhere). In the body, at the start of a line outside any comment or
 * listing block, it gets the block snippets; the production note only on a
 * solution step page. Nothing is offered in the header, mid-line, or inside a
 * delimited block, so these items never crowd prop: or :page-categories:
 * completions.
 */

const fs = require('fs')
const path = require('path')
const { fileURLToPath } = require('url')
const { inertLines, parseHeader, scanMacros, range } = require('../lib/asciidoc')
const { COMPLETION_KIND } = require('../lib/lsp')

const PACKAGE_ROOT = path.join(__dirname, '..', '..')
const VENDORED_STANDARDS = path.join(PACKAGE_ROOT, 'vendor', 'dts')

// Files read from docs-team-standards, relative to its root.
const STANDARDS_FILES = {
  pageTemplates: 'resources/templates',
  tabs: 'resources/antora/context-switchers-tabs.md',
  styleGuide: 'resources/writing-style/style-guide.md',
  freshSources: 'skills/fresh-sources/SKILL.md',
}
const SECTIONS = {
  tabs: 'Tab syntax',
  admonitions: 'Admonitions',
  sourceComment: 'Provenance comments in drafts',
  prop: 'Property references: the prop macro',
  propval: 'Property values: the propval macro',
}
const PROPERTY_GUIDE = path.join(PACKAGE_ROOT, 'macros', 'PROPERTY_AND_ENTERPRISE_REFERENCES.adoc')
const SOLUTION_TEMPLATE = path.join('templates', 'solution', 'docs-module')
const DOC_DETECTIVE_CONFIG = '.doc-detective.json'

// ---------------------------------------------------------------- snippet text

/** Escapes text for the LSP snippet grammar, where $, } and \ are special. */
const escapeSnippet = (s) => String(s).replace(/[\\$}]/g, '\\$&')

/**
 * The text a snippet inserts when every placeholder keeps its default and
 * every choice its first option: the inverse of building it from a template.
 */
function renderSnippet (snippet) {
  const s = String(snippet)
  let i = 0
  const read = (stop) => {
    let out = ''
    while (i < s.length) {
      const c = s[i]
      if (c === '\\' && i + 1 < s.length && '\\$}|,'.includes(s[i + 1])) { out += s[i + 1]; i += 2; continue }
      if (stop && stop.includes(c)) return out
      if (c === '$') {
        const simple = /^\$(\d+)/.exec(s.slice(i))
        if (simple) { i += simple[0].length; continue }
        const open = /^\$\{(\d+)([:|}])/.exec(s.slice(i))
        if (open) {
          i += open[0].length
          if (open[2] === '}') continue
          if (open[2] === ':') { out += read('}'); i++; continue }
          const first = read(',|')
          while (i < s.length && s[i] !== '|') { i++; read(',|') }
          i += 2 // |}
          out += first
          continue
        }
      }
      out += c
      i++
    }
    return out
  }
  return read(null)
}

// A [Placeholder] in a template: starts with a capital letter, holds a
// lowercase letter or a space (so [NOTE] and [TIP] stay block styles), and
// is not the attribute list of a macro (xref:x[Text], include::x[tag=y]).
const PLACEHOLDER_RX = /(?<![^\s(*])\[([A-Z][^[\]\n]*)\]/g
const isPlaceholder = (inner) => /[a-z ]/.test(inner)

/** A template as snippet text, with each [Placeholder] a tab stop. */
function templateSnippet (text) {
  let n = 0
  let out = ''
  let last = 0
  const src = String(text)
  PLACEHOLDER_RX.lastIndex = 0
  let m
  while ((m = PLACEHOLDER_RX.exec(src))) {
    if (!isPlaceholder(m[1])) continue
    out += escapeSnippet(src.slice(last, m.index)) + `\${${++n}:${escapeSnippet(m[0])}}`
    last = m.index + m[0].length
  }
  return out + escapeSnippet(src.slice(last))
}

// ---------------------------------------------------------------- reading sources

const readIf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)

/**
 * The lines of a Markdown section, from its heading to the next heading of
 * the same or a higher level. Headings inside code fences do not count.
 */
function markdownSection (text, heading) {
  const lines = String(text).split(/\r?\n/)
  let start = -1
  let level = 0
  let fenced = false
  const out = []
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const h = !fenced && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (start < 0) {
      if (h && h[2] === heading) { start = 1; level = h[1].length }
      continue
    }
    if (h && h[1].length <= level) break
    out.push(line)
  }
  return start < 0 ? null : out.join('\n')
}

/** The body of the first fenced code block in `text` tagged `language`. */
function firstFence (text, language) {
  const m = new RegExp('^```' + language + '[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```[ \\t]*$', 'm').exec(String(text || ''))
  return m ? m[1] : null
}

/** The body rows of the first Markdown table in `text`, as cell arrays. */
function markdownTable (text) {
  const rows = String(text || '').split(/\r?\n/).filter((l) => /^\s*\|.*\|\s*$/.test(l))
  return rows.slice(2).map((l) => l.trim().slice(1, -1).split('|').map((c) => c.trim()))
}

/**
 * The lines of an AsciiDoc section, from its heading to the next heading of
 * the same or a higher level, skipping headings inside delimited blocks.
 */
function adocSection (text, title) {
  const lines = String(text).split(/\r?\n/)
  const inert = inertLines(lines)
  let level = 0
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const h = !inert.has(i) && /^(={2,6})\s+(.*?)\s*$/.exec(lines[i])
    if (!level) {
      if (h && h[2] === title) level = h[1].length
      continue
    }
    if (h && h[1].length <= level) break
    out.push(lines[i])
  }
  return level ? out.join('\n') : null
}

/** The content of the first ---- listing block in `text`. */
function firstListing (text) {
  const m = /^(-{4,})[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/m.exec(String(text || ''))
  return m ? m[2] : null
}

/** The directory holding docs-team-standards: the setting, else the vendored copy. */
function standardsRoot (settings = {}) {
  if (settings.standardsPath) {
    const root = path.resolve(settings.standardsPath)
    if (fs.existsSync(path.join(root, STANDARDS_FILES.pageTemplates))) return { root, source: 'redpandaDocs.standardsPath' }
    return { root: null, problem: `redpandaDocs.standardsPath (${root}) has no ${STANDARDS_FILES.pageTemplates}` }
  }
  if (fs.existsSync(path.join(VENDORED_STANDARDS, STANDARDS_FILES.pageTemplates))) return { root: VENDORED_STANDARDS, source: 'vendored' }
  return { root: null, problem: 'set redpandaDocs.standardsPath to a docs-team-standards checkout' }
}

/** The directories from `start` up to the repository root (the first with .git). */
function upToRepoRoot (start) {
  const dirs = []
  let dir = path.resolve(start)
  for (;;) {
    dirs.push(dir)
    if (fs.existsSync(path.join(dir, '.git'))) return dirs
    const parent = path.dirname(dir)
    if (parent === dir) return dirs
    dir = parent
  }
}

// ---------------------------------------------------------------- snippet sets

function pageTemplates (root) {
  const dir = path.join(root, STANDARDS_FILES.pageTemplates)
  return fs.readdirSync(dir).filter((f) => /-template\.adoc$/.test(f)).sort().map((f) => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    const name = f.replace(/-template\.adoc$/, '')
    const type = (parseHeader(text).find((e) => e.name === 'page-topic-type') || {}).value
    return { label: `page: ${name}`, detail: `${type ? `${type} page` : 'Page'} skeleton from docs-team-standards ${STANDARDS_FILES.pageTemplates}/${f}`, source: path.join(dir, f), text, snippet: templateSnippet(text) }
  })
}

function tabsSnippet (root) {
  const file = path.join(root, STANDARDS_FILES.tabs)
  const text = firstFence(markdownSection(readIf(file) || '', SECTIONS.tabs), 'asciidoc')
  if (!text) return []
  // Each tab label and each content line is a tab stop.
  let n = 0
  const snippet = text.split('\n').map((line) => {
    const label = /^(.+)::$/.exec(line)
    if (label) return `\${${++n}:${escapeSnippet(label[1])}}::`
    if (!line.trim() || /^(\+|--|={4,}|\[tabs\])$/.test(line)) return escapeSnippet(line)
    return `\${${++n}:${escapeSnippet(line)}}`
  }).join('\n')
  return [{ label: 'tabs', detail: `Tabs from docs-team-standards ${STANDARDS_FILES.tabs}`, source: file, text, snippet }]
}

function admonitionSnippets (root) {
  const file = path.join(root, STANDARDS_FILES.styleGuide)
  const rows = markdownTable(markdownSection(readIf(file) || '', SECTIONS.admonitions))
  return rows.filter((r) => /^[A-Z]+$/.test(r[0])).flatMap(([type, when]) => [
    { label: type, detail: when, source: file, text: `${type}: `, snippet: `${type}: $0` },
    { label: `${type} block`, detail: when, source: file, text: `[${type}]\n====\n\n====`, snippet: `[${type}]\n====\n$0\n====` },
  ])
}

function sourceCommentSnippet (root) {
  const file = path.join(root, STANDARDS_FILES.freshSources)
  const example = firstFence(markdownSection(readIf(file) || '', SECTIONS.sourceComment), 'asciidoc')
  const line = example && example.split('\n').find((l) => /^\/\/ Source: /.test(l))
  if (!line) return []
  const m = /^(\/\/ Source: )(\S+)(?: "(.*)")?$/.exec(line)
  if (!m) return []
  const snippet = `${m[1]}\${1:${escapeSnippet(m[2])}}` + (m[3] !== undefined ? ` "\${2:${escapeSnippet(m[3])}}"` : '')
  return [{ label: '// Source:', detail: `Provenance comment, docs-team-standards ${STANDARDS_FILES.freshSources}`, source: file, text: line, snippet, filterText: '// Source: source' }]
}

/** prop: and propval: examples, each property name a mirrored tab stop. */
function propertySnippets () {
  const guide = readIf(PROPERTY_GUIDE)
  if (!guide) return []
  return ['prop', 'propval'].flatMap((macro) => {
    const text = firstListing(adocSection(guide, SECTIONS[macro]))
    if (!text) return []
    const stops = new Map()
    let n = 0
    const macros = scanMacros(text, ['prop', 'propval'])
    const out = text.split('\n').map((line, lineNo) => {
      let built = ''
      let last = 0
      for (const m of macros.filter((x) => x.line === lineNo)) {
        if (!stops.has(m.name)) stops.set(m.name, ++n)
        built += escapeSnippet(line.slice(last, m.nameRange.start.character)) + `\${${stops.get(m.name)}:${escapeSnippet(m.name)}}`
        last = m.nameRange.end.character
        if (m.macro === 'propval' && m.attrlist && line.startsWith(`[${m.attrlist}]`, last)) {
          built += '[' + `\${${++n}:${escapeSnippet(m.attrlist)}}`
          last += 1 + m.attrlist.length
        }
      }
      return built + escapeSnippet(line.slice(last))
    }).join('\n')
    return [{ label: macro === 'prop' ? 'prop: reference' : 'propval: sentence', detail: `Example from ${path.basename(PROPERTY_GUIDE)}`, source: PROPERTY_GUIDE, text, snippet: out, filterText: macro }]
  })
}

/** The solutions templates, when the workspace is inside redpanda-solutions. */
function solutionTemplates (wsRoot) {
  const dir = upToRepoRoot(wsRoot).map((d) => path.join(d, SOLUTION_TEMPLATE)).find((d) => fs.existsSync(path.join(d, 'pages', 'step.adoc')))
  if (!dir) return null
  const stepFile = path.join(dir, 'pages', 'step.adoc')
  const step = fs.readFileSync(stepFile, 'utf8')
  const layout = (parseHeader(step).find((e) => e.name === 'page-layout') || {}).value
  return {
    dir,
    layout,
    step: { label: 'page: solution step', detail: `Step skeleton from ${path.relative(path.dirname(path.dirname(path.dirname(dir))), stepFile)}`, source: stepFile, text: step, snippet: templateSnippet(step) },
    note: productionNoteTemplate(dir, step),
  }
}

// The [.production-note] block in the step template, and the values in it
// that each topic replaces: the topic id, its title, and the last step id.
function productionNoteTemplate (dir, step) {
  const lines = step.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === '[.production-note]')
  if (start < 0) return null
  const open = lines.findIndex((l, i) => i > start && /^-{2}$/.test(l))
  const close = lines.findIndex((l, i) => i > open && /^-{2}$/.test(l))
  if (open < 0 || close < 0) return null
  const text = lines.slice(start, close + 1).join('\n')
  const topic = (/partial\$production\/([^/[\]]+)\.adoc/.exec(text) || [])[1]
  const lastStep = (/xref:([^#[\]]+)\.adoc#/.exec(text) || [])[1]
  if (!topic || !lastStep) return null
  const titles = topicTitles(path.join(dir, 'partials', 'production'))
  return { text, topic, lastStep, title: titles.get(topic) && noteTitle(titles.get(topic)) }
}

/** Topic id -> title, from [#prod-<topic>] and the === heading under it in _all.adoc. */
function topicTitles (partialsDir) {
  const titles = new Map()
  const all = readIf(path.join(partialsDir, '_all.adoc'))
  if (!all) return titles
  const rx = /^\[#prod-([^\]]+)\]\s*\r?\n={3}\s+(.+?)\s*$/gm
  let m
  while ((m = rx.exec(all))) titles.set(m[1], m[2])
  return titles
}

/**
 * A topic title as it reads mid-sentence, the way the template writes it: the
 * first letter lowercased. A proper noun (Iceberg) cannot be told apart from
 * the files, so the title is a tab stop the writer confirms.
 */
function noteTitle (title) {
  return /^[A-Z][a-z]/.test(title) ? title[0].toLowerCase() + title.slice(1) : title
}

/**
 * One production-note snippet per topic in the page's module: the template's
 * block with its topic, title and last step replaced by this module's.
 */
function productionNotes (note, file) {
  if (!note || !file) return []
  const i = file.lastIndexOf(`${path.sep}pages${path.sep}`)
  if (i < 0) return []
  const moduleDir = file.slice(0, i)
  const partials = path.join(moduleDir, 'partials', 'production')
  if (!fs.existsSync(partials)) return []
  const titles = topicTitles(partials)
  const index = readIf(path.join(moduleDir, 'pages', 'index.adoc'))
  const steps = index ? ((parseHeader(index).find((e) => e.name === 'page-solution-steps') || {}).value || '').split(',').map((s) => s.trim()).filter(Boolean) : []
  const lastStep = steps[steps.length - 1] || path.basename(file, '.adoc')
  return fs.readdirSync(partials).filter((f) => f.endsWith('.adoc') && !f.startsWith('_')).sort().map((f) => {
    const topic = f.replace(/\.adoc$/, '')
    const title = titles.has(topic) ? noteTitle(titles.get(topic)) : topic.replace(/-/g, ' ')
    const text = fillNote(note, { topic, title, lastStep })
    const at = note.title ? text.indexOf(`: ${title}]`) : -1
    const snippet = at < 0
      ? escapeSnippet(text)
      : escapeSnippet(text.slice(0, at + 2)) + `\${1:${escapeSnippet(title)}}` + escapeSnippet(text.slice(at + 2 + title.length))
    return { label: `production note: ${topic}`, detail: `[.production-note] from ${path.basename(note.source || 'step.adoc')}, for partials/production/${f}`, text, snippet: snippet + '\n$0', filterText: `production note ${topic}` }
  })
}

function fillNote (note, { topic, title, lastStep }) {
  const swap = (s, from, to) => (from ? s.split(from).join(to) : s)
  let text = swap(note.text, `production/${note.topic}.adoc`, `production/${topic}.adoc`)
  text = swap(text, `#prod-${note.topic}[`, `#prod-${topic}[`)
  text = swap(text, `xref:${note.lastStep}.adoc#`, `xref:${lastStep}.adoc#`)
  if (note.title) text = swap(text, note.title, title)
  return text
}

/**
 * The inline test statements the repository's Doc Detective config declares
 * for AsciiDoc: v2 string statements (testStartStatementOpen and the rest),
 * or v3 inlineStatements patterns turned back into text.
 */
function docDetectiveInline (wsRoot) {
  const dirs = upToRepoRoot(wsRoot)
  const repo = dirs[dirs.length - 1]
  const files = findConfigs(fs.existsSync(path.join(repo, '.git')) ? repo : wsRoot)
  for (const file of files) {
    let config
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
    for (const type of config.fileTypes || []) {
      if (!type || !(type.extensions || []).some((e) => /^\.?adoc$/.test(e))) continue
      const statements = inlineStatements(type)
      if (statements) return { file, ...statements }
    }
  }
  return null
}

function findConfigs (root, depth = 3) {
  const out = []
  const walk = (dir, d) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isFile() && e.name === DOC_DETECTIVE_CONFIG) out.push(path.join(dir, e.name))
      else if (e.isDirectory() && d > 0 && e.name !== 'node_modules' && !e.name.startsWith('.')) walk(path.join(dir, e.name), d - 1)
    }
  }
  walk(root, depth)
  return out.sort()
}

// A v3 pattern such as '// \\(test start(.*?)\\)' as [before, after] the one
// capture group, or null when it is not literal text around one group.
function patternParts (pattern) {
  const m = /^(.*?)\((?:\.\*\??|\.\+\??)\)(.*)$/.exec(String(pattern))
  const literal = (s) => (/(^|[^\\])[.*+?^$()[\]{}|]/.test(s) ? null : s.replace(/\\(.)/g, '$1'))
  if (!m) { const whole = literal(pattern); return whole === null ? null : [whole, ''] }
  const before = literal(m[1])
  const after = literal(m[2])
  return before === null || after === null ? null : [before, after]
}

function inlineStatements (type) {
  if (typeof type.testStartStatementOpen === 'string' && typeof type.stepStatementOpen === 'string' && typeof type.testEndStatement === 'string') {
    return { version: 2, start: [type.testStartStatementOpen, type.testStartStatementClose || ''], step: [type.stepStatementOpen, type.stepStatementClose || ''], end: type.testEndStatement }
  }
  const s = type.inlineStatements
  if (!s) return null
  const start = (s.testStart || []).map(patternParts).find(Boolean)
  const step = (s.step || []).map(patternParts).find(Boolean)
  const end = (s.testEnd || []).map(patternParts).find(Boolean)
  return start && step && end ? { version: 3, start, step, end: end[0] } : null
}

function docDetectiveSnippet (dd) {
  if (!dd) return []
  const idKey = dd.version === 2 ? 'id' : 'testId'
  const lines = [
    [`${escapeSnippet(dd.start[0])} {"${idKey}": "\${1:test-id}", "description": "\${2:What this test proves}"}`, dd.start[1]],
    [`${escapeSnippet(dd.step[0])} \${3:{\\}}`, dd.step[1]],
  ]
  const snippet = lines.map(([body, close]) => body + escapeSnippet(close)).join('\n') + `\n$0\n${escapeSnippet(dd.end)}`
  return [{ label: 'Doc Detective inline test', detail: `Inline test statements from ${dd.file}`, source: dd.file, text: renderSnippet(snippet), snippet, filterText: 'doc detective test' }]
}

// ---------------------------------------------------------------- load

async function load (ws, ctx = {}) {
  const standards = standardsRoot(ctx.settings || {})
  const data = { standardsSource: standards.source || null, page: [], body: [], solution: null }
  if (standards.root) {
    data.page.push(...pageTemplates(standards.root))
    data.body.push(...admonitionSnippets(standards.root), ...tabsSnippet(standards.root), ...sourceCommentSnippet(standards.root))
  } else {
    ws.notes.push(`snippets from docs-team-standards are off: ${standards.problem}`)
  }
  data.body.push(...propertySnippets())
  data.solution = solutionTemplates(ws.root)
  if (data.solution && data.solution.note) data.solution.note.source = data.solution.step.source
  data.body.push(...docDetectiveSnippet(docDetectiveInline(ws.root)))
  return data
}

// ---------------------------------------------------------------- completion

/**
 * Where the cursor is: 'page' (no title yet), 'header', 'body', or null when
 * no snippet belongs (mid-line, or inside a comment or delimited block).
 */
function contextAt (text, position) {
  const lines = String(text).split(/\r?\n/)
  const line = lines[position.line] || ''
  const before = line.slice(0, position.character)
  if (!/^\s*(\/\/ ?)?[\w.-]*$/.test(before) || line.slice(position.character).trim()) return null
  // Decide by the lines around the cursor, not by what is being typed.
  const others = lines.slice()
  others[position.line] = ''
  if (inertLines(others).has(position.line)) return null
  const inert = inertLines(others)
  const title = others.findIndex((l, i) => !inert.has(i) && /^=\s+\S/.test(l))
  if (title < 0) return { kind: 'page', prefix: before.trimStart() }
  if (position.line < title) return null
  // The header runs from the title to the first blank line. The cursor line
  // is in it when no blank line comes before it and it is, or sits right
  // above, an attribute entry.
  const attribute = (l) => /^:[\w-]+!?:/.test(l || '')
  const contiguous = others.slice(title + 1, position.line).every((l) => l.trim())
  const header = position.line === title || (contiguous && (attribute(line) || attribute(lines[position.line + 1])))
  return { kind: header ? 'header' : 'body', prefix: before.trimStart(), lines: others }
}

function completion (doc, position, ws) {
  const data = ws.data && ws.data.snippets
  if (!data) return []
  const where = contextAt(doc.text, position)
  if (!where || where.kind === 'header') return []
  const file = String(doc.uri).startsWith('file:') ? fileURLToPath(doc.uri) : null
  const solution = data.solution
  let snippets
  if (where.kind === 'page') {
    snippets = solution ? (file && path.basename(file) === 'index.adoc' ? [] : [solution.step]) : data.page
  } else {
    snippets = data.body.slice()
    const layout = (parseHeader(where.lines.join('\n')).find((e) => e.name === 'page-layout') || {}).value
    if (solution && solution.layout && layout === solution.layout) snippets.push(...productionNotes(solution.note, file))
  }
  const comment = where.prefix.startsWith('//')
  const editRange = range(position.line, position.character - where.prefix.length, position.character)
  return snippets.filter((s) => !comment || s.snippet.startsWith('//')).map((s) => ({
    label: s.label,
    kind: COMPLETION_KIND.snippet,
    detail: s.detail,
    documentation: { kind: 'markdown', value: '```asciidoc\n' + s.text + '\n```' },
    insertTextFormat: 2,
    textEdit: { range: editRange, newText: s.snippet },
    filterText: s.filterText || s.label,
    sortText: `~${s.label}`,
  }))
}

module.exports = {
  id: 'snippets',
  watch: [/-template\.adoc$/, /templates\/solution\/.+\.adoc$/, /\.doc-detective\.json$/],
  load,
  completion,
  // Exported for tests.
  renderSnippet,
  templateSnippet,
  contextAt,
  markdownSection,
  STANDARDS_FILES,
  VENDORED_STANDARDS,
}
