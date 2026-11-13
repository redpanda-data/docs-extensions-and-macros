'use strict'

/**
 * Builds the one PR review the doc-strings review posts per run.
 *
 * The model never posts. It writes findings.json: one entry per issue it
 * found, keyed to the declaration the issue is on. This module turns that
 * file into the body of one `POST /pulls/{n}/reviews` call, with one inline
 * comment per issue, so everything about what reaches the PR is decided
 * here, mechanically, and is the same in the workflow and in the eval:
 *
 * - findings.json is untrusted (the model read PR content). Only keys the
 *   lint handed the review are accepted, every field is type-checked, and
 *   HTML comment markers and @-mentions are neutralized in what is posted.
 * - Tiers. `wrong` and `unclear` issues are posted inline. `style` issues
 *   (sentence length, Latin abbreviations, inline code nits) go to the job
 *   summary unless styleComments is on. An issue whose rule is a lint rule
 *   takes that rule's tier from the lint report, not the model's word.
 * - A declaration a review already closed is never commented on again: an
 *   issue keyed to one goes to the job summary as a late finding.
 * - Issues on overlapping lines become one comment that numbers each issue.
 * - At most `maxComments` inline comments, wrong first, then unclear, then
 *   lint findings. The rest are listed in the review body, and count as
 *   raised.
 * - Lines come from the lint, which ran on the merge commit. Comments anchor
 *   to the PR head, so each span is checked against the head file and moved
 *   if the base branch shifted it, and must sit inside one hunk of the PR's
 *   own diff. A comment that cannot be placed goes to the review body.
 * - The self-check: every suggestion is applied to a copy of the merge
 *   commit and the lint is run again; a suggestion that brings a new warning
 *   or error into its span loses its suggestion block and keeps its text.
 *
 * Every comment carries a hidden `<!-- doc-strings-review:key=K issue=R -->`
 * marker and the review body a `<!-- doc-strings-review:keys=K1,K2 -->`
 * ledger naming every declaration this run reviewed, which is how a later
 * run knows they are closed even after the Actions cache is evicted.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const TIERS = ['wrong', 'unclear', 'style']
const KEY = /^[0-9a-f]{16}$/
const MAX_COMMENTS = 10
const MAX_BODY = 4000
const MAX_NOTES = 5
const MAX_NOTE = 300
// Size caps, so every review body and comment stays under GitHub's 65,536
// characters with room to spare, and the 422 fallback always fits.
const MAX_ISSUES = 40
const MAX_GROUP_PROBLEM = 1000
const MAX_REVIEW_BODY = 60000
const MAX_FALLBACK_REWRITE = 1500
const PATH = /^[\w./+@-]{1,300}$/
const MARKER = 'doc-strings-review'

// ---------------------------------------------------------------------------
// Untrusted text
// ---------------------------------------------------------------------------

/**
 * Model text made safe to post: no HTML comment can open or close (so no
 * hidden marker can be forged and nothing can be hidden from the reader), the
 * marker prefix cannot be spelled out in visible text either, no code fence
 * can open (U+200B inside every run of three or more backticks or tildes, so
 * the text cannot carry a ```suggestion block of its own past the
 * self-check and committable_suggestions), and an @-mention cannot notify
 * anyone (U+200B after the @).
 */
