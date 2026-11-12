#!/usr/bin/env node
'use strict'

/**
 * How often doc-strings review suggestions are taken.
 *
 * GitHub records no "suggestion applied" state: "Commit suggestion" leaves
 * only a commit message, and most engineers copy a suggestion by hand. So
 * this judges each suggestion by the merged code. Every inline suggestion the
 * review posts ends with its `doc-strings-review:fp=<16 hex>` footer, which
 * is how they are found. For each one, the file as merged is compared with
 * the suggestion and with the lines it was posted against:
 *
 *   taken      the merged file contains every suggested line
 *   adapted    neither version merged as written, and the merged text is
 *              closer to the suggestion than to the original
 *   declined   the original lines merged unchanged
 *   rewritten  the author wrote another version, closer to the original
 *   unclear    the suggestion barely differs from the original (a trailing
 *              period), so the merged text cannot tell them apart
 *   removed    nothing like either version is left in the merged file
 *   open / closed   the PR has not merged
 *
 * The repos are the ones whose workflows call doc-strings-review.yml, found
 * by code search at run time, so a repo that adopts the review is reported
 * with no change here.
 *
 * Usage: node tools/doc-strings-review/acceptance-report.js
 *          [--since YYYY-MM-DD] [--repos owner/a,owner/b]
 *          [--summary <file.md>] [--json <file.json>]
 *          [--slack <payload.json> [--slack-channel <#channel>]]
 * Needs `gh` and GH_TOKEN with read access to every calling repo.
 */

const crypto = require('crypto')
const fs = require('fs')
const { spawnSync } = require('child_process')
const { routeFile } = require('../lint-strings/diff')

const MARKER = /doc-strings-review:fp=[0-9a-f]{16}/
const SUGGESTION = /```suggestion[^\n]*\n([\s\S]*?)```/
// With committable_suggestions: false the review posts the same rewrite in a
// ```text block. Only the last one is the rewrite: an earlier one quotes the
// current string (as in evals/doc-strings/production.js).
const TEXT_SUGGESTION = /```text[^\n]*\n([\s\S]*?)```/g
const MERGED = ['taken', 'adapted', 'declined', 'rewritten', 'unclear', 'removed']
const ORDER = [...MERGED, 'open', 'closed', 'unknown']
// The workflow every caller references; the code search query matches it.
const CALLER_QUERY = 'docs-extensions-and-macros/.github/workflows/doc-strings-review.yml org:redpanda-data path:.github/workflows'
const SELF = 'redpanda-data/docs-extensions-and-macros'

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const nonEmptyLines = (s) => String(s || '').split('\n').map(norm).filter(Boolean)
const words = (s) => norm(s).split(' ').filter(Boolean)

/** The body of the first ```suggestion block (else the last ```text block), or null. */
function extractSuggestion (body) {
  const m = SUGGESTION.exec(body || '') || [...String(body || '').matchAll(TEXT_SUGGESTION)].pop()
  return m ? m[1] : null
}

/**
 * Word-level similarity in [0, 1]: twice the longest common subsequence of
 * words over the total word count (the same measure as Python's difflib
 * ratio, on words rather than characters).
 */
function similarity (a, b) {
  const x = words(a)
  const y = words(b)
  if (!x.length && !y.length) return 1
  if (!x.length || !y.length) return 0
  let prev = new Array(y.length + 1).fill(0)
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array(y.length + 1).fill(0)
    for (let j = 1; j <= y.length; j++) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    prev = cur
  }
  return (2 * prev[y.length]) / (x.length + y.length)
}

/**
 * Judge one suggestion on a merged PR.
 * @param {object} input
 * @param {string} input.suggestion - the suggestion block's text
 * @param {string} input.original - the lines it was posted against
 * @param {string|null} input.final - the whole file as merged, or null when the file is gone
 * @returns {string} one of MERGED
 */
