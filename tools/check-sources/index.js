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
 * parenthesized aside before the colon is allowed:
 * `// Source (verified 2026-10-20): ...`. <ref> is one of
 *
 *   redpanda-data/<repo>[@<git-ref>]:<path>:<line>[-<line>]   (default ref: the repo's default branch)
 *   redpanda-data/<repo>#<number>   (a pull request or an issue)
 *   a Jira key such as DOC-1234
 *   an https:// URL
 *
 * File refs are fetched from GitHub: the line range must exist and, when a
 * quote is given, the quote must appear in that range after whitespace
 * normalization. PR and issue refs must exist; their state is reported as info. Jira
 * keys and URLs are checked for syntax only (URLs can be HEAD-checked with
 * --check-urls). A fetch that fails for auth or network reasons is reported
 * as `unreachable`, a warning, never a silent pass. A repo that 404s for a
 * classic token with the `repo` scope is `repo-not-found`, an error: the name
 * is wrong. Any other token may be limited to selected repos, so its 404 is
 * `unreachable`.
 *
 * Text after the marker that does not start with a ref is free-form
 * provenance prose: an `unchecked-note` (info), counted in the summary and
 * never an error. Text that starts with a ref is parsed strictly: the ref, an
 * optional quote, nothing else. The one exception is a syntax-only ref (an
 * https URL or a Jira-style key) followed by prose, which is a note: vendor
 * docs are often cited that way, `KIP-848 consumer group protocol` reads as a
 * key, and neither kind is looked up anyway.
 */

const OWNER = 'redpanda-data'

// Finding classes. Severity is fixed per class so the exit code is predictable.
const SEVERITY = Object.freeze({
  malformed: 'error',
  'missing-file': 'error',
  'repo-not-found': 'error',
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
  if (JIRA_RE.test(token)) return true
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
      // A URL or a Jira-style key inside prose is a citation, not a ref: neither
      // is looked up, so there is nothing to verify (`KIP-848 consumer group protocol`).
      if (/^https:\/\//i.test(refText) || JIRA_RE.test(refText)) return { note: text }
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
    error: `unrecognized ref ${JSON.stringify(refText)}: expected redpanda-data/<repo>[@<ref>]:<path>:<line>[-<line>], redpanda-data/<repo>#<pr>, a Jira key, or an https:// URL`
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

const normalize = (s) => s.replace(/\s+/g, ' ').trim()

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
  const q = normalize(quote)
  const hits = []
  for (let i = 0; i < lines.length; i++) {
    for (let span = 1; span <= maxSpan && i + span <= lines.length; span++) {
      const window = normalize(lines.slice(i, i + span).join('\n'))
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
 * { status: 'ok', ... } | { status: 'missing', reason[, repoMissing] } | { status: 'unreachable', reason }
 * and never throws, so the checker can classify every outcome.
 *
 * Why not cli-utils/octokit-client.js: that is a singleton built at require
 * time (no injectable fetch for tests, no `gh auth token` fallback), it throws
 * on every non-2xx where this checker needs a classified answer, and its
 * `retry` option is inert because @octokit/plugin-retry is never applied. So
 * this client does its own retries: up to `retries` more attempts on a network
 * error, a timeout, a 5xx, or a secondary rate limit (403/429 with a
 * Retry-After of at most a minute). An exhausted primary rate limit is not
 * retried: its reset can be an hour away.
 */
function createGitHubClient ({
  token = resolveToken(),
  fetchImpl = globalThis.fetch,
  apiBase = 'https://api.github.com',
  timeoutMs = 30000,
  retries = 2,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const headers = (accept) => ({
    Accept: accept,
    'User-Agent': 'redpanda-docs-tools',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  })

  // Seconds to wait before retrying this response, or null when it is final.
  function retryDelay (res, attempt) {
    if (res.status >= 500) return 2 ** attempt
    if (res.status === 403 || res.status === 429) {
      const after = Number.parseInt(res.headers.get('retry-after') || '', 10)
      if (Number.isFinite(after) && after >= 0 && after <= 60) return after
    }
    return null
  }

  async function send (url, init) {
    for (let attempt = 0; ; attempt++) {
      let res
      try {
        res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      } catch (err) {
        const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
        const message = timedOut ? `no response within ${timeoutMs / 1000}s` : (err.message || String(err))
        if (attempt < retries) { await sleep(1000 * 2 ** attempt); continue }
        return { networkError: message }
      }
      const delay = attempt < retries ? retryDelay(res, attempt) : null
      if (delay === null) return { res }
      await sleep(delay * 1000)
    }
  }

  const request = (url, accept = 'application/vnd.github+json') => send(url, { headers: headers(accept) })

  function failure (res, what) {
    const auth = token ? 'authenticated' : 'unauthenticated (set ACTIONS_BOT_TOKEN or GITHUB_TOKEN, or run gh auth login)'
    if (res.status === 401) return { status: 'unreachable', reason: `${what}: HTTP 401, token rejected` }
    if (res.status === 403 || res.status === 429) return { status: 'unreachable', reason: `${what}: HTTP ${res.status} (rate limit or permission), ${auth}` }
    return { status: 'unreachable', reason: `${what}: HTTP ${res.status}, ${auth}` }
  }

  // Only a classic token with the `repo` scope (GitHub lists it in the
  // X-OAuth-Scopes header) reads every private repo its owner can. A
  // fine-grained PAT or an app installation token may be limited to selected
  // repos, so a 404 for it could be a real private repo outside that set.
  const hasRepoScope = (res) => (res.headers.get('x-oauth-scopes') || '').split(',').some((s) => s.trim() === 'repo')

  const repoCache = new Map()
  async function repoVisible (owner, repo) {
    const key = `${owner}/${repo}`
    if (!repoCache.has(key)) {
      repoCache.set(key, (async () => {
        const { res, networkError } = await request(`${apiBase}/repos/${owner}/${repo}`)
        if (networkError) return { status: 'unreachable', reason: `${key}: ${networkError}` }
        if (res.ok) return { status: 'ok' }
        if (res.status === 404) {
          if (token && hasRepoScope(res)) {
            return { status: 'missing', repoMissing: true, reason: `${key}: repository does not exist (this token has the repo scope, so the name is wrong, the repo was renamed, or you lack access to it)` }
          }
          return {
            status: 'unreachable',
            reason: `${key}: repository not found or not visible to this ${token ? 'token, which may be limited to selected repositories' : 'unauthenticated client (set ACTIONS_BOT_TOKEN or GITHUB_TOKEN, or run gh auth login)'}`
          }
        }
        return failure(res, key)
      })())
    }
    return repoCache.get(key)
  }

  // A directory path answers with a JSON listing under plain application/json.
  // A raw file answers application/vnd.github.raw+json, so a file whose text
  // starts with `[` (TOML, INI, a top-level JSON array) is never a directory.
  function isDirectoryListing (res, text) {
    if (!/^application\/json\b/i.test(res.headers.get('content-type') || '')) return false
    try {
      const list = JSON.parse(text)
      return Array.isArray(list) && list.every((e) => e && typeof e.type === 'string' && typeof e.path === 'string')
    } catch {
      return false
    }
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
        if (isDirectoryListing(res, text)) return { status: 'missing', reason: `${what} is a directory` }
        return { status: 'ok', text }
      }
      if (res.status === 404) {
        // A private repo answers 404 to a client that cannot see it, so a 404
        // only means "missing file" once the repo itself is visible.
        const visible = await repoVisible(owner, repo)
        if (visible.status !== 'ok') return visible
        if (ref) {
          // Only a definite answer about the ref decides; a rate limit or an
          // outage here is unreachable, never "the file does not exist".
          const refCheck = await request(`${apiBase}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`)
          if (refCheck.networkError) return { status: 'unreachable', reason: `${owner}/${repo}@${ref}: ${refCheck.networkError}` }
          if (refCheck.res.status === 404 || refCheck.res.status === 422) {
            return { status: 'missing', reason: `ref ${ref} does not exist in ${owner}/${repo}` }
          }
          if (!refCheck.res.ok) return failure(refCheck.res, `${owner}/${repo}@${ref}`)
        }
        return { status: 'missing', reason: `${filePath} does not exist in ${owner}/${repo}${ref ? ' at ' + ref : ' on the default branch'}` }
      }
      return failure(res, what)
    },

    // `owner/repo#n` can cite a pull request or an issue: /issues/{n} answers for both.
    async getPull ({ owner, repo, number }) {
      const what = `${owner}/${repo}#${number}`
      const { res, networkError } = await request(`${apiBase}/repos/${owner}/${repo}/issues/${number}`)
      if (networkError) return { status: 'unreachable', reason: `${what}: ${networkError}` }
      if (res.ok) {
        const item = await res.json()
        const pull = item.pull_request
        return { status: 'ok', kind: pull ? 'pr' : 'issue', state: pull && pull.merged_at ? 'merged' : item.state, title: item.title }
      }
      if (res.status === 404 || res.status === 410) {
        const visible = await repoVisible(owner, repo)
        if (visible.status !== 'ok') return visible
        return { status: 'missing', reason: `${what} is not a pull request or issue` }
      }
      return failure(res, what)
    },

    async headUrl (url) {
      const { res, networkError } = await send(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'redpanda-docs-tools' } })
      if (networkError) return { status: 'unreachable', reason: networkError }
      if (res.ok) return { status: 'ok', code: res.status }
      if (res.status === 404 || res.status === 410) return { status: 'missing', reason: `HTTP ${res.status}` }
      return { status: 'unreachable', reason: `HTTP ${res.status}` }
    }
  }
}

// --------------------------------------------------------------------
// Checker
// --------------------------------------------------------------------

/** Run at most `n` of the given async functions at once. */
function createLimiter (n) {
  let active = 0
  const queue = []
  const next = () => {
    if (active >= n || !queue.length) return
    active++
    const { fn, resolve, reject } = queue.shift()
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next() })
  }
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next() })
}

