'use strict'

/**
 * Candidate taxonomy terms: frequent, distinctive terms on a page that no
 * concept's label or altLabel matches. `doc-tools check-metadata --suggest`
 * lists them beside the suggestions, and `--candidates-only` aggregates them
 * across a repository, so a person or a later model step can propose new
 * concepts or altLabels from evidence instead of from memory.
 *
 * Deterministic, with no model. Two kinds of term are collected:
 *
 *   - Capitalized terms in prose: a run of up to four capitalized, CamelCase,
 *     or all-caps words (Amazon S3, BigQuery, SASL), in the description and
 *     the body outside code blocks. Titles and headings are left out because
 *     they are title case. A single word is counted only where it does not
 *     start a sentence, and a leading common word is dropped ("Use Amazon S3"
 *     is "Amazon S3").
 *   - Code identifiers: a snake_case or kebab-case name in backticks that the
 *     page uses as a component (followed by input, output, processor, cache,
 *     connector, and so on), or the target of an xref to a Redpanda Connect
 *     component page. Other identifiers are configuration properties and
 *     fields, not taxonomy values, so they are left out.
 *
 * A term is dropped when a taxonomy label or altLabel matches inside it, when
 * it is in the terminology list (the style guide's word lists or the docs
 * glossary, see loadTerminology), when every word is a stop word or common
 * English (COMMON_WORDS), a language keyword (NULL, GROUP BY), or a
 * Kubernetes object kind (Pods, PersistentVolumeClaim), when every mention is
 * on a sales or licensing line (Redpanda Sales, Enterprise Edition), or when
 * a single word also appears in lowercase in the page's prose, which is the
 * mark of an ordinary word that started a phrase. The product's own name is
 * stripped from the front of a term, and alone it is no term.
 *
 * Each candidate has a likely facet from simple cues: a connector name or a
 * database, format, or product cue word next to it is a technology; a
 * multi-word title-case name with no cue is a topic (Remote Read Replicas);
 * anything else has no facet.
 */

const fs = require('fs')
const path = require('path')
const { matchText, words, foldWord } = require('./metadata-suggest')

// Common English and docs boilerplate words. A term made only of these is not
// distinctive. Lowercase.
const COMMON_WORDS = new Set(`
a about above across add added after again against all allow also always an and another any are as at available
back be because been before being below best between both build built but by
can cannot change changes check choose click close come complete configure configuring connect content contents
copy could create created current custom
data default define delete describe description different do does doing done down during
each edit either else enable enabled end enter even every example examples except
false file files find first follow following for from full
get give go good
has have help here how however
if important in include includes information install instead into is it its
just
keep know
last learn least less let like limit limits list load local
make many may more most move must
name names need new next no none not note now number
of off on once one only open option optional options or order other our out output over overview
page part per prerequisites prerequisite previous provide
read reference related remove replace required requirements result return run running
same save see select set sets setting settings should show since so some specify start started step steps still
such summary support supported
table take than that the their them then there these they this those through tip to true try two type types
under until up update updated use used uses using
value values version versions view
want warning was way we what when where whether which while who why will with within without would write
yes you your
caution notice
b kb mb gb tb pb kib mib gib tib bps kbps mbps gbps ms msec ns us
api apis ui url urls uri uris id ids ip ips cpu cpus ram os vm vms cli sdk http https tcp udp dns utc sha
get post put patch head
monday tuesday wednesday thursday friday saturday sunday
january february march april june july august september october november december
`.trim().split(/\s+/))

// English stop words and the verbs and nouns of UI and docs boilerplate that
// COMMON_WORDS does not already hold. A term made only of these is dropped.
for (const w of `
am aren't couldn't did didn't doesn't don't few further hadn't hasn't haven't having he her hers herself him himself his
i i'm me mine my myself nor ours ourselves own she shan't shouldn't themselves very wasn't we're weren't won't wouldn't yours
yourself yourselves itself whom
manage manager show hide logs log home overview dashboard details detail general advanced basic premium standard
support sales data user users account accounts team teams project projects organization organizations
`.trim().split(/\s+/)) COMMON_WORDS.add(w)