function classify ({ suggestion, original, final }) {
  if (final == null) return 'removed'
  const text = norm(final)
  const sugg = nonEmptyLines(suggestion)
  const orig = nonEmptyLines(original)
  if (sugg.length && sugg.every((l) => text.includes(l))) return 'taken'
  if (orig.length && orig.join('\n') !== sugg.join('\n') && orig.every((l) => text.includes(l))) return 'declined'

  // The declaration as merged: the window of the final file most like either
  // version. Candidates are lines that share words with them, so an edited
  // description (which moves no anchor) is still found.
  const lines = String(final).split('\n')
  const n = Math.max(orig.length, sugg.length) + 1
  const vocab = new Set((orig.join(' ') + ' ' + sugg.join(' ')).match(/\w{5,}/g) || [])
  const shared = (l) => (l.match(/\w{5,}/g) || []).filter((w) => vocab.has(w)).length
  const candidates = lines.map((l, i) => [shared(l), i]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 25)
  let toS = 0
  let toO = 0
  for (const [, i] of candidates) {
    const window = lines.slice(Math.max(0, i - 2), i + n).join(' ')
    const s = similarity(window, sugg.join(' '))
    const o = similarity(window, orig.join(' '))
    if (Math.max(s, o) > Math.max(toS, toO)) {
      toS = s
      toO = o
    }
  }
  if (Math.max(toS, toO) < 0.4) return 'removed'
  // A suggestion that barely differs from the original (a trailing period, a
  // backtick pair) leaves a third version closer to neither: say so rather
  // than guess. The same for a dead heat.
  if (similarity(sugg.join(' '), orig.join(' ')) >= 0.9 || Math.abs(toS - toO) < 0.03) return 'unclear'
  return toS > toO ? 'adapted' : 'rewritten'
}

/** Counts by outcome for a list of rows. */
function count (rows) {
  const c = Object.fromEntries(ORDER.map((k) => [k, 0]))
  for (const r of rows) c[r.outcome] = (c[r.outcome] || 0) + 1
  return c
}

/**
 * One row per string rather than per suggestion: a string is re-reviewed
 * after each push, and its last suggestion on the PR decides.
 */
