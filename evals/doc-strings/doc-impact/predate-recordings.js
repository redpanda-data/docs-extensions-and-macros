#!/usr/bin/env node

'use strict'

/**
 * Take the writer's later docs change back out of a live recording.
 *
 * A recording made from today's docs.redpanda.com already holds the docs
 * change a writer made because of the item's PR, so the pass correctly
 * answers "already documented". This script edits each recorded result so
 * it shows the docs as they were before that change:
 *
 * - a result section from a page the change created is removed, and so is
 *   a section whose heading the change added over a body the change
 *   mostly added, and one left with nothing but its breadcrumb line;
 * - on a page the change edited (or anywhere, for a partial, whose
 *   including pages are unknown), the sentences and lines the change added
 *   are removed where they match after normalization. A fenced code block
 *   whose every line the change added is removed whole, and a table row is
 *   edited cell by cell. An added line the file already held before the
 *   change is kept, because the page held it already;
 * - anywhere, a sentence or list item that links to a page the change
 *   created is removed.
 *
 * Everything else stays byte-identical. Production recordings, which hold
 * what the docs said at review time, are left alone, and so is any call
 * already predated (see predateRecording).
 *
 * Two steps, so neither the script nor the repository names a docs change
 * that lives in a private repository:
 *
 *   node predate-recordings.js --prepare <candidates.json> --docs <checkout> \
 *     --items items.json --out <changes.json>
 *       Reads each needs_docs item's merged docs PRs from the private
 *       candidates file, and writes, per item, each changed .adoc file's
 *       page URL (null for a partial), whether the change created it, the
 *       lines it added and the lines the file held before. Uses gh and
 *       `git -C <checkout> show/diff`; never changes the checkout. Keep the
 *       output outside any public repository.
 *
 *   node predate-recordings.js --apply <changes.json> [--recordings <dir>]
 *       Edits the recordings beside items.json (or in <dir>): predates each
 *       call not yet predated and marks it, and sums the marks into the
 *       recording's predated: {sections_removed, passages_removed}.
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

// ---------- normalization ----------

// One rule for both sides, so AsciiDoc source and the server's Markdown
// rendering of it compare equal. {attr} references become a wildcard
// marker, because the rendering carries the attribute's value.
const WILD = '\u0000'

function normalize (s) {
  let t = String(s)
  t = t.replace(/\\([\\`*_[\]()#+\-.!|])/g, '$1') // Markdown escapes
  t = t.replace(/\{[A-Za-z0-9_-]+\}/g, WILD)
  t = t.replace(/\b(?:xref|link|mailto):[^\s[]*\[([^\]]*?)\^?\]/g, '$1')
  t = t.replace(/https?:\/\/[^\s[\]()]+\[([^\]]*?)\^?\]/g, '$1')
  t = t.replace(/<<[^,>]+,\s*([^>]+)>>/g, '$1')
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  t = t.replace(/\b(?:pass|kbd|footnote|btn|menu):\[([^\]]*)\]/g, '$1')
  t = t.replace(/<\d+>|\(\d+\)/g, ' ')
  t = t.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s--\s|\u2014/g, ' - ')
  t = t.replace(/&#8217;/g, "'")
  t = t.replace(/[`*+]/g, '').replace(/[|#]/g, ' ')
  t = t.replace(/(^|[\s(])_+|_+(?=[\s.,;:!?)]|$)/g, '$1')
  t = t.replace(/^\s*=+\s+/, '')
  t = t.replace(/^\s*(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION):\s+/, '')
  t = t.replace(/::\s*$/, '')
  t = t.replace(/^\.(?=[A-Za-z])/, '')
  t = t.replace(/\s+/g, ' ').replace(/ ([.,;:!?])/g, '$1').trim()
  for (let prev = null; prev !== t;) {
    prev = t
    t = t.replace(/^(?:\d+\.|[-.]+|\d+)\s+/, '')
  }
  return t.toLowerCase()
}

// Sentence spans of one line, split after . ! or ? and a space. Joining
// the spans with single spaces gives the line back when it had no runs of
// whitespace between sentences.
function sentences (line) {
  const parts = []
  for (const p of line.split(/(?<=[.!?])\s+/)) {
    if (!p.length) continue
    // "2." or "Table 4." alone is a list number or caption label, not a
    // sentence.
    if (parts.length && /^[\s|*#>-]*(?:[A-Za-z]+ )?\d+\\?\.$/.test(parts[parts.length - 1])) parts[parts.length - 1] += ' ' + p
    else parts.push(p)
  }
  return parts
}

// AsciiDoc lines that render to nothing comparable.
function structural (line) {
  const t = line.trim()
  return !t ||
    /^(?:-{4,}|={4,}|\.{4,}|\*{4,}|_{4,}|\+{4,}|\|===|\+|\/\/.*)$/.test(t) ||
    /^\[[^\]]*\]$/.test(t) ||
    /^\[\[[^\]]*\]\]$/.test(t) ||
    /^(?:ifdef|ifndef|ifeval|endif|include|image|toc)::/.test(t) ||
    /^:[!\w-]+!?:/.test(t)
}

function wildcard (n) {
  const src = n.split(WILD).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.{1,80}?')
  return new RegExp(`^${src}$`)
}

// Shortest normalized text worth removing on its own. Shorter added text
// ("Helm", "spec:") matches too much of an unrelated page.
const MIN_LEN = 12

/**
 * Build the matcher for one page's added text.
 * added: AsciiDoc lines the change added. existing: lines the file held
 * before the change ([] for a created file).
 */
