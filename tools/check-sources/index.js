'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

/**
 * doc-tools check-sources: prove that the sources a page cites still say what
 * the page claims.
 *
 * Convention: an AsciiDoc line comment directly above a claim,
 *
 *   // Source: <ref> ["<short exact quote>"]
 *
 * The marker is case-insensitive (`// source:` works too), and a
 * parenthesised aside before the colon is allowed:
 * `// Source (verified 2026-10-20): ...`. <ref> is one of
 *
 *   redpanda-data/<repo>[@<git-ref>]:<path>:<line>[-<line>]   (default ref: the repo's default branch)
 *   redpanda-data/<repo>#<pr-number>
 *   a Jira key such as DOC-1234
 *   an https:// URL
 *
 * File refs are fetched from GitHub: the line range must exist and, when a
 * quote is given, the quote must appear in that range after whitespace
 * normalisation. PR refs must exist; their state is reported as info. Jira
 * keys and URLs are checked for syntax only (URLs can be HEAD-checked with
 * --check-urls). A fetch that fails for auth or network reasons is reported
 * as `unreachable`, a warning, never a silent pass.
 *
 * Text after the marker that does not start with a ref is free-form
 * provenance prose: an `unchecked-note` (info), counted in the summary and
 * never an error. Text that starts with a ref is parsed strictly: the ref, an
 * optional quote, nothing else. The one exception is an https URL followed by
 * prose, which is a note, because vendor docs are often cited that way and
 * URL refs are syntax-only anyway.
 */

const OWNER = 'redpanda-data'

// Finding classes. Severity is fixed per class so the exit code is predictable.
const SEVERITY = Object.freeze({
  malformed: 'error',
  'missing-file': 'error',
  'line-out-of-range': 'error',
  'quote-not-found': 'error',
  'pr-not-found': 'error',
  'url-not-found': 'error',
  unreachable: 'warning',
  'no-claim': 'warning',
  'pr-state': 'info',
  'quote-not-checked': 'info',
  'syntax-only': 'info',
  'unchecked-note': 'info'
})

// `// Source:` or `// Source (aside):`, any case. The aside is kept but never parsed.
const SOURCE_LINE_RE = /^\s*\/\/\s*source\s*(?::|\((.*?)\)\s*:)(.*)$/i
// `// Source (` without a `):` to close the aside is still provenance prose.
const SOURCE_ASIDE_RE = /^\s*\/\/\s*source\s*\(/i
const isSourceLine = (line) => SOURCE_LINE_RE.test(line) || SOURCE_ASIDE_RE.test(line)
const REPO_RE = '[A-Za-z0-9._-]+'
const FILE_REF_RE = new RegExp(`^([A-Za-z0-9._-]+)/(${REPO_RE})(?:@([^\\s:]+))?:([^\\s:]+):(\\d+)(?:-(\\d+))?$`)
const PR_REF_RE = new RegExp(`^([A-Za-z0-9._-]+)/(${REPO_RE})#(\\d+)$`)
const JIRA_RE = /^[A-Z][A-Z0-9]+-\d+$/

/**
 * Does this first token claim to be a ref? If so it is parsed strictly and a
 * bad one is an error; if not, the comment is a free-form note. Paths without
 * an owner/repo (`apps/ui/x.tsx:12`), bare `repo#n`, and prose are notes.
 */
function looksLikeRef (token) {
  if (/^redpanda-data\//i.test(token)) return true
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+$/.test(token)) return true
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:@[^\s:]+)?:[^\s:]+:\d/.test(token)) return true
  if (/^[A-Za-z][A-Za-z0-9]+-\d+$/.test(token)) return true
  return /^https?:\/\//i.test(token)
}

/**
 * Parse the text after the `// Source:` marker. Returns { ref, quote } for a
 * machine-readable ref, { note } for free-form prose, or { error } describing
 * why a ref is malformed.
 */