function perDeclaration (rows) {
  const last = new Map()
  for (const r of [...rows].sort((a, b) => a.created.localeCompare(b.created))) {
    last.set(`${r.repo}#${r.pr}:${r.path}:${r.decl}`, r)
  }
  return [...last.values()]
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-')

/** The Markdown report. */
function formatMarkdown (rows, { since, until }) {
  const out = []
  const merged = rows.filter((r) => MERGED.includes(r.outcome))
  const used = (c) => c.taken + c.adapted
  const total = count(merged)
  const decl = count(perDeclaration(rows).filter((r) => MERGED.includes(r.outcome)))
  const declTotal = MERGED.reduce((s, k) => s + decl[k], 0)
  out.push(`# Doc-strings review: how often suggestions are taken`)
  out.push('')
  out.push(`${since} to ${until}. Of ${merged.length} suggestions on merged PRs, **${pct(used(total), merged.length)} were taken or adapted** (${pct(total.taken, merged.length)} as written). Counted once per string, ${pct(used(decl), declTotal)} of ${declTotal} strings.`)
  out.push('')
  out.push('Judged from the merged code: GitHub records no "suggestion applied" state. Open and closed-unmerged PRs are left out of the rates.')
  out.push('')
  const table = (title, keyOf) => {
    out.push(`## ${title}`)
    out.push('')
    out.push('| | Suggestions | Taken | Adapted | Declined | Rewritten | Unclear | Removed | Open | Closed |')
    out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    const groups = new Map()
    for (const r of rows) {
      const k = keyOf(r)
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(r)
    }
    for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const c = count(g)
      const m = MERGED.reduce((s, x) => s + c[x], 0)
      out.push(`| ${k} | ${g.length} | ${pct(c.taken, m)} | ${pct(c.adapted, m)} | ${pct(c.declined, m)} | ${pct(c.rewritten, m)} | ${pct(c.unclear, m)} | ${pct(c.removed, m)} | ${c.open} | ${c.closed} |`)
    }
    out.push('')
  }
  table('By repo', (r) => r.repo.replace(/^redpanda-data\//, ''))
  table('By surface', (r) => r.surface || 'other')
  table('By month posted', (r) => r.created.slice(0, 7))
  const replied = rows.filter((r) => r.replies > 0 && ['declined', 'rewritten'].includes(r.outcome))
  if (replied.length) {
    out.push('## Declined or rewritten with a reply')
    out.push('')
    out.push('The reply usually says why. Newest first, up to 15:')
    out.push('')
    for (const r of replied.sort((a, b) => b.created.localeCompare(a.created)).slice(0, 15)) {
      out.push(`- [${r.repo.replace(/^redpanda-data\//, '')}#${r.pr}](${r.url}) \`${r.path}\` (${r.outcome})`)
    }
    out.push('')
  }
  return out.join('\n')
}

// Slack mrkdwn treats these three as control characters, even inside a link.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The Slack chat.postMessage body (channel from --slack-channel), laid out like the weekly docs digest
 * (docs-site netlify/functions/lib/docs-digest.mjs): a bold title line,
 * mrkdwn sections, a context footer with the run link.
 */
function formatSlack (rows, { since, until, runUrl = '', channel }) {
  const merged = rows.filter((r) => MERGED.includes(r.outcome))
  const c = count(merged)
  const used = c.taken + c.adapted
  const rate = (g) => {
    const k = count(g)
    const m = MERGED.reduce((s, x) => s + k[x], 0)
    return { m, used: k.taken + k.adapted, line: m ? `${pct(k.taken + k.adapted, m)} of ${m}` : 'no merged PRs yet' }
  }
  const groupLines = (keyOf) => {
    const groups = new Map()
    for (const r of rows) {
      const k = keyOf(r)
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(r)
    }
    return [...groups.entries()]
      .map(([k, g]) => [k, rate(g)])
      .sort((a, b) => b[1].m - a[1].m)
      .map(([k, r]) => `• ${esc(k)}: ${r.line}`)
      .join('\n')
  }
  const title = `Doc-strings review suggestions taken, ${since} to ${until}`
  const headline = merged.length
    ? `*${pct(used, merged.length)}* of ${merged.length} suggestions on merged PRs were taken or adapted (${pct(c.taken, merged.length)} as written). ${pct(c.declined, merged.length)} were declined.`
    : 'No suggestions on merged PRs in this window.'
  return {
    ...(channel ? { channel } : {}),
    text: `${title}: ${merged.length ? `${pct(used, merged.length)} taken or adapted` : 'nothing merged'}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${esc(title)}*\n\n${headline}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*By repo*\n${groupLines((r) => r.repo.replace(/^redpanda-data\//, ''))}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*By surface*\n${groupLines((r) => r.surface || 'other')}` } },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: 'Judged from the merged code: taken or adapted means the merged string is the suggestion, or closer to it than to the original. Open PRs are left out.' +
            (runUrl ? ` <${esc(runUrl)}|Full report>` : '')
        }]
      }
    ]
  }
}

// -------------------- GitHub --------------------

function ghJson (args) {
  const r = spawnSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) {
    const err = new Error(`gh api ${args.join(' ')} failed: ${(r.stderr || '').trim()}`)
    err.notFound = /HTTP 404/.test(r.stderr || '')
    throw err
  }
  return JSON.parse(r.stdout)
}

const ghPaged = (path) => ghJson(['--paginate', '--slurp', path]).flat()

function discoverRepos () {
  const items = ghJson(['-X', 'GET', 'search/code', '-f', `q=${CALLER_QUERY}`, '-f', 'per_page=100']).items || []
  return [...new Set(items.map((i) => i.repository.full_name))].filter((r) => r !== SELF).sort()
}