function buildMatcher ({ added = [], existing = [] }) {
  const before = new Set()
  // Each line, each of its sentences, and for a table row each cell and
  // the cell's sentences: the rendering may join or split any of them.
  const unitsOf = (line) => {
    const u = [line, ...sentences(line)]
    if (/^\s*\|/.test(line)) for (const cell of line.split('|').slice(1)) u.push(cell, ...sentences(cell))
    return u.map(normalize)
  }
  for (const line of existing) {
    if (structural(line)) continue
    for (const n of unitsOf(line)) before.add(n)
  }
  // Removable: added, new, and long enough. Added: every added unit, new
  // or not, which decides whether a whole code block came from the change.
  const removable = { exact: new Set(), patterns: [] }
  const anyAdded = { exact: new Set(), patterns: [] }
  const put = (set, n) => {
    if (n.includes(WILD)) set.patterns.push(wildcard(n))
    else set.exact.add(n)
  }
  const addUnit = (n) => {
    const bare = n.split(WILD).join('').trim()
    if (!bare) return
    put(anyAdded, n)
    if (before.has(n) || bare.length < MIN_LEN) return
    put(removable, n)
  }
  for (const line of added) {
    if (structural(line)) continue
    for (const n of unitsOf(line)) addUnit(n)
  }
  const has = (set, n) => set.exact.has(n) || set.patterns.some((re) => re.test(n))
  return { isNew: (n) => has(removable, n), wasAdded: (n) => has(anyAdded, n), existed: (n) => before.has(n) }
}

// ---------- editing one section ----------