// Keywords of SQL, Bloblang, and common programming languages. A term made
// only of these (NULL, GROUP BY, INSERT INTO) is syntax, not a name. Uppercase
// keys are compared case-insensitively.
const LANGUAGE_KEYWORDS = new Set(`
select from where insert into update delete create drop alter table tables view index join inner outer left right full cross
on using group by order having limit offset union intersect except distinct values set returning with as case when then
else end null not and or is in like ilike between exists any all some primary key foreign references constraint default
unique check cascade begin commit rollback transaction grant revoke partition over window rows range filter lateral
true false nan uuid int integer bigint smallint varchar char text boolean bool decimal numeric float double real date time
timestamp timestamptz interval jsonb bytea serial array struct map
if elif else for while do switch break continue return func function def class import package var let const new
nil none undefined self this root meta match try catch throw finally async await yield public private protected static void
usage catalog schema owner privileges ok error warn warning info debug trace fatal completed failed running pending succeeded
`.trim().split(/\s+/))

// Kubernetes object kinds and resource words. Generic to every Kubernetes
// page, so a term made only of these (Pods, PersistentVolumeClaim, NodePort
// Service) is not a taxonomy value. Folded to singular, lowercase.
const KUBERNETES_KINDS = new Set(`
pod deployment statefulset daemonset replicaset service ingress ingressclass configmap secret persistentvolume
persistentvolumeclaim pvc pv storageclass namespace node job cronjob serviceaccount role rolebinding clusterrole
clusterrolebinding networkpolicy customresourcedefinition crd cr endpoint endpointslice horizontalpodautoscaler hpa
poddisruptionbudget pdb limitrange resourcequota servicemonitor podmonitor nodeport clusterip loadbalancer container
initcontainer sidecar volume volumemount affinity toleration taint kubelet
`.trim().split(/\s+/))

// The product's own name. A term made of it alone (Redpanda, Redpanda Data)
// is dropped, and a leading "Redpanda" is stripped, so "Redpanda Terraform"
// counts as Terraform and "Redpanda Support" is dropped as a common word.
const PRODUCT_WORDS = new Set(['redpanda'])

// A line that sells rather than documents: sales contact, pricing, buying.
// A term every one of whose mentions is on such a line (Enterprise Edition) is
// boilerplate. Words that technical lines use too (subscription, trial,
// upgrade to, license) are left out, so "Pub/Sub subscription" and
// "Azure subscription" lines still count.
const SALES_LINE_RE = /\b(?:contact (?:redpanda )?sales|account team|pricing|request a (?:trial|license)|purchase|enterprise edition)\b/i

/** Why a term, as its words, is not a candidate, or null. */
function excluded (ws) {
  const keys = ws.map((w) => w.toLowerCase())
  if (keys.every((k) => COMMON_WORDS.has(k))) return 'stop-word'
  if (keys.every((k) => LANGUAGE_KEYWORDS.has(k))) return 'language-keyword'
  if (keys.every((k) => KUBERNETES_KINDS.has(k) || KUBERNETES_KINDS.has(k.replace(/s$/, '')) || KUBERNETES_KINDS.has(k.replace(/es$/, '')))) return 'kubernetes-kind'
  return null
}