function makeFileReader (repo) {
  const cache = new Map()
  return (path, ref) => {
    const key = `${path}@${ref}`
    if (!cache.has(key)) {
      try {
        const d = ghJson([`repos/${repo}/contents/${encodeURI(path)}?ref=${ref}`])
        cache.set(key, d && d.content ? Buffer.from(d.content, 'base64').toString('utf8') : null)
      } catch (err) {
        if (!err.notFound) throw err
        cache.set(key, null)
      }
    }
    return cache.get(key)
  }
}

function rowsFor (repo, since) {
  const comments = ghPaged(`repos/${repo}/pulls/comments?per_page=100&sort=created&direction=desc&since=${since}T00:00:00Z`)
  const replies = new Map()
  for (const c of comments) if (c.in_reply_to_id) replies.set(c.in_reply_to_id, (replies.get(c.in_reply_to_id) || 0) + 1)
  const ours = comments.filter((c) => c.user && c.user.type === 'Bot' && MARKER.test(c.body || '') && extractSuggestion(c.body) != null)
  const readFile = makeFileReader(repo)
  const prs = new Map()
  const rows = []
  for (const c of ours) {
    const num = Number(c.pull_request_url.split('/').pop())
    if (!prs.has(num)) prs.set(num, ghJson([`repos/${repo}/pulls/${num}`]))
    const pr = prs.get(num)
    // original_* is the position in the commit the comment was posted on;
    // line/start_line go null once a later push makes the comment outdated.
    const end = c.original_line || c.line
    const start = c.original_start_line || c.start_line || end
    const ref = c.original_commit_id || c.commit_id
    const atPost = start && end && ref ? readFile(c.path, ref) : null
    const original = atPost ? atPost.split('\n').slice(start - 1, end).join('\n') : ''
    let outcome
    if (pr.merged_at) outcome = classify({ suggestion: extractSuggestion(c.body), original, final: readFile(c.path, pr.merge_commit_sha) })
    else outcome = pr.state === 'closed' ? 'closed' : 'open'
    const firstQuoted = nonEmptyLines(original).find((l) => l.includes('"')) || nonEmptyLines(original)[0] || ''
    rows.push({
      repo,
      pr: num,
      path: c.path,
      surface: routeFile(c.path),
      // A digest, not the text: the rows are uploaded as an artifact in this
      // public repo, and the line comes from a private caller's PR.
      decl: crypto.createHash('sha256').update(firstQuoted).digest('hex').slice(0, 16),
      created: c.created_at,
      outcome,
      replies: replies.get(c.id) || 0,
      author: pr.user && pr.user.login,
      url: c.html_url
    })
  }
  return rows
}

function parseArgs (argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--since') opts.since = argv[++i]
    else if (a === '--repos') opts.repos = argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--summary') opts.summary = argv[++i]
    else if (a === '--json') opts.json = argv[++i]
    else if (a === '--slack') opts.slack = argv[++i]
    else if (a === '--slack-channel') opts.slackChannel = argv[++i]
    else throw new Error(`Unknown argument: ${a}`)
  }
  return opts
}

function main (argv) {
  const opts = parseArgs(argv)
  const until = new Date().toISOString().slice(0, 10)
  const since = opts.since || new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`--since must be YYYY-MM-DD, got ${since}`)
  const repos = opts.repos || discoverRepos()
  if (!repos.length) throw new Error('No repo calls doc-strings-review.yml (code search found none); pass --repos to report specific ones.')
  const rows = repos.flatMap((repo) => rowsFor(repo, since))
  const md = formatMarkdown(rows, { since, until })
  if (opts.summary) fs.writeFileSync(opts.summary, md + '\n', { flag: 'a' })
  else process.stdout.write(md + '\n')
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(rows, null, 2))
  if (opts.slack) {
    const runUrl = process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : ''
    fs.writeFileSync(opts.slack, JSON.stringify(formatSlack(rows, { since, until, runUrl, channel: opts.slackChannel })))
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}

module.exports = { extractSuggestion, similarity, classify, count, perDeclaration, formatMarkdown, formatSlack, MERGED }
