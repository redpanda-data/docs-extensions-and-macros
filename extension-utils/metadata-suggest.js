'use strict'

/**
 * Taxonomy suggestions for a page: which topics, use cases, technologies, and
 * industries its text names that its header does not carry yet. This is what
 * `doc-tools check-metadata --suggest` runs, so authors and agents choose
 * values from the taxonomy instead of inventing them.
 *
 * It is deterministic and uses no model. Every live concept's prefLabel and
 * altLabels are matched against the page's title, `:description:`, section
 * headings, and body (code blocks included):
 *
 *   - Matching is on whole words, case-insensitive, after splitting on
 *     anything that is not a letter or digit, so a code literal such as
 *     `postgres_cdc` contains the words "postgres" and "cdc" and matches
 *     PostgreSQL (altLabel Postgres) and Change data capture (altLabel CDC).
 *   - A trailing plural "s" is folded on both sides, so "connector" matches
 *     Connectors.
 *   - At one position the longest label wins: "Kafka Connect" is Kafka
 *     Connect, not Apache Kafka.
 *   - A label of one or two letters (Go) is too ambiguous for prose. It matches
 *     only with its exact case and never as the first word of a sentence, so
 *     "Go to Settings" is not the Go language. A source block's language
 *     (`[source,go]`) always counts.
 *   - The label of a deprecated concept is evidence for its live replacement
 *     ("Data Replication" for Replication), at half weight.
 *
 * Hits are weighted by where they are, title > description > heading > body,
 * and a page's score for a concept is the sum (see WEIGHTS). Body mentions are
 * damped, so a long reference page that names rpk 40 times does not outrank a
 * short page about rpk.
 *
 * Suggestions respect the taxonomy:
 *   - deprecated concepts are never suggested;
 *   - a facet never goes past its cardinality for the page kind (taxonomy.yml
 *     `cardinality`), counting the values the page already has;
 *   - a concept the page already carries, or one implied by a value it carries
 *     or by a stronger suggestion in the same attribute (a broader topic, or
 *     an `implies` target such as Apache Iceberg under Iceberg Topics), is not
 *     suggested separately; it is listed under `implies` of the suggestion
 *     that implies it.
 */

const { splitValues, isSolutionPage, CATEGORY_ATTRIBUTE, SOLUTION_FACETS } = require('./metadata-check')

// Schemes that suggestions are made for. Task and deployment are derived from
// the module and the env-* attributes, and content type is
// :page-topic-type:, so none of them is matched against text.
const SUGGEST_SCHEMES = Object.freeze(['topic', 'use-case', 'technology', 'industry'])

// Where a suggestion for each scheme is written. A Product Docs page has only
// page-categories; a solution overview has an attribute per facet.
const DOCS_ATTRIBUTE = Object.freeze({ topic: CATEGORY_ATTRIBUTE, 'use-case': CATEGORY_ATTRIBUTE, technology: CATEGORY_ATTRIBUTE, industry: CATEGORY_ATTRIBUTE })
const SOLUTION_ATTRIBUTE = Object.freeze({
  topic: CATEGORY_ATTRIBUTE,
  'use-case': 'page-solution-use-cases',
  technology: 'page-solution-technologies',
  industry: 'page-solution-industries',
})

// Score of one concept on one page, the sum over where it is named:
//   title, description, path   WEIGHTS[location] once, however often
//   heading                    WEIGHTS.heading per heading, up to maxHeadings
//   body                       WEIGHTS.body * (1 + log2(mentions)), at most bodyCap
// `path` is the page's directories and file name under pages/, which the docs
// team curates (security/tls/, iceberg/). The body cap keeps a concept the
// body only mentions in passing below the default minimum score: it needs to
// be named somewhere a reader would see as the page's subject too.
const LOCATIONS = Object.freeze(['title', 'description', 'path', 'heading', 'body'])
const WEIGHTS = Object.freeze({ title: 8, description: 5, path: 6, heading: 1.5, maxHeadings: 3, body: 1, bodyCap: 3 })
const DEPRECATED_LABEL_FACTOR = 0.5

