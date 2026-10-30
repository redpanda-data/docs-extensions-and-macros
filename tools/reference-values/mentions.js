'use strict'

/* Unlinked mentions in check-reference-values: things prose names in inline
 * code with no link, where a link macro would link them.
 *
 *   rpk-command        `rpk topic create`, with or without flags, for a
 *                      command with a reference page (rpkcmd:). A span with
 *                      an argument is an example to run, not a mention.
 *   connect-component  `kafka_franz` input, or kafka_franz input, the name
 *                      followed by its type (connect:).
 *   bloblang-function  `now()`, or `now` function (blobl:).
 *   bloblang-method    `.uppercase()`, or `uppercase` method (blobl:).
 *
 * The docs link a term on its first mention in a document (the style guide's
 * rule for glossary terms), so only the first mention of a target in a file
 * is reported, and none when the file links that target anywhere, by xref or
 * by the macro. A mention is never read in a block, a heading, a block title,
 * a description list term, a table header row, a link label or a macro, and
 * never in nav files, release, upgrade or migration notes, generated pages,
 * or the target's own page. Bloblang calls are read only in Connect
 * content: elsewhere `max()` is SQL or PromQL.
 *
 * An unlinked mention never fails the check unless --fail-on links asks for
 * it, and --write converts one only with --write-links, because a link
 * changes the page. The conversion keeps the mention's text exactly as
 * written: rpkcmd:[...] when the span is the command and at most one flag,
 * connect:[...] and blobl:[...] with the written text as the label when it
 * is not what the macro renders by default.
 */

const rpkValues = require('../../extension-utils/rpk-values')
const rpkLinks = require('../../extension-utils/rpk-links')
const connectLinks = require('../../extension-utils/connect-links')
const connectValues = require('../../extension-utils/connect-values')
const bloblang = require('../../extension-utils/bloblang-values')
const { normalizeType } = require('../../extensions/util/connect-catalog')
const shared = require('./shared')

const STATUS = 'unlinked-mention'
const KINDS = ['rpk-command', 'connect-component', 'bloblang-function', 'bloblang-method']

const TYPE_WORDS = 'input|output|processor|cache|buffer|rate limit|tracer|scanner|metrics(?: exporter)?'
const TYPE_AFTER_RX = new RegExp(`^\\s+(${TYPE_WORDS})\\b`, 'i')
// A name with an underscore, outside code, then its type: kafka_franz input.
const PLAIN_COMPONENT_RX = new RegExp(`(?<![\\w\`./:#-])([a-z0-9]+(?:_[a-z0-9]+)+)\\s+(${TYPE_WORDS})\\b`, 'g')
// An xref, or an xref stored in an attribute entry
// (:processors-mapping-url: xref:components:processors/mapping.adoc).
const XREF_TARGET_RX = /xref:([^\s[\]]+)(?:\[|\s*$)/gm
// Links and macros, whose text is a label or an argument, never a mention:
// xref:, link:, URLs, every inline macro, a URL in an attribute
// ({processors-mapping-url}[label]), and <<anchor,label>>.
const MACRO_RX = /\b[a-z][\w-]*:{1,2}[^\s[\]]*\[(?:\\\]|[^\]])*\]|\{[\w-]+\}\[(?:\\\]|[^\]])*\]|<<[^>]*>>/gi
const DLIST_TERM_RX = /^\s*\S.*?(?::{2,4}|;;)(?:\s|$)/
const TABLE_DELIMITER_RX = /^[|!,:]={3,}\s*$/

const cmd = (names) => ['rpk', ...names].join(' ')

/**
 * The character ranges of a line that hold links and macros.
 */
function linkRanges (line) {
  return [...String(line).matchAll(MACRO_RX)].map((m) => [m.index, m.index + m[0].length])
}

const inside = (ranges, start, end) => ranges.some(([a, b]) => start < b && end > a)

/**
 * The line indexes of a file that never hold a mention: table header rows
 * (an explicit header option, or the implicit header, a first row on one
 * line followed by a blank line) and description list terms.
 */