// Words next to a term that say which facet it belongs to.
const CUES = [
  { facet: 'technology', cue: 'connector-name', re: /^(?:input|output|processor|cache|buffer|connector|scanner|tracer|rate[_ -]?limit|component)s?$/i },
  { facet: 'technology', cue: 'database-name', re: /^(?:database|databases|db|table|tables|replica|cdc|warehouse)$/i },
  { facet: 'technology', cue: 'format-name', re: /^(?:format|formats|schema|schemas|serialization|encoding|file|files)$/i },
  { facet: 'technology', cue: 'product-name', re: /^(?:cli|api|apis|sdk|sdks|client|clients|library|libraries|server|servers|service|services|catalog|catalogs|bucket|buckets|operator|chart|cluster|clusters|plugin|plugins|driver|drivers|provider|providers|console|dashboard|dashboards)$/i },
]
// Inputs, outputs, and caches connect to an external system, so their names
// are technologies. Processors, buffers, and the rest are Connect's own
// building blocks (mapping, switch, branch) and are left out.
const CONNECT_COMPONENT_XREF_RE = /\bxref:(?:connect:)?components:(?:inputs|outputs|caches)\/([a-z0-9_]+)\.adoc/g
const BACKTICK_RE = /`([^`\s]+)`/g
const IDENT_RE = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+$/
const CAP_WORD_RE = /^(?:[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)*|[A-Z]{2,}[a-z]?[0-9]*|[A-Z][a-z]*[0-9]+[A-Za-z0-9]*|[a-z]+[A-Z][A-Za-z0-9]*)$/
// Words dropped from the front of a capitalized run: articles, prepositions,
// and the imperative verbs that start steps ("Configure Amazon S3").
const LEADING_WORDS = new Set('a an the to for in on of with from by if when and or use using see set create configure enable disable install select click add remove update delete run start stop open go read write check review learn edit choose deploy manage connect test verify view'.split(' '))
const MAX_TERM_WORDS = 4
const MAX_LINES = 10

/** Lowercase, whitespace-collapsed key. */
const keyOf = (term) => String(term).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Read terminology lists into a Set of lowercase keys.
 *
 * Accepts, per path:
 *   - a directory of docs glossary partials (shared/modules/terms/partials):
 *     each file's `:term-name:` and its `=== heading`;
 *   - a Markdown file such as the style guide's terminology.md: the first
 *     column of each table, except under a heading that names brands (the
 *     third-party brand list names exactly the products a candidate should
 *     surface);
 *   - any other file: one term per line.
 * A term with an abbreviation in parentheses, "access control list (ACL)",
 * adds both.
 *
 * @param {Array<string>} paths
 * @returns {{terms: Set<string>, sources: string[]}}
 */
function loadTerminology (paths) {
  const terms = new Set()
  const sources = []
  const add = (raw) => {
    const t = String(raw).replace(/[`*_]/g, '').trim()
    if (!t) return
    const paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(t)
    if (paren) {
      add(paren[1])
      add(paren[2])
      return
    }
    terms.add(keyOf(t))
  }
  for (const p of paths || []) {
    if (!fs.existsSync(p)) continue
    sources.push(p)
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p).filter((f) => f.endsWith('.adoc')).sort()) {
        const text = fs.readFileSync(path.join(p, f), 'utf8')
        const name = /^:term-name:\s*(.+)$/m.exec(text)
        if (name) add(name[1])
        const heading = /^=+\s+(.+)$/m.exec(text)
        if (heading) add(heading[1])
      }
      continue
    }
    const text = fs.readFileSync(p, 'utf8')
    if (/\.md$/i.test(p)) {
      let brands = false
      for (const line of text.split(/\r?\n/)) {
        const h = /^#+\s+(.*)$/.exec(line)
        if (h) { brands = /brand/i.test(h[1]); continue }
        if (brands) continue
        const row = /^\|([^|]+)\|/.exec(line)
        if (!row || /^\s*:?-+:?\s*$/.test(row[1]) || /^\s*(term|unit|extension)\s*$/i.test(row[1])) continue
        add(row[1])
      }
    } else {
      for (const line of text.split(/\r?\n/)) if (line.trim() && !line.startsWith('#')) add(line)
    }
  }
  return { terms, sources }
}

/** The cue in the word right after a term ("Snowflake catalog"), if any. */
function cueAfter (word) {
  return word ? CUES.find((x) => x.re.test(word)) || null : null
}

/**
 * Collect candidate terms on one page.
 *
 * @param {Object} parts - from pageParts
 * @param {Object} matcher - from buildMatcher(taxonomy, { allLabels: true }), so a
 *   term any concept covers, in any scheme, is dropped
 * @param {Object} [options]
 * @param {Set<string>} [options.terminology] - lowercase keys to drop
 * @param {number} [options.minCount=2] - occurrences on the page
 * @param {number} [options.max=10] - candidates per page, most frequent first
 * @returns {Array<{term: string, count: number, lines: Array<{line: number, source?: string}>, facet: string|null, cue: string}>}
 */
