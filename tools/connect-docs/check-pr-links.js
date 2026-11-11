'use strict'

const fs = require('fs')
const { checkUrl, runWithConcurrency } = require('../../extensions/external-link-checker')

/**
 * Advisory external-link check for a connect PR: fetches the URLs the PR adds
 * in doc-string sources (Go files and AsciiDoc), not the whole site. The
 * weekly docs-site link check catches the rest, but only after the PR merged.
 *
 * Classification is the external-link-checker extension's (checkUrl): HEAD
 * with a GET fallback, 404 and 410 are broken, and everything else that
 * fails (401, 403, 429, 5xx, timeouts) could not be checked. A browser-like
 * user agent keeps bot walls from answering 403 to everything.
 *
 * Usage: node check-pr-links.js --diff pr.diff [--output link-check.json] [--summary link-check.md]
 *
 * Prints a ::warning annotation, with file and line, for each broken URL.
 * Always exits 0 on a completed check: it never fails the job.
 */

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const CONCURRENCY = 4
const TIMEOUT_MS = 10000

const URL_RX = /https?:\/\/[^\s\][)("'<>`\\]+/g
const TRAILING_PUNCT_RX = /[.,;:!?*_]+$/
// Format verbs, attribute references, and template variables: not a URL
// anyone can fetch as written.
const PLACEHOLDER_RX = /%[sdvqx]|[{}$]/
const UNFETCHABLE_HOST_RX = /^(?:localhost|[\d.]+|\[.*\]|(?:.+\.)?example\.(?:com|org|net))$/

function isDocSource (file) {
  return (file.endsWith('.go') && !file.endsWith('_test.go')) || file.endsWith('.adoc')
}

function fetchable (url) {
  if (PLACEHOLDER_RX.test(url)) return false
  try {
    const { hostname } = new URL(url)
    return hostname.includes('.') && !UNFETCHABLE_HOST_RX.test(hostname)
  } catch {
    return false
  }
}

/**
 * Whether the end of a Go source line prefix sits inside a double-quoted
 * string literal. Raw strings and escapes are tracked; a line is assumed to
 * start outside any string.
 */
function inGoQuotedString (prefix) {
  let quote = null
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i]
    if (quote === '"' && c === '\\') i++
    else if (quote && c === quote) quote = null
    else if (!quote && (c === '"' || c === '`')) quote = c
  }
  return quote === '"'
}

/**
 * The URLs on lines a unified diff adds, in doc-string sources only, with the
 * file and new-side line number of each. Removed and context lines, and line
 * comments, are skipped.
 */
function extractAddedUrls (diff) {
  const found = []
  let file = null
  let line = 0
  let inHunk = false
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) {
      file = null
      inHunk = false
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      line = Number(hunk[1])
      inHunk = true
      continue
    }
    if (!inHunk) {
      if (text.startsWith('+++ ')) {
        const target = text.slice(4).trim()
        file = target === '/dev/null' ? null : target.replace(/^b\//, '')
      }
      continue
    }
    if (text.startsWith('+')) {
      const content = text.slice(1)
      if (file && isDocSource(file) && !/^\s*\/\//.test(content)) {
        for (const match of content.matchAll(URL_RX)) {
          // Right after a backtick is inline code (`https://ORG-ACCOUNT...`),
          // a value to type rather than a link. In Go, only a backtick inside
          // a double-quoted string is inline code: any other opens a raw
          // string, whose URL is still checked.
          if (content[match.index - 1] === '`' &&
            (!file.endsWith('.go') || inGoQuotedString(content.slice(0, match.index - 1)))) continue
          const url = match[0].replace(TRAILING_PUNCT_RX, '')
          if (fetchable(url)) found.push({ url, file, line })
        }
      }
      line++
    } else if (text.startsWith(' ')) {
      line++
    }
  }
  return found
}

async function checkLinks (found, { fetchFn } = {}) {
  const byUrl = new Map()
  for (const f of found) {
    if (!byUrl.has(f.url)) byUrl.set(f.url, [])
    byUrl.get(f.url).push({ file: f.file, line: f.line })
  }
  const results = []
  await runWithConcurrency([...byUrl.keys()], CONCURRENCY, async (url) => {
    const opts = { timeout: TIMEOUT_MS, userAgent: USER_AGENT }
    if (fetchFn) opts.fetchFn = fetchFn
    const verdict = await checkUrl(url, opts)
    results.push({ url, ...verdict, locations: byUrl.get(url) })
  })
  results.sort((a, b) => a.url.localeCompare(b.url))
  const of = (c) => results.filter((r) => r.classification === c)
  return { checked: results.length, ok: of('ok').length, broken: of('broken'), unverifiable: of('unverifiable') }
}

const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C')

function annotations (report) {
  return report.broken.flatMap((r) => r.locations.map((l) =>
    `::warning file=${escapeProperty(l.file)},line=${l.line}::${escapeData(`Broken link ${r.url} (HTTP ${r.status}). Advisory: this does not fail the check.`)}`))
}

function summary (report) {
  const lines = ['## External links this PR adds', '',
    `Checked ${report.checked} ${report.checked === 1 ? 'URL' : 'URLs'}: ${report.ok} ok, ${report.broken.length} broken (404 or 410), ${report.unverifiable.length} couldn't check. Advisory only.`]
  const list = (title, rows) => {
    if (!rows.length) return
    lines.push('', title, '')
    for (const r of rows) {
      const why = r.status ? `HTTP ${r.status}` : r.reason
      lines.push(`- ${r.url} (${why}): ${r.locations.map((l) => `${l.file}:${l.line}`).join(', ')}`)
    }
  }
  list('Broken:', report.broken)
  list('Couldn\'t check (bot walls, rate limits, server errors, and timeouts are not counted as broken):', report.unverifiable)
  return lines.join('\n') + '\n'
}

function parseArgs (argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(diff|output|summary)$/.exec(argv[i])
    if (!m) throw new Error(`unknown argument: ${argv[i]}`)
    opts[m[1]] = argv[++i]
  }
  if (!opts.diff) throw new Error('--diff is required')
  return opts
}

async function runCli (argv, { fetchFn, log = (s) => process.stdout.write(s + '\n') } = {}) {
  const opts = parseArgs(argv)
  const report = await checkLinks(extractAddedUrls(fs.readFileSync(opts.diff, 'utf8')), { fetchFn })
  for (const a of annotations(report)) log(a)
  if (opts.output) fs.writeFileSync(opts.output, JSON.stringify(report, null, 2) + '\n')
  const md = summary(report)
  if (opts.summary) fs.writeFileSync(opts.summary, md)
  else log(md)
  return report
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch((err) => {
    console.error(`Error: ${err.message}`)
    process.exit(2)
  })
}

module.exports = { USER_AGENT, extractAddedUrls, checkLinks, annotations, summary, runCli }