/**
 * Check every source comment in the given files.
 *
 * @param {object} opts
 * @param {string[]} opts.files - Paths to .adoc files (absolute or relative to root)
 * @param {string} [opts.root] - Directory paths are reported relative to
 * @param {object} opts.client - GitHub client (see createGitHubClient)
 * @param {boolean} [opts.checkUrls] - HEAD-check https URLs
 * @param {number} [opts.concurrency] - Fetches in flight at once (default 8)
 * @returns {Promise<{files: number, sources: number, findings: object[], summary: {checked: number, failed: number, notes: number, errors: number, warnings: number, info: number}, fetches: number}>}
 */
async function checkSources ({ files, root = process.cwd(), client, checkUrls = false, concurrency = 8 }) {
  const findings = []
  const limit = createLimiter(Math.max(1, concurrency))
  const fileCache = new Map()
  const prCache = new Map()
  const urlCache = new Map()
  let fetches = 0
  let sources = 0
  let checked = 0
  let notes = 0

  const add = (rule, where, message, extra = {}) => findings.push({ rule, severity: SEVERITY[rule], ...where, message, ...extra })

  const cached = (cache, key, call) => {
    if (!cache.has(key)) { fetches++; cache.set(key, limit(call)) }
    return cache.get(key)
  }
  const fetchFile = (ref) => cached(fileCache, `${ref.owner}/${ref.repo}@${ref.gitRef || ''}:${ref.path}`,
    () => client.getFile({ owner: ref.owner, repo: ref.repo, ref: ref.gitRef, path: ref.path }))
  const fetchPull = (ref) => cached(prCache, `${ref.owner}/${ref.repo}#${ref.number}`, () => client.getPull(ref))
  const fetchUrl = (ref) => cached(urlCache, ref.url, () => client.headUrl(ref.url))

  // Pass 1: parse every page and start every fetch, so independent fetches
  // run concurrently (bounded by `concurrency`) instead of one round trip at a time.
  const items = []
  for (const file of files) {
    const abs = path.resolve(root, file)
    const rel = path.relative(root, abs) || file
    const content = fs.readFileSync(abs, 'utf8')
    for (const entry of extractSources(content)) {
      items.push({ entry, where: { file: rel, line: entry.line, source: entry.raw } })
      const ref = entry.ref
      if (!ref) continue
      if (ref.kind === 'file') fetchFile(ref)
      else if (ref.kind === 'pr') fetchPull(ref)
      else if (ref.kind === 'url' && checkUrls) fetchUrl(ref)
    }
  }

  // Pass 2: report in page order.
  for (const { entry, where } of items) {
    sources++
    if (entry.note !== undefined) { notes++; add('unchecked-note', where, 'free-form note, not checked: start the comment with a ref to have it verified'); continue }
    checked++
    if (entry.error) { add('malformed', where, entry.error); continue }
    if (entry.claimLine === null) add('no-claim', where, 'no claim directly below this source comment (next line is blank, another comment, or the end of the file)')
    const { ref, quote } = entry

    if (ref.kind === 'file') {
      const got = await fetchFile(ref)
      if (got.status === 'unreachable') { add('unreachable', where, got.reason); continue }
      if (got.status === 'missing') { add(got.repoMissing ? 'repo-not-found' : 'missing-file', where, got.reason); continue }
      const lines = splitLines(got.text)
      if (ref.endLine > lines.length) {
        add('line-out-of-range', where, `${ref.path} has ${lines.length} lines; cited ${ref.startLine === ref.endLine ? 'line ' + ref.startLine : 'lines ' + ref.startLine + '-' + ref.endLine}`)
        continue
      }
      if (quote !== null) {
        const range = normalize(lines.slice(ref.startLine - 1, ref.endLine).join('\n'))
        if (!range.includes(normalize(quote))) {
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
      const got = await fetchPull(ref)
      if (got.status === 'unreachable') add('unreachable', where, got.reason)
      else if (got.status === 'missing') add(got.repoMissing ? 'repo-not-found' : 'pr-not-found', where, got.reason)
      else add('pr-state', where, `${key} is ${got.kind === 'issue' ? 'an issue, ' : ''}${got.state}`, { state: got.state, kind: got.kind || 'pr' })
    } else if (ref.kind === 'jira') {
      add('syntax-only', where, `Jira key ${ref.key}: syntax checked, not looked up`)
    } else if (ref.kind === 'url') {
      if (!checkUrls) {
        add('syntax-only', where, 'URL syntax checked, not fetched (use --check-urls to HEAD-check it)')
      } else {
        const got = await fetchUrl(ref)
        if (got.status === 'unreachable') add('unreachable', where, `${ref.url}: ${got.reason}`)
        else if (got.status === 'missing') add('url-not-found', where, `${ref.url}: ${got.reason}`)
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
  // --relative: paths come back relative to --root (and limited to it), not
  // to the repo's top level, so a --root below the top level still matches.
  const res = spawnSync('git', ['diff', '--relative', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`, '--', '*.adoc'], { cwd: root, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git diff against ${base} failed: ${(res.stderr || '').trim() || 'exit ' + res.status}`)
  return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}

/**
 * Pick the .adoc files to check. An explicit --files pattern that matches no
 * .adoc file is an error (exit 2), so a typo or a mangled pattern can never
 * pass by checking nothing. With --diff, the patterns filter the changed
 * files, and an empty result is legitimate (the branch changed no pages).
 */
function selectFiles ({ root, files, diff }) {
  const { globSync } = require('glob')
  const isAdoc = (f) => f.endsWith('.adoc') && fs.existsSync(path.resolve(root, f))
  let selected
  if (diff) {
    selected = gitChangedAdoc(root, diff)
    if (files && files.length) {
      const micromatch = require('micromatch')
      selected = selected.filter((f) => micromatch.isMatch(f, files))
    }
  } else if (files && files.length) {
    selected = []
    for (const pattern of files) {
      const hits = globSync(pattern, { cwd: root, nodir: true, ignore: ['**/node_modules/**'] }).filter(isAdoc)
      if (!hits.length) throw new Error(`--files pattern ${JSON.stringify(pattern)} matched no .adoc files under ${root}`)
      selected.push(...hits)
    }
  } else {
    selected = globSync('modules/**/*.adoc', { cwd: root, nodir: true, ignore: ['**/node_modules/**'] })
  }
  return [...new Set(selected)].filter(isAdoc).sort()
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

/**
 * Flatten --files values (repeatable, each comma-separated) into patterns.
 * Commas inside `{...}` belong to a brace pattern and do not split it.
 */
function splitList (values) {
  if (!values) return []
  const out = []
  for (const value of [].concat(values)) {
    let depth = 0
    let current = ''
    for (const ch of String(value)) {
      if (ch === '{') depth++
      else if (ch === '}' && depth > 0) depth--
      if (ch === ',' && depth === 0) { out.push(current); current = ''; continue }
      current += ch
    }
    out.push(current)
  }
  return out.map((s) => s.trim()).filter(Boolean)
}

async function runCli (options, { client } = {}) {
  let result
  try {
    const root = path.resolve(options.root || process.cwd())
    const files = selectFiles({ root, files: splitList(options.files), diff: options.diff })
    if (options.diff && !files.length) console.error(`check-sources: no .adoc files changed against ${options.diff}${options.files && options.files.length ? ' that match --files' : ''}; nothing to check`)
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
  splitList,
  formatHuman,
  runCli
}