function sanitize (text) {
  return String(text == null ? '' : text)
    .replace(/<!--/g, '&lt;!--')
    .replace(/-->/g, '--&gt;')
    .replace(new RegExp(`${MARKER}:`, 'gi'), `${MARKER}\u200B:`)
    .replace(/([`~])(?=\1\1)/g, '$1\u200B')
    .replace(/(^|[^\w])@(?=[A-Za-z0-9])/g, '$1@\u200B')
    .trim()
}

/** A rule id fit for a marker attribute. */
function ruleId (rule) {
  const id = String(rule || 'prose').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return id || 'prose'
}

/** The first sentence of a problem, for one-line lists. */
function firstSentence (text, limit = 200) {
  const one = String(text || '').replace(/\s+/g, ' ').trim()
  const m = one.match(/^(.+?[.!?])(\s|$)/)
  const s = m ? m[1] : one
  return s.length > limit ? `${s.slice(0, limit - 3)}...` : s
}

/** A fence longer than any backtick run in the text, so the text cannot close it. */
function fenceFor (text) {
  let longest = 2
  for (const m of String(text).matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  return '`'.repeat(longest + 1)
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Read a key list (one per line, or comma separated); anything else is ignored. */
function readKeys (text) {
  return new Set(String(text || '').split(/[\s,]+/).filter((t) => KEY.test(t)))
}

/**
 * The PR's own files and hunks: `gh api --paginate pulls/N/files` output as
 * one JSON array, several concatenated arrays (one per page), or one object
 * per line. Returns Map(path -> [[start, end], ...]) of RIGHT-side hunk
 * ranges. A file with no patch (too large, binary) has no ranges, so nothing
 * in it can be commented on inline.
 */
function parsePrFiles (text) {
  const entries = []
  const src = String(text || '').trim()
  if (src) {
    let parsed = null
    try { parsed = JSON.parse(src) } catch {}
    if (Array.isArray(parsed)) entries.push(...parsed)
    else if (parsed && typeof parsed === 'object') entries.push(parsed)
    else {
      // Concatenated pages ("][") or JSON lines.
      const joined = src.replace(/\]\s*\[/g, ',')
      try {
        const all = JSON.parse(joined)
        if (Array.isArray(all)) entries.push(...all)
      } catch {
        for (const line of src.split('\n')) {
          try { const o = JSON.parse(line); if (o && typeof o === 'object') entries.push(o) } catch {}
        }
      }
    }
  }
  const hunks = new Map()
  for (const e of entries) {
    if (!e || typeof e.filename !== 'string') continue
    hunks.set(e.filename, hunkRanges(typeof e.patch === 'string' ? e.patch : ''))
  }
  return hunks
}

/** RIGHT-side line ranges of each hunk in one file's patch. */
function hunkRanges (patch) {
  const ranges = []
  for (const m of String(patch).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1])
    const count = m[2] === undefined ? 1 : Number(m[2])
    if (count > 0) ranges.push([start, start + count - 1])
  }
  return ranges
}

/** Hunk ranges from a local `git diff`, for a caller with no PR API (the eval). */
function hunksFromGit (repo, base, head = 'HEAD') {
  const r = spawnSync('git', ['diff', '--no-color', '--no-ext-diff', `${base}...${head}`], { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`git diff ${base}...${head} failed: ${r.stderr}`)
  const files = []
  let current = null
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\+\+\+ b\/(.+)$/)
    if (m) { current = { filename: m[1], patch: '' }; files.push(current); continue }
    if (/^diff --git /.test(line)) { current = null; continue }
    if (current && line.startsWith('@@')) current.patch += `${line}\n`
  }
  return parsePrFiles(JSON.stringify(files))
}

/**
 * Check findings.json against the shape the prompt asks for. Returns the
 * issues and notes that survive, and the reasons the rest did not. A file
 * that is not JSON, not an object, has `issues` or `checked` as anything but
 * an array, or has neither, is `fatal`: the review cannot tell what was
 * checked, so nothing is built and nothing is closed. A missing `checked`
 * closes nothing but the keys issues name.
 */
function validateFindings (raw) {
  const problems = []
  const fatal = (why) => ({ issues: [], checked: [], notes: [], problems: [why], fatal: why })
  let data = raw
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw) } catch (err) { return fatal(`findings.json is not JSON: ${err.message}`) }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fatal('findings.json is not an object')
  const arrayOrAbsent = (v) => v === undefined || Array.isArray(v)
  if (!arrayOrAbsent(data.issues) || !arrayOrAbsent(data.checked) || (data.issues === undefined && data.checked === undefined)) {
    return fatal('findings.json has no `issues` or `checked` array')
  }
  const issues = []
  for (const [i, it] of (data.issues || []).entries()) {
    const why = []
    if (!it || typeof it !== 'object') { problems.push(`issue ${i}: not an object`); continue }
    if (issues.length >= MAX_ISSUES) { problems.push(`issue ${i}: over the ${MAX_ISSUES}-issue limit`); continue }
    if (typeof it.key !== 'string' || !KEY.test(it.key)) why.push('key is not 16 hex digits')
    if (typeof it.path !== 'string' || !PATH.test(it.path) || it.path.split('/').includes('..')) why.push('bad path')
    if (!Number.isInteger(it.line) || it.line < 1) why.push('line is not a positive integer')
    const start = it.start_line == null ? it.line : it.start_line
    if (!Number.isInteger(start) || start < 1 || (Number.isInteger(it.line) && start > it.line)) why.push('bad start_line')
    if (!TIERS.includes(it.tier)) why.push('tier is not wrong, unclear or style')
    if (typeof it.problem !== 'string' || !it.problem.trim()) why.push('no problem text')
    if (it.replacement != null && typeof it.replacement !== 'string') why.push('replacement is not a string or null')
    const size = String(it.problem || '').length + String(it.replacement || '').length
    if (size > MAX_BODY) why.push(`longer than ${MAX_BODY} characters`)
    if (why.length) { problems.push(`issue ${i}: ${why.join(', ')}`); continue }
    issues.push({
      index: i,
      key: it.key,
      path: it.path.replace(/^\.\//, ''),
      start_line: start,
      line: it.line,
      tier: it.tier,
      rule: typeof it.rule === 'string' ? it.rule : 'prose',
      problem: it.problem,
      replacement: it.replacement == null ? null : String(it.replacement).replace(/\n$/, '')
    })
  }
  const checked = (data.checked || []).filter((k) => typeof k === 'string' && KEY.test(k))
  const notes = (Array.isArray(data.body_notes) ? data.body_notes : [])
    .filter((n) => typeof n === 'string' && n.trim())
    .slice(0, MAX_NOTES)
    .map((n) => firstSentence(n, MAX_NOTE))
  return { issues, checked, notes, problems, fatal: null }
}

/**
 * What the lint report says about each key: the open declarations this run
 * reviews (key -> [span], a list so two declarations that share a key are
 * both kept), the strings around them that a change can make wrong, the
 * declarations closed and edited since, the tier of every lint issue
 * (key|rule -> tier) and where each one is, and every file the report names.
 */