function parseSourceComment (rest) {
  const text = rest.trim()
  if (!text) return { error: 'empty source comment: expected `// Source: <ref> ["<quote>"]`' }

  let refText = text
  let quote = null
  const space = text.search(/\s/)
  if (space !== -1) refText = text.slice(0, space)
  if (!looksLikeRef(refText)) return { note: text }
  if (space !== -1) {
    const tail = text.slice(space).trim()
    if (!(tail.length >= 2 && tail.startsWith('"') && tail.endsWith('"'))) {
      // A URL inside prose is a citation, not a ref: its quote is never checked anyway.
      if (/^https:\/\//i.test(refText)) return { note: text }
      return { error: `unexpected text after the ref: ${JSON.stringify(tail)}. A ref takes only an optional quote, wrapped in double quotes, at the end of the line; put prose on its own comment line` }
    }
    quote = tail.slice(1, -1)
    if (!quote.trim()) return { error: 'empty quote' }
  }

  const ref = parseRef(refText)
  if (ref.error) return ref
  return { ref, quote }
}

function parseRef (refText) {
  let m = FILE_REF_RE.exec(refText)
  if (m) {
    const [, owner, repo, gitRef, filePath, start, end] = m
    if (owner !== OWNER) return { error: `owner must be ${OWNER}, got ${owner}` }
    const startLine = Number(start)
    const endLine = end === undefined ? startLine : Number(end)
    if (startLine < 1) return { error: `line numbers start at 1: ${refText}` }
    if (endLine < startLine) return { error: `line range ends before it starts: ${refText}` }
    return { kind: 'file', text: refText, owner, repo, gitRef: gitRef || null, path: filePath, startLine, endLine }
  }
  m = PR_REF_RE.exec(refText)
  if (m) {
    const [, owner, repo, number] = m
    if (owner !== OWNER) return { error: `owner must be ${OWNER}, got ${owner}` }
    return { kind: 'pr', text: refText, owner, repo, number: Number(number) }
  }
  if (JIRA_RE.test(refText)) return { kind: 'jira', text: refText, key: refText }
  if (/^https:\/\//.test(refText)) {
    try {
      const url = new URL(refText)
      if (!url.hostname.includes('.')) return { error: `not a valid https URL: ${refText}` }
      return { kind: 'url', text: refText, url: url.toString() }
    } catch {
      return { error: `not a valid https URL: ${refText}` }
    }
  }
  if (/^http:\/\//.test(refText)) return { error: `URLs must use https: ${refText}` }
  return {
    error: `unrecognised ref ${JSON.stringify(refText)}: expected redpanda-data/<repo>[@<ref>]:<path>:<line>[-<line>], redpanda-data/<repo>#<pr>, a Jira key, or an https:// URL`
  }
}

/**
 * Find every `// Source:` comment (any case) in an AsciiDoc document. Comments inside
 * delimited listing, literal, passthrough, or comment blocks are content, not
 * source annotations, and are skipped.
 */
function extractSources (content) {
  const lines = content.split(/\r?\n/)
  const out = []
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    const delim = /^(-{4,}|\.{4,}|\+{4,}|\/{4,}|`{3}.*)$/.exec(trimmed)
    if (delim) {
      const marker = trimmed.startsWith('```') ? '```' : trimmed
      if (fence === null) { fence = marker; continue }
      if (fence === marker) { fence = null; continue }
    }
    if (fence !== null) continue
    if (!isSourceLine(line)) continue
    const m = SOURCE_LINE_RE.exec(line)
    // An aside that never closes with `):`, or `// Source (aside):` with nothing
    // after the colon (the prose is on the next comment lines), is a note.
    // A bare empty `// Source:` is malformed.
    let parsed
    if (!m) parsed = { note: line.trim().replace(/^\/\/\s*/, '') }
    else if (m[1] !== undefined && !m[2].trim()) parsed = { note: `(${m[1]})` }
    else parsed = parseSourceComment(m[2])
    // The claim is the first line below the stacked source comments.
    let j = i + 1
    while (j < lines.length && isSourceLine(lines[j])) j++
    const claimLine = j < lines.length && lines[j].trim() !== '' && !/^\s*\/\//.test(lines[j]) ? j + 1 : null
    out.push({ line: i + 1, raw: line.trim(), claimLine, ...parsed })
  }
  return out
}

const normalise = (s) => s.replace(/\s+/g, ' ').trim()

/** Split fetched file text into lines; a trailing newline does not add a line. */
function splitLines (text) {
  const lines = text.split(/\r?\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Find the line numbers where a quote starts, searching the whole file.
 * Used only to hint where a quote that left its cited range went.
 */
function locateQuote (lines, quote, maxSpan = 10) {
  const q = normalise(quote)
  const hits = []
  for (let i = 0; i < lines.length; i++) {
    for (let span = 1; span <= maxSpan && i + span <= lines.length; span++) {
      const window = normalise(lines.slice(i, i + span).join('\n'))
      if (window.includes(q)) {
        hits.push({ start: i + 1, end: i + span })
        break
      }
    }
  }
  // Keep only minimal windows: drop a hit that contains a tighter one.
  return hits.filter((h) => !hits.some((g) => g !== h && g.start >= h.start && g.end <= h.end && (g.start > h.start || g.end < h.end)))
}

// --------------------------------------------------------------------
// GitHub client
// --------------------------------------------------------------------

function resolveToken () {
  const { getGitHubApiToken } = require('../../cli-utils/github-token')
  const token = getGitHubApiToken()
  if (token) return token
  try {
    const gh = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 10000 })
    if (gh.status === 0 && gh.stdout.trim()) return gh.stdout.trim()
  } catch {
    // gh not installed: fall through to unauthenticated
  }
  return null
}

/**
 * A minimal GitHub REST client. Every method resolves to
 * { status: 'ok', ... } | { status: 'missing', reason } | { status: 'unreachable', reason }
 * and never throws, so the checker can classify every outcome.
 */
function createGitHubClient ({ token = resolveToken(), fetchImpl = globalThis.fetch, apiBase = 'https://api.github.com' } = {}) {
  const headers = (accept) => ({
    Accept: accept,
    'User-Agent': 'redpanda-docs-tools',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  })

  async function request (url, accept = 'application/vnd.github+json') {
    try {
      const res = await fetchImpl(url, { headers: headers(accept) })
      return { res }
    } catch (err) {
      return { networkError: err.message || String(err) }
    }
  }

  function failure (res, what) {
    const auth = token ? 'authenticated' : 'unauthenticated (set ACTIONS_BOT_TOKEN or GITHUB_TOKEN, or run gh auth login)'
    if (res.status === 401) return { status: 'unreachable', reason: `${what}: HTTP 401, token rejected` }
    if (res.status === 403 || res.status === 429) return { status: 'unreachable', reason: `${what}: HTTP ${res.status} (rate limit or permission), ${auth}` }
    return { status: 'unreachable', reason: `${what}: HTTP ${res.status}, ${auth}` }
  }

  const repoCache = new Map()
  async function repoVisible (owner, repo) {
    const key = `${owner}/${repo}`
    if (!repoCache.has(key)) {
      repoCache.set(key, (async () => {
        const { res, networkError } = await request(`${apiBase}/repos/${owner}/${repo}`)
        if (networkError) return { status: 'unreachable', reason: `${key}: ${networkError}` }
        if (res.ok) return { status: 'ok' }
        if (res.status === 404) {
          return {
            status: 'unreachable',
            reason: `${key}: repository not found or not visible to this ${token ? 'token' : 'unauthenticated client (set ACTIONS_BOT_TOKEN or GITHUB_TOKEN, or run gh auth login)'}`
          }
        }
        return failure(res, key)
      })())
    }
    return repoCache.get(key)
  }

  return {
    authenticated: Boolean(token),

    async getFile ({ owner, repo, ref, path: filePath }) {
      const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : ''
      const what = `${owner}/${repo}${ref ? '@' + ref : ''}:${filePath}`
      const { res, networkError } = await request(`${apiBase}/repos/${owner}/${repo}/contents/${encodedPath}${query}`, 'application/vnd.github.raw+json')
      if (networkError) return { status: 'unreachable', reason: `${what}: ${networkError}` }
      if (res.ok) {
        const text = await res.text()
        // A directory path returns a JSON listing, not file content.
        if (/^\s*\[/.test(text) && (res.headers.get('content-type') || '').includes('json')) {
          return { status: 'missing', reason: `${what} is a directory` }
        }
        return { status: 'ok', text }
      }
      if (res.status === 404) {
        // A private repo answers 404 to a client that cannot see it, so a 404
        // only means "missing file" once the repo itself is visible.
        const visible = await repoVisible(owner, repo)
        if (visible.status !== 'ok') return visible
        if (ref) {
          const refCheck = await request(`${apiBase}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`)
          if (refCheck.res && (refCheck.res.status === 404 || refCheck.res.status === 422)) {
            return { status: 'missing', reason: `ref ${ref} does not exist in ${owner}/${repo}` }
          }
        }
        return { status: 'missing', reason: `${filePath} does not exist in ${owner}/${repo}${ref ? ' at ' + ref : ' on the default branch'}` }
      }
      return failure(res, what)
    },

    async getPull ({ owner, repo, number }) {
      const what = `${owner}/${repo}#${number}`
      const { res, networkError } = await request(`${apiBase}/repos/${owner}/${repo}/pulls/${number}`)
      if (networkError) return { status: 'unreachable', reason: `${what}: ${networkError}` }
      if (res.ok) {
        const pr = await res.json()
        return { status: 'ok', state: pr.merged_at ? 'merged' : pr.state, title: pr.title }
      }
      if (res.status === 404) {
        const visible = await repoVisible(owner, repo)
        if (visible.status !== 'ok') return visible
        return { status: 'missing', reason: `${what} does not exist` }
      }
      return failure(res, what)
    },

    async headUrl (url) {
      try {
        const res = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'redpanda-docs-tools' } })
        if (res.ok) return { status: 'ok', code: res.status }
        if (res.status === 404 || res.status === 410) return { status: 'missing', reason: `HTTP ${res.status}` }
        return { status: 'unreachable', reason: `HTTP ${res.status}` }
      } catch (err) {
        return { status: 'unreachable', reason: err.message || String(err) }
      }
    }
  }
}