// Defaults per page kind, chosen by hiding the categories of tagged pages in
// docs main and the facets of the redpanda-solutions overviews, and comparing
// the suggestions with what authors had chosen. A solution overview is short
// and names each technology it uses in its body, often once, so it needs a
// lower bar and room for more technologies than a Product Docs page.
const DEFAULT_MIN_SCORE = Object.freeze({ docs: 5, solution: 3 })
const DEFAULT_LIMIT = Object.freeze({ docs: 3, solution: 6 })

// Used when a scheme in taxonomy.yml has no cardinality for the page kind.
const DEFAULT_CARDINALITY = Object.freeze({
  docs: { topic: '0-3', 'use-case': '0-3', technology: '0-n', industry: '0-2' },
  solutions: { topic: '0-3', 'use-case': '1-3', technology: '1-n', industry: '0-2' },
})

/** "0-3" -> { min: 0, max: 3 }; "1-n" -> { min: 1, max: Infinity }. */
function parseCardinality (value) {
  const m = /^(\d+)\s*-\s*(\d+|n)$/.exec(String(value || '').trim())
  if (!m) return { min: 0, max: Infinity }
  return { min: Number(m[1]), max: m[2] === 'n' ? Infinity : Number(m[2]) }
}

function cardinalityOf (taxonomy, scheme, kind) {
  const entry = taxonomy.schemes.get(scheme)
  const key = kind === 'solution' ? 'solutions' : 'docs'
  const raw = entry && entry.cardinality && entry.cardinality[key]
  return parseCardinality(raw || DEFAULT_CARDINALITY[key][scheme])
}

/** Fold a lowercased word: drop a plural "s" (not "ss") from words over 3 letters. */
function foldWord (word) {
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

const WORD_RE = /[\p{L}\p{N}]+/gu

/**
 * Split text into words with their offsets.
 * @returns {Array<{raw: string, key: string, index: number, sentenceStart: boolean}>}
 */
function words (text) {
  const out = []
  let last = 0
  for (const m of String(text).matchAll(WORD_RE)) {
    // The first word of the text (after list or table markup), the first
    // word after a sentence-ending mark, or the first word of a table cell.
    const sentenceStart = out.length === 0
      ? /^[\s*.#|=>-]*$/.test(text.slice(0, m.index))
      : /(?:[.!?:]\s+|\|\s*)$/.test(text.slice(last, m.index))
    out.push({ raw: m[0], key: foldWord(m[0].normalize('NFKC').toLowerCase()), index: m.index, sentenceStart })
    last = m.index + m[0].length
  }
  return out
}

/**
 * Build the label matcher for a taxonomy: every label of every concept in a
 * suggestable scheme, live labels pointing at their concept and deprecated
 * labels at their live replacements in suggestable schemes.
 *
 * @param {import('./taxonomy').Taxonomy} taxonomy
 * @param {Object} [options]
 * @param {boolean} [options.allLabels] - every label of every concept, in
 *   every scheme and deprecated or not, each pointing at its own concept: what
 *   candidates use to tell whether any concept already covers a term
 */
function buildMatcher (taxonomy, { allLabels = false } = {}) {
  const byFirst = new Map() // first word key -> [{ words, label, ids, via, exact }]
  const add = (label, ids, via) => {
    const ws = words(label)
    if (!ws.length || !ids.length) return
    const exact = label.replace(/[^\p{L}\p{N}]/gu, '').length <= 2
    const entry = { words: ws.map((w) => w.key), raw: ws.map((w) => w.raw), label, ids, via, exact }
    const first = entry.words[0]
    if (!byFirst.has(first)) byFirst.set(first, [])
    byFirst.get(first).push(entry)
  }
  for (const concept of taxonomy.concepts.values()) {
    if (allLabels) {
      ;[concept.prefLabel, ...concept.altLabels, concept.id.replace(/-/g, ' ')].forEach((label) => add(label, [concept.id], 'label'))
      continue
    }
    if (!SUGGEST_SCHEMES.includes(concept.scheme)) continue
    const labels = [concept.prefLabel, ...concept.altLabels]
    if (!concept.deprecated) {
      labels.forEach((label, i) => add(label, [concept.id], i === 0 ? 'prefLabel' : 'altLabel'))
      // The ID too, for code literals such as `redpanda-connect`, unless it
      // is a short ID that only an exact-case label may match (go).
      const idLabel = concept.id.replace(/-/g, ' ')
      if (idLabel.replace(/[^\p{L}\p{N}]/gu, '').length > 2) add(idLabel, [concept.id], 'id')
    } else {
      const ids = concept.replacedBy.filter((id) => {
        const c = taxonomy.get(id)
        return c && !c.deprecated && SUGGEST_SCHEMES.includes(c.scheme)
      })
      for (const label of labels) add(label, ids, 'deprecated-label')
    }
  }
  // Longest label first, so the first candidate that fits is the longest.
  for (const list of byFirst.values()) list.sort((a, b) => b.words.length - a.words.length)
  return { byFirst, taxonomy }
}

/**
 * Find label matches in one piece of text.
 * @returns {Array<{ids: string[], term: string, label: string, via: string}>}
 */
function matchText (matcher, text) {
  const ws = words(text)
  const hits = []
  for (let i = 0; i < ws.length; i++) {
    const candidates = matcher.byFirst.get(ws[i].key)
    if (!candidates) continue
    let hit = null
    for (const c of candidates) {
      if (i + c.words.length > ws.length) continue
      let ok = true
      for (let j = 0; j < c.words.length; j++) {
        if (ws[i + j].key !== c.words[j]) { ok = false; break }
        if (c.exact && ws[i + j].raw !== c.raw[j]) { ok = false; break }
      }
      if (ok && c.exact && ws[i].sentenceStart) ok = false
      if (ok) { hit = c; break }
    }
    if (!hit) continue
    const end = ws[i + hit.words.length - 1]
    hits.push({ ids: hit.ids, term: text.slice(ws[i].index, end.index + end.raw.length), label: hit.label, via: hit.via })
    i += hit.words.length - 1
  }
  return hits
}

const MACRO_TARGET_RE = /\b(?:xref|link|mailto|image|video|audio|kbd|btn|menu|footnote|indexterm2?|pass):[^\s[\]]*\[([^\]]*)\]/g
const URL_RE = /\b(?:https?|ftp):\/\/[^\s[\]<>]+(?:\[([^\]]*)\])?/g
const XREF_SHORT_RE = /<<[^,>]+,?([^>]*)>>/g
const ATTR_REF_RE = /\{[A-Za-z0-9_-]+\}/g