function indexLint (lint) {
  const open = new Map()
  const context = new Map()
  const closed = new Map()
  const lintTier = new Map()
  const lintIssues = []
  const files = new Set()
  const push = (map, key, v) => { if (!map.has(key)) map.set(key, []); map.get(key).push(v) }
  for (const d of (lint && lint.declarations) || []) {
    if (!d || !KEY.test(d.key || '')) continue
    push(open, d.key, { key: d.key, name: d.name, surface: d.surface, file: d.file, line_start: d.line_start, line_end: d.line_end })
    files.add(d.file)
    for (const c of d.context || []) {
      if (c && KEY.test(c.key || '') && !context.has(c.key)) {
        context.set(c.key, { key: c.key, name: c.name, surface: d.surface, file: c.file, line_start: c.line_start, line_end: c.line_end || c.line_start })
        files.add(c.file)
      }
    }
  }
  for (const d of ((lint && lint.summary && lint.summary.closedChangedDeclarations) || [])) {
    if (d && KEY.test(d.key || '')) { push(closed, d.key, d); files.add(d.file) }
  }
  for (const f of (lint && lint.findings) || []) {
    if (!f || !KEY.test(f.key || '')) continue
    files.add(f.file)
    for (const r of f.rules || []) {
      const tier = r.tier || 'unclear'
      lintTier.set(`${f.key}|${r.id}`, { tier, severity: r.severity })
      lintIssues.push({ key: f.key, file: f.file, id: r.id, tier, start: r.line || f.line_start, end: r.line || f.line_end || f.line_start })
    }
  }
  return { open, context, closed, lintTier, lintIssues, files }
}

/** The first span in `spans` that holds lines start..end of path p. */
function spanHolding (spans, p, start, end) {
  return (spans || []).find((d) => d.file === p && start >= d.line_start && end <= d.line_end) || null
}

/** Whether lines start..end of path p overlap any span in `spans`. */
function overlapsAny (spans, p, start, end) {
  return (spans || []).some((d) => d.file === p && start <= (d.line_end || d.line_start) && end >= d.line_start)
}

/**
 * What a model problem names when it is about one of the lint's style
 * findings, so the model cannot raise a lint style finding under its own
 * rule label and tier: an issue on the lines of a style finding of the same
 * declaration whose first sentence (the problem it states) names the same
 * thing takes the lint's tier. A problem that only mentions the style fix
 * later, as one its rewrite also makes, keeps its own tier.
 */
const STYLE_SUBJECTS = {
  'latin-abbreviation': /\b(?:e\.\s?g|i\.\s?e|etc)\b|latin/i,
  'long-sentence': /\b(?:long|\d+[- ]words?)\b[^.]*\bsentences?\b|\bsentences?\b[^.]*\b(?:long|words|split)\b/i,
  'em-dash': /em[ -]?dash|\u2014/i,
  'missing-inline-code': /inline code|backtick|monospace|code (?:font|format)/i,
  'connect-quoted-field-name': /inline code|backtick|quot/i,
  'starts-lowercase': /lower ?case|capital/i,
  'missing-terminal-period': /period|full stop/i,
  'trailing-period': /period|full stop/i,
  'rpk-terminal-period': /period|full stop/i,
  'api-missing-terminal-period': /period|full stop/i,
  'api-summary-terminal-period': /period|full stop/i
}