function skippedLines (lines) {
  const out = new Set()
  let open = false
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (TABLE_DELIMITER_RX.test(t)) {
      open = !open
      if (!open) continue
      const attrs = i > 0 ? lines[i - 1].trim() : ''
      let first = i + 1
      while (first < lines.length && !lines[first].trim()) first++
      if (first >= lines.length || TABLE_DELIMITER_RX.test(lines[first].trim())) continue
      const explicit = /^\[.*(?:%header|options="?[^"\]]*header)/.test(attrs)
      const implicit = !/^\[.*%noheader/.test(attrs) && first === i + 1 && (lines[first].match(/(?:^|\s)\|/g) || []).length > 1 && first + 1 < lines.length && !lines[first + 1].trim()
      if (explicit || implicit) out.add(first)
      continue
    }
    if (!open && DLIST_TERM_RX.test(lines[i]) && !/^\s*(?:\/\/|[*.-]+\s|\|)/.test(lines[i])) out.add(i)
  }
  return out
}

// ---------------------------------------------------------------------------
// The targets a file already links

/**
 * The rpk commands a file links: xrefs to command pages, as the scanned
 * component resolves them (page aliases included), and rpkcmd:[...].
 *
 * @returns {Set<string>} canonical command paths below rpk.
 */
function rpkLinked (text, { tree, deprecated, catalog, component, version, module, aliases }) {
  const { xrefPage } = require('./rpk')
  const out = new Set()
  for (const m of String(text).matchAll(XREF_TARGET_RX)) {
    const page = xrefPage(m[1], { component, version, module, catalog })
    if (!page || page.module !== rpkLinks.PAGE_MODULE || !page.relative.startsWith('rpk/')) continue
    const relative = (aliases && aliases.get(`${page.component}@${page.version}:${page.relative}`)) || page.relative
    const command = rpkLinks.commandOfPage(tree, relative)
    if (command) out.add(command.names.join(' '))
  }
  for (const m of String(text).matchAll(/\brpkcmd:\[([^\],]*)/g)) {
    const resolved = rpkValues.resolveCommand(tree, rpkValues.parseCommandLine(m[1]).tokens, deprecated)
    if (resolved.ok) out.add(resolved.names.join(' '))
  }
  return out
}

const componentKey = (dir, name) => `${dir}/${name}`
const bloblKey = (kind, name) => `${kind}:${name}`

/**
 * The Connect components and Bloblang functions and methods a file links:
 * xrefs to their pages and anchors (a Cloud stub's path too), and connect:
 * and blobl:.
 *
 * @returns {{components: Set<string>, bloblang: Set<string>}}
 */