/** Prose of one line with link targets, URLs, and attribute references removed. */
function proseOf (line) {
  return line
    .replace(MACRO_TARGET_RE, (_, text) => ` ${text} `)
    .replace(URL_RE, (_, text) => ` ${text || ''} `)
    .replace(XREF_SHORT_RE, (_, text) => ` ${text} `)
    .replace(ATTR_REF_RE, ' ')
}

const INCLUDE_RE = /^include::([^[]+)\[(.*)\]\s*$/
const MAX_INCLUDE_DEPTH = 3

/** The tags an include selects (tag=x or tags=x;y), or null for the whole file. */
function includeTags (attrlist) {
  const m = /(?:^|,)\s*tags?=([^,]*)/.exec(attrlist || '')
  if (!m) return null
  const tags = m[1].split(';').map((t) => t.trim()).filter((t) => t && !t.startsWith('!') && t !== '*' && t !== '**')
  return tags.length ? new Set(tags) : null
}

/** Lines of an included file, limited to the selected tags. Keeps line numbers. */
function taggedLines (content, tags) {
  const lines = String(content).split(/\r?\n/)
  if (!tags) return lines.map((text, i) => ({ text, line: i + 1 }))
  const out = []
  const open = new Set()
  lines.forEach((text, i) => {
    const t = /(?:tag|end)::([^[\s]+)\[\]/.exec(text)
    if (t && /tag::/.test(text) && !/end::/.test(text)) { if (tags.has(t[1])) open.add(t[1]); return }
    if (t && /end::/.test(text)) { open.delete(t[1]); return }
    if (open.size) out.push({ text, line: i + 1 })
  })
  return out
}

/**
 * Split an AsciiDoc page into the parts suggestions weigh.
 *
 * @param {string} content
 * @param {Function} parseHeader - tools/check-metadata parseHeader
 * @param {Object} [options]
 * @param {string} [options.file] - the page's path; its directories and name
 *   under pages/ are weighed as the `path` location
 * @param {(target: string, from: string|null) => {content: string, file: string}|null} [options.readInclude]
 *   resolves an include:: target (partials only) so single-sourced pages are
 *   read with the text they publish
 * @returns {{title, description, path, headings: Array<{text, line, source?}>, body: Array<{text, raw, line, source?, code?, sourceLanguage?}>, attributes: Object, lineOf: Object}}
 *   a body line has its prose (`text`), its source (`raw`), and `code: true`
 *   inside a listing or literal block
 */
function pageParts (content, parseHeader, { file, readInclude } = {}) {
  const entries = parseHeader(content)
  const attributes = {}
  const lineOf = {}
  for (const e of entries) {
    attributes[e.name] = attributes[e.name] ? `${attributes[e.name]}, ${e.value}` : e.value
    if (!lineOf[e.name]) lineOf[e.name] = e.line
  }
  const headerEnd = entries.length ? Math.max(...entries.map((e) => e.line)) : 0
  let title = null
  const headings = []
  const body = []

  const walk = (lines, source, depth, isPage) => {
    let inComment = false
    let inListing = false
    for (const { text: line, line: n } of lines) {
      const at = source ? { line: n, source } : { line: n }
      if (/^\/{4,}\s*$/.test(line)) { inComment = !inComment; continue }
      if (inComment || (!inListing && /^\/\//.test(line))) continue
      // Listing and literal blocks: code, matched like prose (code literals
      // count) but never read as headings.
      if (/^(?:-{4,}|\.{4,})\s*$/.test(line) || /^```/.test(line)) { inListing = !inListing; continue }
      if (inListing && !INCLUDE_RE.test(line)) {
        if (line.trim()) body.push({ text: proseOf(line), raw: line, code: true, ...at })
        continue
      }
      const h = /^(=+)\s+(\S.*)$/.exec(line)
      if (h) {
        if (isPage && h[1].length === 1 && !title) title = { text: proseOf(h[2]), ...at }
        else if (h[1].length > 1) headings.push({ text: proseOf(h[2]), ...at })
        continue
      }
      if (/^:[A-Za-z0-9_-]+!?:/.test(line)) continue // attribute entries set values, they are not prose
      const inc = INCLUDE_RE.exec(line)
      if (inc) {
        if (readInclude && depth < MAX_INCLUDE_DEPTH && !inc[1].includes('{')) {
          const r = readInclude(inc[1].trim(), source || file || null)
          if (r) walk(taggedLines(r.content, includeTags(inc[2])), r.file, depth + 1, false)
        }
        continue
      }
      if (/^(?:ifdef|ifndef|ifeval|endif|image|video|toc)::/.test(line)) continue
      const src = /^\[(?:source)?,\s*([A-Za-z0-9_+#-]+)/.exec(line)
      if (src) { body.push({ text: '', ...at, sourceLanguage: src[1] }); continue }
      if (/^\[.*\]\s*$/.test(line)) continue // other block attribute lines
      if (!line.trim()) continue
      body.push({ text: proseOf(line), raw: line, ...at })
    }
  }
  const lines = String(content).split(/\r?\n/).map((text, i) => ({ text, line: i + 1 }))
  walk(lines.filter((l) => l.line > headerEnd || !/^:[A-Za-z0-9_-]+!?:/.test(l.text)), null, 0, true)

  const description = attributes.description !== undefined ? { text: proseOf(attributes.description), line: lineOf.description } : null
  let pathPart = null
  if (file) {
    const rel = String(file).split(/[\\/]/).join('/')
    // The module and the path under pages/. A solution's module is its slug
    // (cdc-to-lakehouse); a Product Docs module is a task area (manage).
    const m = /(?:^|\/)modules\/([^/]+)\/pages\/(.+)$/.exec(rel)
    const text = m ? `${m[1]}/${m[2]}` : rel.split('/').pop()
    pathPart = { text: text.replace(/\.adoc$/, '').replace(/[/_]/g, ' / '), line: 0 }
  }
  return { title, description, path: pathPart, headings, body, attributes, lineOf }
}

/**
 * Score every concept a page's text names.
 *
 * @param {Object} parts - from pageParts
 * @param {Object} matcher - from buildMatcher
 * @param {Object} [weights=WEIGHTS]
 * @returns {Map<string, {score: number, counts: Object, evidence: Array}>}
 */
function scorePage (parts, matcher, weights = WEIGHTS) {
  const taxonomy = matcher.taxonomy
  const W = { ...WEIGHTS, ...weights }
  const acc = new Map()
  const note = (ids, location, part, term, label, via) => {
    for (const id of ids) {
      if (!acc.has(id)) acc.set(id, { counts: Object.fromEntries(LOCATIONS.map((l) => [l, 0])), weighted: Object.fromEntries(LOCATIONS.map((l) => [l, 0])), evidence: [] })
      const a = acc.get(id)
      a.counts[location]++
      a.weighted[location] += via === 'deprecated-label' ? DEPRECATED_LABEL_FACTOR : 1
      a.evidence.push({ term, label, location, line: part.line, ...(part.source ? { source: part.source } : {}), via })
    }
  }
  const scan = (part, location) => {
    if (!part) return
    for (const hit of matchText(matcher, part.text)) note(hit.ids, location, part, hit.term, hit.label, hit.via)
  }
  scan(parts.title, 'title')
  scan(parts.description, 'description')
  scan(parts.path, 'path')
  for (const h of parts.headings) scan(h, 'heading')
  for (const b of parts.body) {
    if (b.sourceLanguage) {
      // A source block's language is a code literal: match it like any word,
      // ignoring the exact-case rule for short labels.
      const key = foldWord(b.sourceLanguage.toLowerCase())
      const c = (matcher.byFirst.get(key) || []).find((e) => e.words.length === 1)
      if (c) note(c.ids, 'body', b, b.sourceLanguage, c.label, 'source-language')
      continue
    }
    scan(b, 'body')
  }
  const out = new Map()
  for (const [id, a] of acc) {
    const concept = taxonomy.get(id)
    if (!concept || concept.deprecated) continue
    const w = a.weighted
    const once = (loc) => W[loc] * Math.min(1, w[loc])
    const bodyScore = w.body > 0 ? Math.min(W.bodyCap, W.body * (1 + Math.log2(Math.max(1, w.body))) * Math.min(1, w.body)) : 0
    const score = once('title') + once('description') + once('path') + W.heading * Math.min(W.maxHeadings, w.heading) + bodyScore
    out.set(id, { score: Math.round(score * 100) / 100, counts: a.counts, evidence: a.evidence })
  }
  return out
}

function reasonOf (counts) {
  const parts = []
  if (counts.title) parts.push('the title')
  if (counts.description) parts.push('the description')
  if (counts.path) parts.push('the page path')
  if (counts.heading) parts.push(`${counts.heading} heading${counts.heading === 1 ? '' : 's'}`)
  if (counts.body) parts.push(`${counts.body} body mention${counts.body === 1 ? '' : 's'}`)
  if (!parts.length) return ''
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `named in ${list}`
}

/**
 * Keep the evidence short: one hit per line and location, the first hit in
 * each location, then the rest in page order, up to `max`.
 */
function trimEvidence (evidence, max = 5) {
  const seen = new Set()
  const unique = evidence.filter((e) => {
    const key = `${e.source || ''}:${e.line}:${e.location}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const firsts = LOCATIONS.map((loc) => unique.find((e) => e.location === loc)).filter(Boolean)
  const rest = unique.filter((e) => !firsts.includes(e))
  return [...firsts, ...rest].slice(0, max).sort((a, b) => LOCATIONS.indexOf(a.location) - LOCATIONS.indexOf(b.location) || a.line - b.line)
}

/**
 * Suggest taxonomy values for one page.
 *
 * @param {string} content - the page's AsciiDoc source
 * @param {Object} options
 * @param {import('./taxonomy').Taxonomy} options.taxonomy
 * @param {Function} options.parseHeader - tools/check-metadata parseHeader
 * @param {Object} [options.matcher] - from buildMatcher, to reuse across pages
 * @param {number} [options.minScore] - default DEFAULT_MIN_SCORE for the page kind
 * @param {number} [options.limit] - per facet; default DEFAULT_LIMIT for the page kind
 * @param {boolean} [options.solution] - default: page-layout solution, or any page-solution-* facet set
 * @param {string} [options.file] - the page's path, weighed as the `path` location
 * @param {Function} [options.readInclude] - see pageParts
 * @param {Object} [options.weights] - overrides WEIGHTS, for measuring
 * @returns {{kind: 'docs'|'solution', existing: Object<string, string[]>, suggestions: Array<Object>, needs: Array<Object>}}
 */
function suggestForPage (content, { taxonomy, parseHeader, matcher, minScore, limit, solution, file, readInclude, weights } = {}) {
  matcher = matcher || buildMatcher(taxonomy)
  const parts = pageParts(content, parseHeader, { file, readInclude })
  const attrs = parts.attributes
  const isSolution = solution !== undefined
    ? solution
    : isSolutionPage(attrs) || ['page-solution-use-cases', 'page-solution-technologies', 'page-solution-industries'].some((a) => attrs[a] !== undefined)
  const kind = isSolution ? 'solution' : 'docs'
  if (minScore === undefined || minScore === null) minScore = DEFAULT_MIN_SCORE[kind]
  if (limit === undefined || limit === null) limit = DEFAULT_LIMIT[kind]
  const attributeFor = isSolution ? SOLUTION_ATTRIBUTE : DOCS_ATTRIBUTE

  // What the page already carries, per attribute, with what it implies.
  const carried = new Map() // attribute -> Set(direct live ids)
  const sourceAttrs = isSolution ? [CATEGORY_ATTRIBUTE, ...Object.keys(SOLUTION_FACETS)] : [CATEGORY_ATTRIBUTE]
  for (const attribute of sourceAttrs) {
    const set = new Set()
    for (const value of splitValues(attrs[attribute])) {
      if (value.includes('{')) continue
      const hit = taxonomy.resolve(value, { prefer: attribute === 'page-solution-platforms' ? 'id' : 'label' })
      if (hit) hit.ids.forEach((id) => set.add(id))
    }
    carried.set(attribute, set)
  }
  const allCarried = new Set([...carried.values()].flatMap((s) => [...s]))
  const covered = new Map() // attribute -> Map(id -> implied by id|null)
  for (const scheme of SUGGEST_SCHEMES) {
    const attribute = attributeFor[scheme]
    if (covered.has(attribute)) continue
    const m = new Map()
    for (const id of carried.get(attribute) || []) {
      m.set(id, null)
      for (const [implied, how] of taxonomy.expand([id])) if (how === 'implied' && !m.has(implied)) m.set(implied, id)
    }
    covered.set(attribute, m)
  }

  const scores = scorePage(parts, matcher, weights)
  const ranked = [...scores.entries()]
    .map(([id, s]) => ({ id, ...s, concept: taxonomy.get(id) }))
    .filter((s) => SUGGEST_SCHEMES.includes(s.concept.scheme))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))

  // Prefer the narrower concept: a broader one that is outscored or matched
  // by one of its own narrower concepts is implied, not suggested.
  const scoreOf = (id) => (scores.get(id) ? scores.get(id).score : 0)

  const suggestions = []
  const taken = new Map() // scheme -> count of suggestions
  const existingCount = {}
  for (const scheme of SUGGEST_SCHEMES) {
    existingCount[scheme] = [...(carried.get(attributeFor[scheme]) || [])].filter((id) => taxonomy.get(id) && taxonomy.get(id).scheme === scheme).length
  }
  for (const s of ranked) {
    if (s.score < minScore) break
    const scheme = s.concept.scheme
    const attribute = attributeFor[scheme]
    const cov = covered.get(attribute)
    if (cov.has(s.id)) continue // carried, or implied by what is carried or suggested
    if (attribute === CATEGORY_ATTRIBUTE && allCarried.has(s.id)) continue
    const { max } = cardinalityOf(taxonomy, scheme, kind)
    const room = Math.min(limit, max - existingCount[scheme])
    if ((taken.get(scheme) || 0) >= room) continue
    // A broader concept whose narrower concept also scored: suggest the narrower.
    const narrower = taxonomy.narrower(s.id).filter((n) => scoreOf(n) >= minScore && !cov.has(n))
    if (narrower.length) continue
    const implies = [...taxonomy.expand([s.id])].filter(([id, how]) => how === 'implied' && !cov.has(id)).map(([id]) => id)
    cov.set(s.id, null)
    for (const id of implies) {
      // Same attribute: the implied concept must not be written as well.
      if (attributeFor[taxonomy.get(id).scheme] === attribute) cov.set(id, s.id)
    }
    taken.set(scheme, (taken.get(scheme) || 0) + 1)
    suggestions.push({
      facet: scheme,
      attribute,
      conceptId: s.id,
      label: s.concept.prefLabel,
      score: s.score,
      reason: reasonOf(s.counts),
      implies: implies.map((id) => ({ conceptId: id, label: taxonomy.label(id), facet: taxonomy.get(id).scheme })),
      evidence: trimEvidence(s.evidence),
    })
  }

  // On a solution overview each facet has its own attribute, so a concept
  // implied across facets (Iceberg Topics implies Apache Iceberg) must be
  // written in the other attribute too. Suggest it there when the page does
  // not carry it, from a value the page carries or a suggestion above.
  const impliers = [
    ...[...allCarried].map((id) => ({ id, attribute: attributeFor[taxonomy.get(id) && taxonomy.get(id).scheme], score: scoreOf(id), evidence: [] })),
    ...suggestions.map((x) => ({ id: x.conceptId, attribute: x.attribute, score: x.score, evidence: x.evidence })),
  ]
  for (const from of impliers) {
    const concept = taxonomy.get(from.id)
    if (!concept || !from.attribute) continue
    for (const target of concept.implies) {
      const t = taxonomy.get(target)
      if (!t || t.deprecated || !SUGGEST_SCHEMES.includes(t.scheme)) continue
      const attribute = attributeFor[t.scheme]
      if (attribute === from.attribute) continue
      const cov = covered.get(attribute)
      if (cov.has(target) || allCarried.has(target)) continue
      const { max } = cardinalityOf(taxonomy, t.scheme, kind)
      if (existingCount[t.scheme] + (taken.get(t.scheme) || 0) >= max) continue
      cov.set(target, from.id)
      taken.set(t.scheme, (taken.get(t.scheme) || 0) + 1)
      suggestions.push({
        facet: t.scheme,
        attribute,
        conceptId: target,
        label: t.prefLabel,
        score: Math.max(from.score, scoreOf(target)),
        reason: `implied by ${concept.prefLabel}, which the page ${allCarried.has(from.id) ? 'carries' : 'is suggested'}`,
        implies: [],
        impliedBy: from.id,
        evidence: from.evidence,
      })
    }
  }

  // A required facet (min >= 1) with nothing carried and nothing suggested.
  const needs = []
  for (const scheme of SUGGEST_SCHEMES) {
    const { min } = cardinalityOf(taxonomy, scheme, kind)
    if (min > 0 && existingCount[scheme] + (taken.get(scheme) || 0) < min) {
      needs.push({ facet: scheme, attribute: attributeFor[scheme], min, message: `${attributeFor[scheme]} needs at least ${min} ${scheme} value${min === 1 ? '' : 's'} and the text names none above the minimum score; choose from ${taxonomy.conceptIds(scheme).join(', ')}` })
    }
  }

  const existing = {}
  for (const [attribute, set] of carried) if (set.size) existing[attribute] = [...set]
  return { kind, minScore, limit, existing, suggestions, needs }
}

module.exports = {
  SUGGEST_SCHEMES,
  LOCATIONS,
  WEIGHTS,
  DEFAULT_MIN_SCORE,
  DEFAULT_LIMIT,
  parseCardinality,
  foldWord,
  words,
  buildMatcher,
  matchText,
  pageParts,
  scorePage,
  suggestForPage,
}