/** The lint tier an issue takes: by rule id, or by naming a style finding on its lines. */
function lintTierFor (issue, lintIndex) {
  const byId = lintIndex.lintTier.get(`${issue.key}|${issue.rule}`)
  if (byId) return byId.tier
  for (const l of lintIndex.lintIssues) {
    if (l.tier !== 'style' || l.key !== issue.key || l.file !== issue.path) continue
    if (issue.start_line > l.end || issue.line < l.start) continue
    const subject = STYLE_SUBJECTS[l.id]
    if (subject && subject.test(firstSentence(issue.problem, 1000))) return 'style'
  }
  return null
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Lower ranks are posted first when the cap applies. */
function rankOf (issue) {
  if (issue.tier === 'wrong') return 0
  if (issue.tier === 'unclear') return issue.lint ? 2 : 1
  return 3
}

/**
 * Sort accepted issues into what is posted, what goes to the job summary,
 * and what is dropped, and merge the posted ones that share lines.
 */
function planIssues ({ issues, lintIndex, closedKeys, styleComments, knownPaths = null }) {
  const post = []
  const style = []
  const late = []
  const dropped = []
  const allClosed = [...lintIndex.closed.values()].flat()
  for (const issue of issues) {
    const lt = lintTierFor(issue, lintIndex)
    const it = lt ? { ...issue, tier: lt, lint: true } : { ...issue, lint: false }
    const own = lintIndex.open.get(it.key)
    const ctx = lintIndex.context.get(it.key)
    if (!lintIndex.files.has(it.path) && !(knownPaths && knownPaths.has(it.path))) {
      dropped.push({ issue: it, why: 'its path is not a file in the lint report or the PR' })
      continue
    }
    // Closed by key, or sitting on the lines of a closed declaration under
    // another key: either way that declaration is never commented on again.
    if (closedKeys.has(it.key) || lintIndex.closed.has(it.key) || overlapsAny(allClosed, it.path, it.start_line, it.line)) {
      late.push(it)
      continue
    }
    if (!own && !ctx) {
      dropped.push({ issue: it, why: 'its key is not one this review was given' })
      continue
    }
    // An issue keyed to a declaration under review sits inside it, unless
    // the key is also a string this change made wrong, whose issue sits on
    // the changed line that made it wrong.
    const home = own ? spanHolding(own, it.path, it.start_line, it.line) : null
    if (own && !home && !ctx) {
      dropped.push({ issue: it, why: `lines ${it.start_line}-${it.line} of ${it.path} are not inside the declaration its key names` })
      continue
    }
    // A replacement may only stand in for lines of its own declaration. An
    // issue about a string this change made wrong sits on the changed line
    // that made it wrong, so it is a plain comment.
    if (it.replacement != null && !home && !(ctx && spanHolding([ctx], it.path, it.start_line, it.line))) {
      it.replacement = null
      it.replacementDropped = 'the rewrite would replace lines outside this string'
    }
    if (it.tier === 'style' && !styleComments) {
      style.push(it)
      continue
    }
    post.push(it)
  }
  return { groups: mergeOverlapping(post), style, late, dropped }
}

/** Issues on overlapping lines of one file become one group. */
function mergeOverlapping (issues) {
  const byPath = new Map()
  for (const it of issues) {
    if (!byPath.has(it.path)) byPath.set(it.path, [])
    byPath.get(it.path).push(it)
  }
  const groups = []
  for (const [p, list] of byPath) {
    const sorted = [...list].sort((a, b) => a.start_line - b.start_line || a.line - b.line || a.index - b.index)
    let cur = null
    for (const it of sorted) {
      if (cur && it.start_line <= cur.end) {
        cur.issues.push(it)
        cur.end = Math.max(cur.end, it.line)
      } else {
        cur = { path: p, start: it.start_line, end: it.line, issues: [it] }
        groups.push(cur)
      }
    }
  }
  for (const g of groups) {
    g.issues.sort((a, b) => rankOf(a) - rankOf(b) || a.index - b.index)
    g.rank = rankOf(g.issues[0])
    g.order = Math.min(...g.issues.map((i) => i.index))
  }
  return groups.sort((a, b) => a.rank - b.rank || a.order - b.order)
}

/**
 * One replacement for a group's whole span, as GitHub applies a suggestion
 * to every commented line. Replacements are taken in rank order and skipped
 * when they overlap one already taken; lines between the taken ones keep the
 * file's own text. Returns null when no issue in the group carries one.
 */
function composeReplacement (group, fileLines) {
  const taken = []
  for (const it of group.issues) {
    if (it.replacement == null) continue
    if (taken.some((t) => it.start_line <= t.line && it.line >= t.start_line)) {
      it.replacementDropped = 'the rewrite overlapped another fix in this comment'
      continue
    }
    taken.push(it)
  }
  if (!taken.length) return null
  taken.sort((a, b) => a.start_line - b.start_line)
  const out = []
  let at = group.start
  for (const t of taken) {
    for (; at < t.start_line; at++) out.push(fileLines[at - 1])
    out.push(...t.replacement.split('\n'))
    at = t.line + 1
  }
  for (; at <= group.end; at++) out.push(fileLines[at - 1])
  if (out.some((l) => l === undefined)) return null
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * Where a merge-commit span is in the head file, by text alone, for a caller
 * with no git history to map lines exactly (see lineMapFromGit): the same
 * lines when the text there matches, otherwise the one place in the head
 * file holding the same lines. Null when the head file does not hold them,
 * or holds them in more than one place: a guess could put the comment on
 * the wrong string.
 */
function remapSpan (mergeLines, headLines, start, end) {
  const want = mergeLines.slice(start - 1, end)
  if (want.length !== end - start + 1) return null
  const at = (s) => want.every((l, i) => headLines[s - 1 + i] === l)
  if (at(start)) return { start, end }
  const found = []
  for (let s = 1; s + want.length - 1 <= headLines.length; s++) {
    if (at(s)) found.push(s)
  }
  return found.length === 1 ? { start: found[0], end: found[0] + want.length - 1 } : null
}

/**
 * Hunks of a `git diff -U0 <head> <merge> -- <file>` as [headStart,
 * headCount, mergeStart, mergeCount], for mapSpanByHunks.
 */
function diffHunks (repo, from, to, file) {
  const r = spawnSync('git', ['diff', '--no-color', '--no-ext-diff', '-U0', from, to, '--', file], { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`git diff ${from} ${to} -- ${file} failed: ${r.stderr}`)
  const hunks = []
  for (const m of r.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks.push([Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])])
  }
  return hunks
}

/**
 * Where a merge-commit span is in the head file, exactly: every line the
 * merge did not change sits at its head line plus the lines the merge added
 * or removed above it. Null when any line of the span is one the merge
 * changed (the base branch edited it, so the head file does not hold it).
 */
function mapSpanByHunks (hunks, start, end) {
  const map = (line) => {
    let delta = 0
    for (const [, hc, ms, mc] of hunks) {
      if (mc > 0 && line >= ms && line <= ms + mc - 1) return null
      const before = mc > 0 ? ms + mc - 1 < line : ms < line
      if (before) delta += mc - hc
    }
    return line - delta
  }
  const s = map(start)
  const e = map(end)
  if (s == null || e == null || e - s !== end - start) return null
  return { start: s, end: e }
}

/** A mapSpan for buildReview that maps merge lines to head lines from git. */
function lineMapFromGit (repo, headRef, mergeRef = 'HEAD') {
  const cache = new Map()
  return (p, start, end) => {
    if (!cache.has(p)) cache.set(p, diffHunks(repo, headRef, mergeRef, p))
    return mapSpanByHunks(cache.get(p), start, end)
  }
}

/** Both ends of a span on the RIGHT side of one hunk. */
function inOneHunk (ranges, start, end) {
  return (ranges || []).some(([a, b]) => start >= a && end <= b)
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

/**
 * Apply every suggestion to a scratch worktree of the merge commit, lint it
 * again with the same options, and report the groups whose new span holds a
 * warning or error the original lint did not report for that declaration:
 * a rule that fires more often on the declaration than it did before. The
 * count, not the message, is compared, so a rewrite that keeps a finding
 * whose message names the text (a sentence's word count) is not flagged.
 * Fails open: any error means no group is flagged, and the reason is
 * returned for the job summary.
 */
function selfCheck ({ repo, base, groups, lint, surfaces = null, lintStrings = require('../lint-strings').lintStrings }) {
  const withSuggestion = groups.filter((g) => g.replacement != null)
  if (!withSuggestion.length) return { failed: new Set(), ran: false, error: null }
  const count = (findings, file) => {
    const n = new Map()
    for (const f of findings || []) {
      if (file && f.file !== file) continue
      for (const r of f.rules || []) {
        if (r.severity === 'info') continue
        n.set(`${f.key}|${r.id}`, (n.get(`${f.key}|${r.id}`) || 0) + 1)
      }
    }
    return n
  }
  const before = count(lint && lint.findings)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-strings-self-check-'))
  const wt = path.join(dir, 'tree')
  const git = (args, cwd = repo) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  try {
    const add = git(['worktree', 'add', '--detach', '--quiet', wt, 'HEAD'])
    if (add.status !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim()}`)
    // Apply bottom-up per file, then work out where each span ended up.
    const byPath = new Map()
    for (const g of withSuggestion) {
      if (!byPath.has(g.path)) byPath.set(g.path, [])
      byPath.get(g.path).push(g)
    }
    const spans = new Map()
    for (const [p, list] of byPath) {
      const abs = path.join(wt, p)
      const lines = fs.readFileSync(abs, 'utf8').split('\n')
      for (const g of [...list].sort((a, b) => b.start - a.start)) {
        lines.splice(g.start - 1, g.end - g.start + 1, ...g.replacement.split('\n'))
      }
      fs.writeFileSync(abs, lines.join('\n'))
      let shift = 0
      for (const g of [...list].sort((a, b) => a.start - b.start)) {
        const n = g.replacement.split('\n').length
        spans.set(g, { start: g.start + shift, end: g.start + shift + n - 1 })
        shift += n - (g.end - g.start + 1)
      }
    }
    const commit = git(['-c', 'user.name=doc-strings-review', '-c', 'user.email=doc-strings-review@invalid', '-c', 'commit.gpgsign=false',
      'commit', '--quiet', '--no-verify', '-a', '-m', 'doc-strings-review self-check'], wt)
    if (commit.status !== 0) throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`)
    const after = lintStrings({ repo: wt, diffBase: base, surfaces, log: () => {} })
    const afterCount = count(after.findings)
    const failed = new Set()
    for (const g of withSuggestion) {
      const span = spans.get(g)
      const keys = new Set(g.issues.map((i) => i.key))
      for (const f of after.findings || []) {
        if (f.file !== g.path || !keys.has(f.key)) continue
        for (const r of f.rules || []) {
          if (r.severity === 'info') continue
          const id = `${f.key}|${r.id}`
          if ((afterCount.get(id) || 0) <= (before.get(id) || 0)) continue
          const inSpan = r.line != null
            ? r.line >= span.start && r.line <= span.end
            : f.line_start <= span.end && f.line_end >= span.start
          if (inSpan) {
            failed.add(g)
            g.selfCheck = `${r.id}: ${firstSentence(r.message, 160)}`
          }
        }
      }
    }
    return { failed, ran: true, error: null }
  } catch (err) {
    return { failed: new Set(), ran: false, error: err.message }
  } finally {
    git(['worktree', 'remove', '--force', wt])
    fs.rmSync(dir, { recursive: true, force: true })
    git(['worktree', 'prune'])
  }
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function markerFor (issue) {
  return `<!-- ${MARKER}:key=${issue.key} issue=${ruleId(issue.rule)} -->`
}

function clip (text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text
}

/** One inline comment's body. */
function commentBody (group, { committable }) {
  const lines = []
  if (group.issues.length === 1) {
    lines.push(sanitize(group.issues[0].problem))
  } else {
    group.issues.forEach((it, i) => lines.push(`${i + 1}. ${clip(sanitize(it.problem).replace(/\s*\n+\s*/g, ' '), MAX_GROUP_PROBLEM)}`))
  }
  const notes = group.issues.filter((i) => i.replacementDropped).map((i) => i.replacementDropped)
  if (group.replacement != null) {
    const tag = committable ? 'suggestion' : 'text'
    const fence = fenceFor(group.replacement)
    lines.push('', `${fence}${tag}`, group.replacement, fence)
  } else if (group.selfCheck) {
    lines.push('', 'No suggested change: the rewrite added a lint finding of its own.')
  } else if (notes.length && !group.issues.some((i) => i.replacement != null)) {
    lines.push('', `No suggested change: ${notes[0]}.`)
  }
  lines.push('', ...group.issues.map(markerFor))
  return lines.join('\n')
}

/** One line of the review body for a group not posted inline, at its PR head line when known. */
function bodyListEntry (group, why) {
  const it = group.issues[0]
  const line = group.head ? group.head.start : group.start
  const more = group.issues.length > 1 ? ` (and ${group.issues.length - 1} more on the same lines)` : ''
  return `- \`${sanitize(group.path).replace(/`/g, '')}:${line}\`, ${ruleId(it.rule)}: ${sanitize(firstSentence(it.problem))}${more}${why ? ` (${why})` : ''}`
}