function pageCandidates (parts, matcher, { terminology = new Set(), minCount = 2, max = 10 } = {}) {
  const found = new Map() // key -> { spellings: Map, count, lines, cues: Map }
  const note = (raw, part, cue) => {
    // Strip the product's own name from the front; nothing left, no term.
    let words = raw.split(/\s+/)
    if (PRODUCT_WORDS.has(words[0].toLowerCase())) {
      // Redpanda Console is a label: the whole term is covered, not "Console".
      if (matchText(matcher, raw).length) return
      while (words.length && PRODUCT_WORDS.has(words[0].toLowerCase())) words = words.slice(1)
    }
    if (!words.length) return
    const identifier = words.length === 1 && /[_-]/.test(words[0])
    if (excluded(identifier ? words[0].split(/[_-]/) : words)) return
    const term = words.join(' ')
    const key = keyOf(term)
    if (!found.has(key)) found.set(key, { spellings: new Map(), count: 0, sales: 0, lines: [], cues: new Map() })
    const f = found.get(key)
    f.spellings.set(term, (f.spellings.get(term) || 0) + 1)
    f.count++
    if (SALES_LINE_RE.test(part.raw || part.text || '')) f.sales++
    if (f.lines.length < MAX_LINES && !f.lines.some((l) => l.line === part.line && l.source === part.source)) {
      f.lines.push(part.source ? { line: part.line, source: part.source } : { line: part.line })
    }
    const name = cue ? `${cue.facet}:${cue.cue}` : 'none'
    f.cues.set(name, (f.cues.get(name) || 0) + 1)
  }

  // Lowercase words in prose: a capitalized single word that also appears
  // lowercase is an ordinary word.
  const lowercase = new Set()
  const prose = [parts.description, ...parts.body.filter((b) => !b.code && !b.sourceLanguage)].filter(Boolean)
  const capitalized = new Set()
  for (const p of prose) {
    for (const w of words(p.text)) {
      if (w.raw === w.raw.toLowerCase()) lowercase.add(foldWord(w.raw))
      else capitalized.add(w.raw.toLowerCase())
    }
  }

  // Capitalized terms.
  for (const p of prose) {
    const ws = words(p.text)
    let i = 0
    while (i < ws.length) {
      if (!CAP_WORD_RE.test(ws[i].raw)) { i++; continue }
      let j = i
      // Consecutive words, separated by a single space only.
      while (j + 1 < ws.length && j + 1 - i < MAX_TERM_WORDS && CAP_WORD_RE.test(ws[j + 1].raw) &&
        /^ $/.test(p.text.slice(ws[j].index + ws[j].raw.length, ws[j + 1].index))) j++
      let start = i
      // Drop leading common words ("Use", "The") and a sentence-starting word.
      while (start < j && (LEADING_WORDS.has(ws[start].raw.toLowerCase()) || (start === i && ws[i].sentenceStart && COMMON_WORDS.has(ws[i].raw.toLowerCase())))) start++
      const span = ws.slice(start, j + 1)
      i = j + 1
      if (!span.length) continue
      if (span.length === 1 && span[0].sentenceStart) continue
      if (span.length === 1 && lowercase.has(foldWord(span[0].raw.toLowerCase()))) continue
      // A lowerCamelCase word is an identifier (stringArray), unless the rest
      // is capitals (mTLS).
      if (span.some((w) => /^[a-z]/.test(w.raw) && !/^[a-z]{1,2}[A-Z0-9]+$/.test(w.raw))) continue
      if (span.every((w) => /^[A-Z0-9]+$/.test(w.raw) && w.raw.length < 2)) continue
      const term = p.text.slice(span[0].index, span[span.length - 1].index + span[span.length - 1].raw.length)
      // Part of a hyphenated compound ("Comma-separated"), not a name.
      const end = span[span.length - 1].index + span[span.length - 1].raw.length
      if (p.text[end] === '-' || p.text[span[0].index - 1] === '-') continue
      note(term, p, cueAfter(ws[j + 1] && ws[j + 1].raw))
    }
  }

  // Code identifiers used as components, and Connect component xrefs.
  for (const b of parts.body) {
    if (b.sourceLanguage || !b.raw) continue
    for (const m of b.raw.matchAll(CONNECT_COMPONENT_XREF_RE)) {
      // A one-word name (cache, generate, redis) is a system's name only
      // when the page also writes it capitalized (Redis); otherwise it is a
      // Connect building block named with an ordinary word.
      if (!m[1].includes('_') && !capitalized.has(m[1])) continue
      note(m[1], b, CUES[0])
    }
    if (b.code) continue
    for (const m of b.raw.matchAll(BACKTICK_RE)) {
      const ident = m[1]
      if (!IDENT_RE.test(ident)) continue
      const [after] = words(b.raw.slice(m.index + m[0].length))
      const cue = cueAfter(after && after.raw)
      if (cue && cue.cue === 'connector-name') note(ident, b, cue)
    }
  }

  const out = []
  for (const [key, f] of found) {
    if (f.count < minCount) continue
    if (terminology.has(key)) continue
    if (f.sales === f.count) continue // only ever in sales or licensing lines
    const spelling = [...f.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
    if (matchText(matcher, spelling).length) continue // a label already covers it
    const best = [...f.cues.entries()].filter(([k]) => k !== 'none').sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
    let facet = null
    let cue = 'none'
    if (best) [facet, cue] = best[0].split(':')
    else if (/^[a-z]+[A-Z]|[a-z][A-Z]/.test(spelling) && !/\s/.test(spelling)) { facet = 'technology'; cue = 'brand-casing' }
    else if (/\s/.test(spelling) && spelling.split(/\s+/).every((w) => /^[A-Z][a-z]/.test(w))) { facet = 'topic'; cue = 'title-case-name' }
    out.push({ term: spelling, count: f.count, lines: f.lines, facet, cue })
  }
  out.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
  return out.slice(0, max)
}

/**
 * Aggregate per-page candidates across a repository: one entry per term with
 * the pages it appears in, most widespread first.
 *
 * @param {Array<{file: string, candidates: Array}>} perPage
 * @param {Object} [options]
 * @param {number} [options.minPages=1]
 * @param {number} [options.minCount=2] - occurrences across all pages
 * @param {number} [options.maxPageShare=0.2] - a term on more than this share
 *   of the pages is boilerplate (a shared partial, a table heading), not a
 *   distinctive term; dropped when there are 20 pages or more
 * @returns {Array<{term, count, pageCount, facet, cue, pages: Array<{file, count, lines}>}>}
 */
function aggregateCandidates (perPage, { minPages = 1, minCount = 2, maxPageShare = 0.2 } = {}) {
  const all = new Map()
  for (const { file, candidates } of perPage) {
    for (const c of candidates) {
      const key = keyOf(c.term)
      if (!all.has(key)) all.set(key, { spellings: new Map(), count: 0, facets: new Map(), pages: [] })
      const a = all.get(key)
      a.spellings.set(c.term, (a.spellings.get(c.term) || 0) + c.count)
      a.count += c.count
      const fk = `${c.facet || ''}:${c.cue}`
      a.facets.set(fk, (a.facets.get(fk) || 0) + c.count)
      a.pages.push({ file, count: c.count, lines: c.lines })
    }
  }
  const out = []
  for (const a of all.values()) {
    if (a.pages.length < minPages || a.count < minCount) continue
    if (perPage.length >= 20 && a.pages.length > maxPageShare * perPage.length) continue
    const term = [...a.spellings.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0]
    const ranked = [...a.facets.entries()].sort((x, y) => (x[0].startsWith(':') ? 1 : 0) - (y[0].startsWith(':') ? 1 : 0) || y[1] - x[1] || x[0].localeCompare(y[0]))
    const [facet, cue] = ranked[0][0].split(':')
    out.push({ term, count: a.count, pageCount: a.pages.length, facet: facet || null, cue, pages: a.pages.sort((x, y) => y.count - x.count || x.file.localeCompare(y.file)) })
  }
  out.sort((x, y) => y.pageCount - x.pageCount || y.count - x.count || x.term.localeCompare(y.term))
  return out
}

module.exports = {
  COMMON_WORDS,
  LANGUAGE_KEYWORDS,
  KUBERNETES_KINDS,
  excluded,
  loadTerminology,
  pageCandidates,
  aggregateCandidates,
}