const LEAD = /^[\s|*#>-]*(?:\d+\.\s+)?/

/**
 * Remove the added passages from one section's Markdown content.
 * Returns { content, removed } where removed counts sentences, lines and
 * code blocks taken out. Untouched lines keep their exact bytes.
 */
function stripPassages (content, matchers, created = new Set()) {
  if (!matchers.length && !created.size) return { content, removed: 0 }
  // A link to a page the change created cannot be older than the change.
  const linksCreated = (text) => created.size > 0 &&
    [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].some((m) => created.has(pageKey(m[1])))
  const isNew = (n) => matchers.some((m) => m.isNew(n))
  const wasAdded = (n) => matchers.some((m) => m.wasAdded(n))
  const existed = (n) => matchers.some((m) => m.existed(n))
  const lines = content.split('\n')
  // A section whose heading the change added, and whose body the change
  // mostly added or the file mostly did not hold before, is a section the
  // change wrote. Later rewording of its sentences does not make it older;
  // a renamed heading over an older body keeps the body.
  const heading = lines.find((l) => /^#{2,6} /.test(l))
  if (heading && isNew(normalize(heading))) {
    const units = lines.filter((l) => l !== heading && !/^# /.test(l) && !/^[\s|:-]*$/.test(l) && !/^\s*```/.test(l))
    const old = units.filter((l) => existed(normalize(l)) || sentences(l).some((p) => existed(normalize(p))))
    const added = units.filter((l) => wasAdded(normalize(l)))
    if (units.length && (old.length * 4 < units.length || added.length * 2 >= units.length)) return { content: '', removed: 0, section: true }
  }
  const out = []
  const cuts = new Set() // positions in out right after a removed line
  let removed = 0
  const cut = (k = 1) => { removed += k; cuts.add(out.length) }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // A fenced code block: drop it whole when the change added every line.
    if (/^\s*```/.test(line)) {
      let j = i + 1
      while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) j++
      if (j < lines.length) {
        const body = lines.slice(i + 1, j)
        const units = body.map(normalize).filter(Boolean)
        if (units.length && units.every(wasAdded) && units.some(isNew)) {
          cut()
          i = j
          continue
        }
        out.push(line)
        for (const b of body) {
          if (isNew(normalize(b))) cut()
          else out.push(b)
        }
        out.push(lines[j])
        i = j
        continue
      }
    }
    // A list item that links to a created page goes with its indented
    // continuation lines (the linked page's description, for example).
    if (/^\s*(?:[-*]|\d+\.)\s/.test(line) && linksCreated(sentences(line)[0])) {
      const indent = line.match(/^\s*/)[0].length
      while (i + 1 < lines.length && lines[i + 1].trim() && lines[i + 1].match(/^\s*/)[0].length > indent) i++
      cut()
      continue
    }
    const n = normalize(line)
    if (!n) { out.push(line); continue }
    // A table row with several filled cells is edited cell by cell, so a
    // cut never merges cells. The row goes when the cells that lose all
    // their text held most of its text.
    if (/^\s*\|/.test(line) && line.split('|').filter((c) => c.trim()).length > 1) {
      let gone = 0
      let filled = 0
      let emptied = 0
      const cells = line.split('|').map((cell) => {
        const cn = normalize(cell)
        if (cn.length < MIN_LEN) return cell
        filled += cn.length
        const cp = sentences(cell)
        const ck = cp.filter((p) => !isNew(normalize(p)) && !linksCreated(p) && !(isNew(cn) && !existed(normalize(p))))
        gone += cp.length - ck.length
        if (!ck.length) emptied += cn.length
        return ck.length === cp.length ? cell : ck.join(' ')
      })
      if (!gone) out.push(line)
      else if (emptied * 2 > filled) cut(gone)
      else { removed += gone; out.push(cells.join('|')) }
      continue
    }
    // A line the change added or reworded as a whole goes, except for any
    // sentence of it the file held before the change.
    const parts = sentences(line)
    const whole = isNew(n) || (parts.length < 2 && linksCreated(line))
    if (parts.length < 2) {
      if (whole) cut()
      else out.push(line)
      continue
    }
    const keep = parts.filter((p) => {
      const pn = normalize(p)
      return !isNew(pn) && !linksCreated(p) && !(whole && !existed(pn))
    })
    if (keep.length === parts.length) { out.push(line); continue }
    if (!keep.length) { cut(parts.length); continue }
    removed += parts.length - keep.length
    // Keep the line's leading and trailing markup (indent, list marker,
    // table cell bars) when the sentence that carried it goes.
    const kept = [...keep]
    if (keep[0] !== parts[0]) kept[0] = parts[0].match(LEAD)[0] + kept[0].trimStart()
    if (keep[keep.length - 1] !== parts[parts.length - 1]) {
      const tail = parts[parts.length - 1].match(/\|+\s*$/)
      if (tail && !kept[kept.length - 1].endsWith(tail[0])) kept[kept.length - 1] += tail[0]
    }
    out.push(kept.join(' '))
  }
  // Collapse a blank line a removal left doubled, and only there.
  const tidy = []
  for (let k = 0; k < out.length; k++) {
    if (cuts.has(k) && out[k] === '' && tidy.length && tidy[tidy.length - 1] === '') continue
    tidy.push(out[k])
  }
  return { content: removed ? tidy.join('\n') : content, removed }
}

// ---------- pages ----------

// docs.redpanda.com page key: no fragment, no query, and the version
// segment of a versioned component dropped, so /streaming/26.1/x/ and
// /streaming/current/x/ are the same page.
function pageKey (url) {
  const u = String(url).split('#')[0].split('?')[0].replace(/\/?$/, '/')
  return u.replace(/^(https:\/\/docs\.redpanda\.com\/streaming)\/[^/]+\//, '$1/*/')
}

/**
 * Predate the calls of one recording that are not predated yet (returns a
 * new object). changes: [{ url|null, created, added, existing }] for the
 * item.
 *
 * Each processed call gets predated: {sections_removed, passages_removed},
 * even when nothing in it matched, and a marked call is never processed
 * again. So after `--mcp record --merge` adds calls to a predated
 * recording, a second apply predates only the new calls. The recording's
 * own predated field is the sum over its calls.
 *
 * A recording predated before calls were marked carries only that
 * recording-level field. Its calls are all processed already, so they are
 * marked without any content change: the first call takes the old totals
 * and the rest take zeros, which keeps the sum.
 */
function predateRecording (recording, changes) {
  const created = new Set(changes.filter((c) => c.created && c.url).map((c) => pageKey(c.url)))
  const byPage = new Map()
  const everywhere = []
  for (const c of changes) {
    if (c.created && c.url) continue
    const m = buildMatcher(c)
    if (!c.url) { everywhere.push(m); continue }
    const k = pageKey(c.url)
    if (!byPage.has(k)) byPage.set(k, [])
    byPage.get(k).push(m)
  }
  const report = []
  let processed = 0

  function predateCall (call) {
    let sections = 0
    let passages = 0
    const content = !Array.isArray(call.content)
      ? call.content
      : call.content.map((part) => {
        if (part.type !== 'text') return part
        let doc
        try { doc = JSON.parse(part.text) } catch { return part }
        if (!doc || !Array.isArray(doc.results)) return part
        let touched = false
        const results = []
        for (const r of doc.results) {
          const k = pageKey(r.source_url || '')
          if (created.has(k)) {
            sections++
            touched = true
            report.push({ kind: 'section', source_url: r.source_url })
            continue
          }
          const matchers = [...(byPage.get(k) || []), ...everywhere]
          const { content: c, removed, section } = stripPassages(r.content || '', matchers, created)
          if (section || (removed && !c.split('\n').some((l) => l.trim() && !/^# /.test(l)))) {
            // Nothing but the breadcrumb left: the change added the section.
            sections++
            touched = true
            report.push({ kind: 'section', source_url: r.source_url })
          } else if (removed) {
            passages += removed
            touched = true
            report.push({ kind: 'passages', source_url: r.source_url, removed })
            results.push({ ...r, content: c })
          } else {
            results.push(r)
          }
        }
        return touched ? { ...part, text: JSON.stringify({ ...doc, results }) } : part
      })
    return { ...call, content, predated: { sections_removed: sections, passages_removed: passages } }
  }

  const legacy = Boolean(recording.predated) && !recording.calls.some((c) => c.predated)
  const zero = { sections_removed: 0, passages_removed: 0 }
  const calls = recording.calls.map((call, i) => {
    if (call.predated) return call
    if (legacy) {
      const old = recording.predated
      return { ...call, predated: i === 0 ? { sections_removed: old.sections_removed || 0, passages_removed: old.passages_removed || 0 } : { ...zero } }
    }
    processed++
    return predateCall(call)
  })
  const predated = { ...zero }
  for (const c of calls) {
    if (!c.predated || c.predated === true) continue
    predated.sections_removed += c.predated.sections_removed || 0
    predated.passages_removed += c.predated.passages_removed || 0
  }
  return { recording: { ...recording, calls, predated }, report, processed }
}

function apply (changesFile, recordingsDir) {
  const changes = JSON.parse(fs.readFileSync(changesFile, 'utf8'))
  const summary = []
  for (const [id, list] of Object.entries(changes.items || {})) {
    const file = path.join(recordingsDir, `${id}.json`)
    if (!fs.existsSync(file)) { summary.push({ id, skipped: 'no recording' }); continue }
    const raw = fs.readFileSync(file, 'utf8')
    const rec = JSON.parse(raw)
    if (rec.source === 'production') { summary.push({ id, skipped: 'production recording' }); continue }
    const { recording, report, processed } = predateRecording(rec, list)
    const out = JSON.stringify(recording, null, 2) + '\n'
    if (out !== raw) fs.writeFileSync(file, out)
    summary.push({ id, calls_predated: processed, ...recording.predated, report })
  }
  return summary
}

// ---------- prepare (private inputs, local only) ----------

function prepare ({ candidates, docs, items }) {
  const { adocToUrl } = require('./mine-candidates')
  const cands = JSON.parse(fs.readFileSync(candidates, 'utf8'))
  const ids = new Set(JSON.parse(fs.readFileSync(items, 'utf8')).filter((i) => i.label === 'needs_docs').map((i) => i.id))
  const git = (...a) => execFileSync('git', ['-C', docs, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 })
  const out = { items: {} }
  for (const c of cands) {
    if (!ids.has(c.id)) continue
    const list = []
    const seen = new Set()
    for (const pr of c.docs_prs || []) {
      if (pr.state !== 'merged') continue
      const repo = (pr.url.match(/github\.com\/[^/]+\/([^/]+)\/pull\//) || [])[1]
      const view = JSON.parse(execFileSync('gh', ['pr', 'view', pr.url, '--json', 'mergeCommit'], { encoding: 'utf8' }))
      const sha = view.mergeCommit && view.mergeCommit.oid
      if (!sha) continue
      const status = git('diff', '--name-status', '--no-renames', `${sha}^1`, sha, '--', 'modules/')
      for (const row of status.trim().split('\n').filter(Boolean)) {
        const [st, file] = row.split('\t')
        if (!file.endsWith('.adoc') || st === 'D') continue
        const mapped = adocToUrl(repo, file)
        if (!mapped) continue // nav.adoc and the like render no page of their own
        const url = /^https?:\/\//.test(mapped) ? mapped : null // null: a partial
        const diff = git('diff', '-U0', `${sha}^1`, sha, '--', file)
        const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1))
        const existing = st === 'A' ? [] : git('show', `${sha}^1:${file}`).split('\n')
        const key = `${url}\n${added.join('\n')}`
        if (seen.has(key)) continue // the same change merged to two branches
        seen.add(key)
        list.push({ url, created: st === 'A', added, existing })
      }
    }
    if (list.length) out.items[c.id] = list
  }
  return out
}

// ---------- main ----------

function parseArgs (argv) {
  const a = {}
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i]
    const v = argv[i + 1]
    if (k === '--prepare') { a.prepare = v; i++ } else if (k === '--docs') { a.docs = v; i++ } else if (k === '--items') { a.items = v; i++ } else if (k === '--out') { a.out = v; i++ } else if (k === '--apply') { a.apply = v; i++ } else if (k === '--recordings') { a.recordings = v; i++ } else throw new Error(`unknown argument ${k}`)
  }
  return a
}

function main () {
  const a = parseArgs(process.argv)
  if (a.prepare) {
    if (!a.docs || !a.items || !a.out) throw new Error('--prepare needs --docs, --items and --out')
    fs.writeFileSync(a.out, JSON.stringify(prepare({ candidates: a.prepare, docs: a.docs, items: a.items }), null, 2) + '\n')
    return
  }
  if (a.apply) {
    const dir = a.recordings || path.join(__dirname, 'recordings')
    console.log(JSON.stringify(apply(a.apply, dir), null, 2))
    return
  }
  throw new Error('pass --prepare or --apply (see the header comment)')
}

if (require.main === module) {
  try { main() } catch (e) { console.error(process.env.DEBUG ? e.stack : e.message); process.exit(2) }
}

module.exports = { normalize, sentences, buildMatcher, stripPassages, pageKey, predateRecording, apply }