// --------------------------------------------------------------------
// Checker
// --------------------------------------------------------------------

/**
 * Check every source comment in the given files.
 *
 * @param {object} opts
 * @param {string[]} opts.files - Paths to .adoc files (absolute or relative to root)
 * @param {string} [opts.root] - Directory paths are reported relative to
 * @param {object} opts.client - GitHub client (see createGitHubClient)
 * @param {boolean} [opts.checkUrls] - HEAD-check https URLs
 * @returns {Promise<{files: number, sources: number, findings: object[], summary: {checked: number, failed: number, notes: number, errors: number, warnings: number, info: number}, fetches: number}>}
 */
async function checkSources ({ files, root = process.cwd(), client, checkUrls = false }) {
  const findings = []
  const fileCache = new Map()
  const prCache = new Map()
  const urlCache = new Map()
  let fetches = 0
  let sources = 0
  let checked = 0
  let notes = 0

  const add = (rule, where, message, extra = {}) => findings.push({ rule, severity: SEVERITY[rule], ...where, message, ...extra })

  const fetchFile = (ref) => {
    const key = `${ref.owner}/${ref.repo}@${ref.gitRef || ''}:${ref.path}`
    if (!fileCache.has(key)) {
      fetches++
      fileCache.set(key, client.getFile({ owner: ref.owner, repo: ref.repo, ref: ref.gitRef, path: ref.path }))
    }
    return fileCache.get(key)
  }

  for (const file of files) {
    const abs = path.resolve(root, file)
    const rel = path.relative(root, abs) || file
    const content = fs.readFileSync(abs, 'utf8')
    for (const entry of extractSources(content)) {
      sources++
      const where = { file: rel, line: entry.line, source: entry.raw }
      if (entry.note !== undefined) { notes++; add('unchecked-note', where, 'free-form note, not checked: start the comment with a ref to have it verified'); continue }
      checked++
      if (entry.error) { add('malformed', where, entry.error); continue }
      if (entry.claimLine === null) add('no-claim', where, 'no claim directly below this source comment (next line is blank, another comment, or the end of the file)')
      const { ref, quote } = entry

      if (ref.kind === 'file') {
        const got = await fetchFile(ref)
        if (got.status === 'unreachable') { add('unreachable', where, got.reason); continue }
        if (got.status === 'missing') { add('missing-file', where, got.reason); continue }
        const lines = splitLines(got.text)
        if (ref.endLine > lines.length) {
          add('line-out-of-range', where, `${ref.path} has ${lines.length} lines; cited ${ref.startLine === ref.endLine ? 'line ' + ref.startLine : 'lines ' + ref.startLine + '-' + ref.endLine}`)
          continue
        }
        if (quote !== null) {
          const range = normalise(lines.slice(ref.startLine - 1, ref.endLine).join('\n'))
          if (!range.includes(normalise(quote))) {
            const hits = locateQuote(lines, quote)
            const hint = hits.length
              ? ` It now appears at ${hits.slice(0, 3).map((h) => h.start === h.end ? `line ${h.start}` : `lines ${h.start}-${h.end}`).join(', ')}${hits.length > 3 ? ` and ${hits.length - 3} more` : ''}.`
              : ' It does not appear anywhere in the file.'
            add('quote-not-found', where, `quote not found in ${ref.path} ${ref.startLine === ref.endLine ? 'line ' + ref.startLine : 'lines ' + ref.startLine + '-' + ref.endLine}.${hint}`, { movedTo: hits })
          }
        }
        continue
      }

      if (quote !== null) add('quote-not-checked', where, `quotes are only verified for file refs; not checked for a ${ref.kind === 'pr' ? 'PR' : ref.kind === 'jira' ? 'Jira' : 'URL'} ref`)

      if (ref.kind === 'pr') {
        const key = `${ref.owner}/${ref.repo}#${ref.number}`
        if (!prCache.has(key)) { fetches++; prCache.set(key, client.getPull(ref)) }
        const got = await prCache.get(key)
        if (got.status === 'unreachable') add('unreachable', where, got.reason)
        else if (got.status === 'missing') add('pr-not-found', where, got.reason)
        else add('pr-state', where, `${key} is ${got.state}`, { state: got.state })
      } else if (ref.kind === 'jira') {
        add('syntax-only', where, `Jira key ${ref.key}: syntax checked, not looked up`)
      } else if (ref.kind === 'url') {
        if (!checkUrls) {
          add('syntax-only', where, 'URL syntax checked, not fetched (use --check-urls to HEAD-check it)')
        } else {
          if (!urlCache.has(ref.url)) { fetches++; urlCache.set(ref.url, client.headUrl(ref.url)) }
          const got = await urlCache.get(ref.url)
          if (got.status === 'unreachable') add('unreachable', where, `${ref.url}: ${got.reason}`)
          else if (got.status === 'missing') add('url-not-found', where, `${ref.url}: ${got.reason}`)
        }
      }
    }
  }

  const count = (sev) => findings.filter((f) => f.severity === sev).length
  // A comment fails when it has at least one error; count comments, not findings.
  const failed = new Set(findings.filter((f) => f.severity === 'error').map((f) => `${f.file}:${f.line}`)).size
  return {
    files: files.length,
    sources,
    fetches,
    authenticated: Boolean(client.authenticated),
    findings,
    summary: { checked, failed, notes, errors: count('error'), warnings: count('warning'), info: count('info') }
  }
}