function connectLinked (text, { data, types }) {
  const components = new Set()
  const calls = new Set()
  for (const m of String(text).matchAll(XREF_TARGET_RX)) {
    const [resource, fragment] = m[1].split('#')
    const page = resource.match(/(?:^|[:/])([a-z_]+)\/([\w-]+)\.adoc$/)
    if (page && types[page[1]]) components.add(componentKey(page[1], page[2]))
    const blobl = resource.match(/(?:^|[:/])bloblang\/(functions|methods)\.adoc$/)
    if (blobl && fragment) calls.add(bloblKey(blobl[1] === 'functions' ? bloblang.FUNCTION : bloblang.METHOD, fragment.replace(/-\d+$/, '')))
  }
  for (const m of String(text).matchAll(/(?<![\w:])connect:\[([a-z_-]+)\/([\w-]+)/g)) {
    // The type as connect: takes it: plural, singular or hyphenated.
    const key = Object.values(types).find((k) => normalizeType(k) === normalizeType(m[1]))
    if (key) components.add(componentKey(connectLinks.typeDir(key), m[2]))
  }
  for (const m of String(text).matchAll(/(?<![\w:])blobl:\[([^\],]*)/g)) {
    const parsed = bloblang.parseCall(m[1])
    const resolved = parsed.ok && bloblang.resolveCall(data, parsed)
    if (resolved && resolved.ok) calls.add(bloblKey(resolved.kind, resolved.entry.name))
  }
  return { components, bloblang: calls }
}

// ---------------------------------------------------------------------------
// Mentions on one line

/**
 * The rpk commands a prose line names in inline code, with the page each
 * would link from the scanned component.
 */
function rpkMentions (line, { registry, catalog, component, version }) {
  const { shellTokens, parseInvocation } = require('./rpk')
  const tree = registry.data.tree
  const ranges = linkRanges(line)
  const out = []
  for (const span of shared.backtickSpans(line)) {
    if (!/^rpk\s/.test(span.text) || inside(ranges, span.start, span.end)) continue
    const tokens = shellTokens(span.text)
    if (tokens.some((t) => t.type === 'op')) continue
    const parsed = parseInvocation(tree, tokens.slice(1), registry.data.deprecated_commands, { isScrapedPath: (names) => rpkValues.isScraped(registry, names) })
    if (parsed.problem || !parsed.names.length) continue
    // A span with an argument (`rpk topic produce dev-topic`) is an example
    // to run, not a mention of the command.
    const words = tokens.slice(1).filter((t) => t.type === 'word').length
    const separateValues = parsed.flags.filter((f) => f.hasValue && !f.token.value.includes('=') && !(f.short && f.token.value.length > 2)).length
    if (words > parsed.names.length + parsed.flags.length + separateValues) continue
    const relative = rpkLinks.commandPagePath(tree, parsed.names)
    const page = rpkLinks.pickCommandPage(catalog, { component, version, relative })
    if (!page.ok) continue
    // rpkcmd:[...] renders the command line as typed, with at most one flag
    // and no value.
    const typed = rpkValues.parseCommandLine(span.text)
    const display = [cmd(typed.tokens), ...(typed.flag ? [typed.flag] : [])].join(' ')
    const exact = !typed.extra.length && display === span.text.trim().replace(/\s+/g, ' ') && rpkLinks.resolveRpkCommand({ registry, text: span.text }).ok
    out.push({
      mention: 'rpk-command',
      key: parsed.names.join(' '),
      target: cmd(parsed.names),
      start: span.start,
      end: span.end,
      written: line.slice(span.start, span.end),
      page: page.id,
      proposed: exact ? `rpkcmd:[${span.text.trim()}]` : undefined,
      note: exact ? undefined : 'the span has a flag value, which rpkcmd: does not render; link the command page by hand',
    })
  }
  return out
}

/**
 * Whether the Connect or Bloblang page links from at least one surface that
 * renders the line, and whether it does from every one.
 */
function connectPicks (catalog, surfaces, { module, relative, entry, kind }) {
  const picks = surfaces.map((s) => {
    if (kind && s.cloud && bloblang.cloudHiddenEntry(kind, entry)) return { ok: false }
    return connectLinks.pickConnectPage(catalog, { component: s.component, version: s.version, module, relative, cloud: s.cloud })
  })
  return { some: picks.some((p) => p.ok), all: picks.every((p) => p.ok), id: (picks.find((p) => p.ok) || {}).id }
}

/**
 * The Connect components named with their type, and (in Connect content)
 * the Bloblang calls, on a prose line.
 */
function connectMentions (line, { data, types, catalog, surfaces, bloblangToo }) {
  const ranges = linkRanges(line)
  const spans = shared.backtickSpans(line)
  const out = []
  const component = (name, word, start, end, written) => {
    const type = normalizeType(word.toLowerCase().replace(/ exporter$/, '').replace(/ /g, '_'))
    const key = Object.values(types).find((k) => normalizeType(k) === type)
    const entry = key && (data[key] || []).find((c) => c && c.name === name)
    if (!entry) return
    const dir = connectLinks.typeDir(key)
    const picks = connectPicks(catalog, surfaces, { module: connectLinks.COMPONENTS_MODULE, relative: connectLinks.componentPagePath(key, name) })
    if (!picks.some) return
    const shown = `\`${name}\` ${connectLinks.typeWords(normalizeType(key))}`
    out.push({
      mention: 'connect-component',
      key: componentKey(dir, name),
      target: `${dir}/${name}`,
      start,
      end,
      written,
      page: picks.id,
      proposed: written === shown ? `connect:[${dir}/${name}]` : `connect:[${dir}/${name},${written}]`,
      note: picks.all ? undefined : 'a surface that renders this line has no page for it, so connect: renders plain code there',
    })
  }
  for (const span of spans) {
    if (inside(ranges, span.start, span.end)) continue
    const rest = line.slice(span.end)
    const typeWord = rest.match(TYPE_AFTER_RX)
    if (typeWord && /^[a-z0-9_]+$/.test(span.text)) {
      component(span.text, typeWord[1], span.start, span.end + typeWord[0].length, line.slice(span.start, span.end + typeWord[0].length))
      continue
    }
    if (!bloblangToo) continue
    const call = span.text.match(/^(\.?)([a-z_][a-z0-9_]*)\(\)$/)
    const word = !call && /^[a-z_][a-z0-9_]*$/.test(span.text) ? rest.match(/^\s+(method|function)\b/) : null
    if (!call && !word) continue
    const parsed = call ? bloblang.parseCall(span.text) : { ok: true, kind: word[1] === 'method' ? bloblang.METHOD : bloblang.FUNCTION, name: span.text }
    const resolved = bloblang.resolveCall(data, parsed)
    if (!resolved.ok) continue
    const { kind, entry } = resolved
    const end = call ? span.end : span.end + word[0].length
    const written = line.slice(span.start, end)
    const picks = connectPicks(catalog, surfaces, { module: connectLinks.GUIDES_MODULE, relative: connectLinks.BLOBLANG_PAGES[kind], entry, kind })
    if (!picks.some) continue
    const text = bloblang.callText(kind, entry.name)
    out.push({
      mention: `bloblang-${kind}`,
      key: bloblKey(kind, entry.name),
      target: text,
      start: span.start,
      end,
      written,
      page: picks.id,
      proposed: written === `\`${text}\`` ? `blobl:[${text}]` : `blobl:[${text},${written}]`,
      note: picks.all ? undefined : 'a surface that renders this line has no page for it, so blobl: renders plain code there',
    })
  }
  for (const m of line.matchAll(PLAIN_COMPONENT_RX)) {
    const start = m.index
    const end = m.index + m[0].length
    if (inside(ranges, start, end) || spans.some((sp) => start < sp.end && end > sp.start)) continue
    component(m[1], m[2], start, end, m[0])
  }
  return out.sort((a, b) => a.start - b.start)
}

// ---------------------------------------------------------------------------
// One file

/**
 * The first-mention rule for one file: a mention is reported when it is the
 * file's first of its target and the file links that target nowhere.
 *
 * @param {Set<string>} linked
 * @returns {(mention: object) => boolean}
 */
function firstMentions (linked) {
  const seen = new Set()
  return (mention) => {
    if (linked.has(mention.key) || seen.has(mention.key)) return false
    seen.add(mention.key)
    return true
  }
}

/**
 * A mention as a finding.
 */
function toFinding (mention, { kind, relative, index, line, historical }) {
  const finding = {
    file: relative,
    line: index + 1,
    text: line.trim(),
    kind,
    check: 'mention',
    status: STATUS,
    reason: STATUS,
    mention: mention.mention,
    target: mention.target,
    written: mention.written,
    dataValue: mention.page,
    association: 'mention',
    autoSafe: false,
    linkable: Boolean(mention.proposed) && !historical,
    start: mention.start,
    end: mention.end,
  }
  if (mention.proposed) finding.proposed = mention.proposed
  if (mention.note) finding.note = mention.note
  return finding
}

/**
 * Counts of the unlinked mentions, in total and by kind.
 */
function mentionCounts (findings) {
  const mentions = findings.filter((f) => f.status === STATUS)
  const byKind = {}
  for (const k of KINDS) {
    const n = mentions.filter((f) => f.mention === k).length
    if (n) byKind[k] = n
  }
  return { unlinkedMentions: mentions.length, unlinkedMentionsByKind: byKind }
}

module.exports = {
  STATUS,
  KINDS,
  linkRanges,
  skippedLines,
  rpkLinked,
  connectLinked,
  rpkMentions,
  connectMentions,
  firstMentions,
  toFinding,
  mentionCounts,
}