/**
 * The review body. `listed` is cut to fit MAX_REVIEW_BODY, and what is cut
 * is counted in a closing line and returned, for the job summary.
 */
function reviewBody ({ posted, listed, notes, keys, fallback = false }) {
  const head = []
  const n = posted
  const once = 'Each string is reviewed once, so later edits to these strings are not reviewed again.'
  if (fallback) {
    head.push(`This review found ${listed.length === 1 ? 'one issue' : `${listed.length} issues`} in the doc strings this PR adds or changes. GitHub refused to anchor the inline comments to the diff, so every issue is listed here instead. ${once}`)
  } else if (n > 0) {
    head.push(`This review left ${n === 1 ? 'one inline comment' : `${n} inline comments`} on the doc strings this PR adds or changes. The suggestions are optional. ${once}`)
  } else if (listed.length) {
    head.push(`This review found issues in the doc strings this PR adds or changes, listed below. ${once}`)
  } else {
    head.push(`This review of the doc strings this PR adds or changes found nothing to comment on. ${once}`)
  }
  const tail = []
  if (notes.length) tail.push('', 'Instruction-like text in the PR was ignored:', '', ...notes.map((t) => `- ${sanitize(t)}`))
  tail.push('', `<!-- ${MARKER}:keys=${[...keys].join(',')} -->`)
  const intro = fallback ? 'Issues:' : 'Also raised, not posted inline (over the comment limit, or outside the lines this PR changed):'
  let budget = MAX_REVIEW_BODY - head.join('\n').length - tail.join('\n').length - intro.length - 200
  const shown = []
  for (const entry of listed) {
    if (entry.length + 1 > budget) break
    shown.push(entry)
    budget -= entry.length + 1
  }
  const cut = listed.slice(shown.length)
  const lines = [...head]
  if (listed.length) {
    lines.push('', intro, '', ...shown)
    if (cut.length) lines.push(`- ...and ${cut.length} more, listed in the run's job summary.`)
  }
  lines.push(...tail)
  return { body: lines.join('\n'), cut }
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

/**
 * Build the review for one run.
 *
 * @param {object} o
 * @param {string|object} o.findings      findings.json, as text or parsed
 * @param {object} o.lint                 lint-findings.json, parsed
 * @param {Set<string>} [o.closedKeys]    keys already closed on the PR (markers and the cache)
 * @param {Map<string, Array>} o.hunks    path -> RIGHT-side hunk ranges of the PR head (parsePrFiles, hunksFromGit)
 * @param {(p: string) => string|null} o.readMerge  file text at the commit the lint ran on
 * @param {(p: string) => string|null} o.readHead   file text at the PR head
 * @param {(p: string, start: number, end: number) => {start, end}|null} [o.mapSpan]
 *   merge lines to head lines, exactly (lineMapFromGit). Without it, spans
 *   are matched by text (remapSpan).
 * @param {string} [o.headSha]
 * @param {boolean} [o.committable]       ```suggestion when true, ```text when false
 * @param {boolean} [o.styleComments]     post style-tier issues inline too
 * @param {number} [o.maxComments]
 * @param {(groups) => {failed: Set, ran: boolean, error: string|null}} [o.check]  the self-check
 * @returns {{ action, review, fallback, keys, summary, stats, error }}
 *   action is 'error' when findings.json is unreadable: nothing is posted
 *   and nothing closed.
 */
function buildReview ({ findings, lint, closedKeys = new Set(), hunks, readMerge, readHead, mapSpan = null, headSha = '', committable = true, styleComments = false, maxComments = MAX_COMMENTS, check = null }) {
  const valid = validateFindings(findings)
  const lintIndex = indexLint(lint)
  if (valid.fatal) {
    return {
      action: 'error',
      error: valid.fatal,
      review: null,
      fallback: null,
      keys: [],
      summary: `## Doc-strings review\n\nNo review built: ${cell(valid.fatal)}. Nothing is posted and nothing is closed, so the next push reviews these declarations again.\n`,
      stats: { action: 'error', error: valid.fatal }
    }
  }
  const knownPaths = new Set(hunks ? hunks.keys() : [])
  const plan = planIssues({ issues: valid.issues, lintIndex, closedKeys, styleComments, knownPaths })

  const mergeCache = new Map()
  const linesAt = (reader, cache, p) => {
    if (!cache.has(p)) {
      const t = reader ? reader(p) : null
      cache.set(p, t == null ? null : t.split('\n'))
    }
    return cache.get(p)
  }
  const headCache = new Map()

  // Replacements are composed in merge coordinates, where the model's lines are.
  for (const g of plan.groups) {
    const mergeLines = linesAt(readMerge, mergeCache, g.path)
    g.replacement = mergeLines ? composeReplacement(g, mergeLines) : null
    if (g.replacement != null && g.replacement.includes(`${MARKER}:`)) {
      g.replacement = null
      g.issues.forEach((i) => { i.replacementDropped = 'the rewrite held a review marker' })
    }
  }
  let checkResult = { failed: new Set(), ran: false, error: null }
  if (check) {
    checkResult = check(plan.groups)
    for (const g of checkResult.failed) g.replacement = null
  }

  // Where each group is in the PR head. A span is placed only when the head
  // holds the same text there.
  const headSpan = (g) => {
    const mergeLines = linesAt(readMerge, mergeCache, g.path)
    const headLines = linesAt(readHead, headCache, g.path) || mergeLines
    if (!mergeLines || !headLines) return null
    if (!mapSpan) return remapSpan(mergeLines, headLines, g.start, g.end)
    const span = mapSpan(g.path, g.start, g.end)
    if (!span) return null
    const same = mergeLines.slice(g.start - 1, g.end).every((l, i) => headLines[span.start - 1 + i] === l)
    return same ? span : null
  }

  const inline = []
  const listed = []
  const placementNotes = []
  for (const g of plan.groups) {
    const span = headSpan(g)
    if (!span) {
      listed.push(bodyListEntry(g, 'the PR head does not hold these lines'))
      placementNotes.push(`${g.path}:${g.start}-${g.end}: not in the head file`)
      continue
    }
    g.head = span
    if (!inOneHunk(hunks && hunks.get(g.path), span.start, span.end)) {
      listed.push(bodyListEntry(g, 'outside the lines this PR changed'))
      placementNotes.push(`${g.path}:${span.start}-${span.end}: not inside one hunk of the PR diff`)
      continue
    }
    if (inline.length >= maxComments) {
      listed.push(bodyListEntry(g, 'over the limit'))
      continue
    }
    const comment = { path: g.path, line: span.end, side: 'RIGHT', body: commentBody(g, { committable }) }
    if (span.start < span.end) Object.assign(comment, { start_line: span.start, start_side: 'RIGHT' })
    inline.push({ group: g, comment })
  }

  // The ledger: the declarations this run says it checked, plus any string
  // an issue raised (a string the change made wrong is closed by raising
  // it). An open declaration with no `checked` entry and no issue stays
  // open, so the next push reviews it.
  const checked = new Set(valid.checked)
  const keys = new Set([...lintIndex.open.keys()].filter((k) => checked.has(k)))
  for (const g of plan.groups) for (const i of g.issues) keys.add(i.key)
  for (const i of plan.style) keys.add(i.key)
  const ordered = [...keys].sort()

  const built = reviewBody({ posted: inline.length, listed, notes: valid.notes, keys: ordered })
  const review = { commit_id: headSha || undefined, event: 'COMMENT', body: built.body, comments: inline.map((x) => x.comment) }
  if (!review.commit_id) delete review.commit_id
  const fallbackListed = [...inline.map((x) => fallbackEntry(x.group)), ...listed]
  const fallbackBuilt = reviewBody({ posted: 0, listed: fallbackListed, notes: valid.notes, keys: ordered, fallback: true })
  const fallback = {
    ...(headSha ? { commit_id: headSha } : {}),
    event: 'COMMENT',
    body: fallbackBuilt.body,
    comments: []
  }
  const speaks = inline.length > 0 || listed.length > 0 || valid.notes.length > 0
  const action = speaks ? 'post' : ordered.length ? 'put' : 'none'
  const unchecked = [...lintIndex.open.keys()].filter((k) => !keys.has(k))

  const summary = jobSummary({ valid, plan, inline, listed, checkResult, lint, lintIndex, placementNotes, unchecked, cut: fallbackBuilt.cut.length > built.cut.length ? fallbackBuilt.cut : built.cut })
  return {
    action,
    review,
    fallback,
    keys: ordered,
    summary,
    error: null,
    stats: {
      action,
      comments: inline.length,
      listed: listed.length,
      style: plan.style.length,
      late: plan.late.length,
      dropped: plan.dropped.length + valid.problems.length,
      unchecked: unchecked.length,
      self_check: checkResult.ran ? 'ran' : checkResult.error ? 'error' : 'skipped',
      self_check_stripped: checkResult.failed.size,
      keys: ordered.length
    }
  }
}

/** A comment moved into the body by the 422 fallback: its text, and a short rewrite as plain text. */
function fallbackEntry (group) {
  const head = bodyListEntry(group, null)
  if (group.replacement == null || group.replacement.length > MAX_FALLBACK_REWRITE) return head
  const fence = fenceFor(group.replacement)
  return `${head}\n\n  ${fence}text\n${group.replacement.split('\n').map((l) => `  ${l}`).join('\n')}\n  ${fence}`
}

function cell (text) {
  return String(text == null ? '' : text).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;')
}

/** The job summary: what the docs team reads, never the PR author. */
function jobSummary ({ valid, plan, inline, listed, checkResult, lint, lintIndex, placementNotes, unchecked, cut }) {
  const out = ['## Doc-strings review', '']
  out.push(`Inline comments: ${inline.length}. Listed in the review body: ${listed.length}. Style findings kept off the PR: ${plan.style.length}. Late findings on declarations already reviewed: ${plan.late.length}.`, '')

  // Style findings the lint reported on the declarations this run reviewed,
  // and the ones the model tagged style.
  const styleRows = []
  for (const f of (lint && lint.findings) || []) {
    if (!lintIndex.open.has(f.key)) continue
    for (const r of f.rules || []) {
      if ((r.tier || 'unclear') === 'style') styleRows.push(`| \`${cell(f.name)}\` | ${cell(f.file)}:${r.line || f.line_start} | ${cell(r.id)} | ${cell(r.message)} |`)
    }
  }
  for (const it of plan.style) {
    styleRows.push(`| ${cell(nameOf(lintIndex, it.key))} | ${cell(it.path)}:${it.line} | ${cell(ruleId(it.rule))} (review) | ${cell(firstSentence(it.problem, 300))} |`)
  }
  out.push('### Style findings (not posted on the PR)', '')
  if (styleRows.length) out.push('| Declaration | Location | Rule | Message |', '|---|---|---|---|', ...styleRows, '')
  else out.push('None.', '')

  if (cut.length) {
    out.push('### Raised, but cut from the review body for length', '', ...cut.map((e) => e.split('\n')[0]), '')
  }

  const closedChanged = (lint && lint.summary && lint.summary.closedChangedDeclarations) || []
  if (closedChanged.length || plan.late.length) {
    out.push('### Declarations an earlier run on this PR already reviewed', '',
      'Touched again by this PR (edited since, or seen again after the cache was evicted). Not reviewed again and never commented on: a problem an edit brought in is the docs team\'s to follow up.', '')
    for (const d of closedChanged) out.push(`- \`${cell(d.name)}\` (${cell(d.surface)}), ${cell(d.file)}:${d.line_start}`)
    for (const it of plan.late) out.push(`- Late finding on ${cell(nameOf(lintIndex, it.key))}, ${cell(it.path)}:${it.line} (${it.tier}): ${cell(firstSentence(it.problem, 300))}`)
    out.push('')
  }

  const warnings = [
    ...valid.problems,
    ...plan.dropped.map((d) => `issue on ${d.issue.path}:${d.issue.line} dropped: ${d.why}`),
    ...unchecked.map((k) => `no \`checked\` entry for ${nameOf(lintIndex, k)} (${k}): it stays open, so the next push reviews it again`),
    ...placementNotes,
    ...(checkResult.error ? [`self-check did not run: ${checkResult.error}`] : []),
    ...[...checkResult.failed].map((g) => `self-check removed the suggestion on ${g.path}:${g.start}-${g.end}: ${g.selfCheck}`)
  ]
  if (warnings.length) out.push('### Review warnings', '', ...warnings.map((w) => `- ${cell(w)}`), '')
  return out.join('\n')
}

function nameOf (lintIndex, key) {
  const d = (lintIndex.open.get(key) || [])[0] || lintIndex.context.get(key) || (lintIndex.closed.get(key) || [])[0]
  return d ? `\`${d.name}\`` : key
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function gitShow (repo, ref, p) {
  const r = spawnSync('git', ['show', `${ref}:${p}`], { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return r.status === 0 ? r.stdout : null
}

function isMerge (repo) {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD^2'], { cwd: repo, encoding: 'utf8' }).status === 0
}

function bool (v, dflt) {
  if (v === undefined || v === null || v === '') return dflt
  return !/^(false|0|no|off)$/i.test(String(v))
}

/**
 * doc-tools build-review. Writes review.json, review-fallback.json, keys.txt
 * and summary.md to --out-dir and prints the stats as one JSON line. Exits 0
 * whenever it wrote them, so the workflow can tell "nothing to post" from
 * "could not build". A missing or unreadable findings.json exits 1 and
 * writes only summary.md, so nothing is posted and nothing is closed.
 *
 * The PR's hunks come from --base: `git diff <base>...<head-ref>`, the run's
 * own commits (on a merge checkout, HEAD^1...HEAD^2). --pr-files reads them
 * from the pulls API instead, which can name a newer head than the run's.
 */
function runCli (options) {
  try {
    const repo = path.resolve(options.repo || '.')
    const read = (f) => fs.readFileSync(f, 'utf8')
    const lint = JSON.parse(read(options.lint))
    const findings = options.findings && fs.existsSync(options.findings) ? read(options.findings) : null
    const closedKeys = new Set()
    for (const f of [].concat(options.closed || [])) {
      if (fs.existsSync(f)) for (const k of readKeys(read(f))) closedKeys.add(k)
    }
    const merge = isMerge(repo)
    const headRef = options.headRef || (merge ? 'HEAD^2' : 'HEAD')
    const hunks = options.base && !options.prFiles
      ? hunksFromGit(repo, options.base, headRef)
      : parsePrFiles(options.prFiles && fs.existsSync(options.prFiles) ? read(options.prFiles) : '')
    const surfaces = options.surface ? String(options.surface).split(',').map((s) => s.trim()).filter(Boolean) : null
    const out = path.resolve(options.outDir || '.')
    fs.mkdirSync(out, { recursive: true })
    if (findings == null) {
      const why = `findings.json not found at ${options.findings}`
      fs.writeFileSync(path.join(out, 'summary.md'), `## Doc-strings review\n\nNo review built: ${why}. Nothing is posted and nothing is closed, so the next push reviews these declarations again.\n`)
      console.error(`build-review: ${why}`)
      return 1
    }
    const result = buildReview({
      findings,
      lint,
      closedKeys,
      hunks,
      readMerge: (p) => { try { return fs.readFileSync(path.join(repo, p), 'utf8') } catch { return null } },
      readHead: (p) => gitShow(repo, headRef, p),
      mapSpan: headRef === 'HEAD' ? null : lineMapFromGit(repo, headRef, 'HEAD'),
      headSha: options.headSha || '',
      committable: bool(options.committable, true),
      styleComments: bool(options.styleComments, false),
      check: options.selfCheckBase ? (groups) => selfCheck({ repo, base: options.selfCheckBase, groups, lint, surfaces }) : null
    })
    if (result.action === 'error') {
      fs.writeFileSync(path.join(out, 'summary.md'), result.summary)
      console.error(`build-review: ${result.error}`)
      return 1
    }
    fs.writeFileSync(path.join(out, 'review.json'), JSON.stringify(result.review, null, 2))
    fs.writeFileSync(path.join(out, 'review-fallback.json'), JSON.stringify(result.fallback, null, 2))
    fs.writeFileSync(path.join(out, 'keys.txt'), result.keys.map((k) => `${k}\n`).join(''))
    fs.writeFileSync(path.join(out, 'summary.md'), result.summary)
    console.log(JSON.stringify(result.stats))
    return 0
  } catch (err) {
    console.error(`build-review: ${err.message}`)
    return 1
  }
}

module.exports = {
  buildReview,
  validateFindings,
  indexLint,
  planIssues,
  mergeOverlapping,
  composeReplacement,
  remapSpan,
  mapSpanByHunks,
  lineMapFromGit,
  inOneHunk,
  parsePrFiles,
  hunkRanges,
  hunksFromGit,
  selfCheck,
  sanitize,
  readKeys,
  runCli,
  MAX_COMMENTS
}