// --------------------------------------------------------------------
// File selection
// --------------------------------------------------------------------

function gitChangedAdoc (root, base) {
  const res = spawnSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`, '--', '*.adoc'], { cwd: root, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git diff against ${base} failed: ${(res.stderr || '').trim() || 'exit ' + res.status}`)
  return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}

function selectFiles ({ root, files, diff }) {
  const { globSync } = require('glob')
  let selected
  if (diff) {
    selected = gitChangedAdoc(root, diff)
    if (files && files.length) {
      const micromatch = require('micromatch')
      selected = selected.filter((f) => micromatch.isMatch(f, files))
    }
  } else {
    const patterns = files && files.length ? files : ['modules/**/*.adoc']
    selected = globSync(patterns, { cwd: root, nodir: true, ignore: ['**/node_modules/**'] })
  }
  return [...new Set(selected)].filter((f) => f.endsWith('.adoc') && fs.existsSync(path.resolve(root, f))).sort()
}

// --------------------------------------------------------------------
// Output
// --------------------------------------------------------------------

function formatHuman (result) {
  const out = []
  const order = { error: 0, warning: 1, info: 2 }
  const sorted = [...result.findings].sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line)
  for (const f of sorted) {
    out.push(`${f.severity.toUpperCase().padEnd(7)} ${f.file}:${f.line} [${f.rule}] ${f.message}`)
    out.push(`        ${f.source}`)
  }
  if (sorted.length) out.push('')
  const { checked, failed, notes, errors, warnings, info } = result.summary
  out.push(`check-sources: ${result.sources} source comment(s) in ${result.files} file(s): ${checked} checked, ${failed} failed, ${notes} unchecked note(s); ${result.fetches} fetch(es)${result.authenticated ? '' : ' (unauthenticated)'}: ${errors} error(s), ${warnings} warning(s), ${info} info`)
  return out.join('\n')
}

function splitList (values) {
  if (!values) return []
  return [].concat(values).flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean)
}

async function runCli (options, { client } = {}) {
  let result
  try {
    const root = path.resolve(options.root || process.cwd())
    const files = selectFiles({ root, files: splitList(options.files), diff: options.diff })
    result = await checkSources({ files, root, client: client || createGitHubClient(), checkUrls: Boolean(options.checkUrls) })
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exitCode = 2
    return
  }
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true })
    fs.writeFileSync(path.resolve(options.output), JSON.stringify(result, null, 2) + '\n')
  }
  console.log(options.format === 'json' ? JSON.stringify(result, null, 2) : formatHuman(result))
  process.exitCode = result.summary.errors > 0 ? 1 : 0
}

module.exports = {
  SEVERITY,
  parseSourceComment,
  parseRef,
  extractSources,
  locateQuote,
  checkSources,
  createGitHubClient,
  selectFiles,
  formatHuman,
  runCli
}
