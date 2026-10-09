'use strict'

const fs = require('fs')
const path = require('path')

/**
 * doc-tools check-build-log: the blocking gate of the Connect docs PR check.
 *
 * Antora's own --log-failure-level makes Antora exit non-zero, but it says
 * nothing about WHAT failed in a form a job summary can show, and it cannot
 * catch the build that exits 0 having written no pages at all (Antora on an
 * unsupported Node version does exactly that). So the workflow runs Antora
 * with --log-failure-level=fatal and --log-format json, and this command
 * decides:
 *
 *   - any record at level error or fatal fails the check. With
 *     --blocking-sources, an error fails it only when it comes from one of
 *     those repositories (its own source or any page in its include chain),
 *     or has no source at all (an extension error); errors from the other
 *     sources are listed but do not block. Fatal records always block,
 *   - with --min-pages and --site-dir, fewer HTML pages than expected fails it,
 *   - warnings never fail it; they are listed in the summary.
 *
 * The summary is Markdown, written to stdout, for $GITHUB_STEP_SUMMARY.
 */

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace']
const BLOCKING_LEVELS = new Set(['fatal', 'error'])
// pino's numeric levels, in case a log was written without level labels.
const NUMERIC_LEVELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' }

const DEFAULTS = Object.freeze({
  maxGroups: 50,
  maxLocations: 5
})

function normalizeLevel (level) {
  if (typeof level === 'number') return NUMERIC_LEVELS[level] || String(level)
  return String(level || 'info').toLowerCase()
}

/**
 * A human-readable location for one log record: the source repository and
 * ref, then the file and line. Local worktree paths are made relative to the
 * worktree so the same file reads the same on every runner.
 */
function relativePath (file, source) {
  let filePath = (file && file.path) || ''
  if (filePath && source && source.worktree && path.isAbsolute(filePath)) {
    const rel = path.relative(source.worktree, filePath)
    if (!rel.startsWith('..')) filePath = rel
  }
  return filePath
}

/** owner/name of a source URL, without the host or .git. */
function repoSlug (url) {
  return String(url || '').replace(/\.git$/, '').replace(/^[a-z]+:\/\/[^/]+\//i, '').replace(/^git@[^:]+:/, '')
}

function locationOf (record) {
  const file = record.file || {}
  const source = record.source || {}
  if (!file.path && !source.url) return null
  const filePath = relativePath(file, source)
  let where = ''
  if (source.url) {
    const repo = repoSlug(source.url)
    where = source.refname ? `${repo}@${source.refname}` : repo
    if (source.startPath) where += `/${source.startPath}`
  }
  let loc = filePath
  if (loc && file.line) loc += `:${file.line}`
  // The include chain: the page that pulled the file in, which is the useful
  // location when the problem is in a shared partial.
  const via = Array.isArray(record.stack) && record.stack.length
    ? record.stack.map((s) => {
      const p = relativePath(s.file, s.source)
      return p ? `${p}${s.file.line ? `:${s.file.line}` : ''}` : null
    }).filter(Boolean)
    : []
  let out = [where, loc].filter(Boolean).join(': ')
  if (via.length) out += ` (included from ${via.join(' < ')})`
  return out || null
}

function messageOf (record) {
  if (record.msg) return String(record.msg)
  if (record.err && record.err.message) return String(record.err.message)
  if (record.message) return String(record.message)
  return '(no message)'
}

/**
 * Parse an Antora JSON (NDJSON) log. Lines that are not JSON objects (stray
 * stderr, a progress bar) are counted, not fatal: a log is still checkable
 * when something else wrote to the same file.
 */
function parseLog (text) {
  const records = []
  let unparsed = 0
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj
    try {
      obj = JSON.parse(trimmed)
    } catch {
      unparsed++
      continue
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      unparsed++
      continue
    }
    records.push(obj)
  }
  return { records, unparsed }
}

function countHtmlPages (dir) {
  let count = 0
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && entry.name.endsWith('.html')) count++
    }
  }
  return count
}

/**
 * Check a parsed log. Returns the counts, the grouped messages, and whether
 * the check passed.
 */
/**
 * Whether an error-level record blocks. Without a source list, every one
 * does. With one, a record blocks when it has no source at all (an
 * extension's own error), or when its source or any source in its include
 * chain is one of the listed repositories.
 */
function isBlocking (record, level, blockingSources) {
  if (level === 'fatal') return true
  if (!blockingSources || !blockingSources.length) return true
  const sources = [record.source, ...(Array.isArray(record.stack) ? record.stack.map((s) => s && s.source) : [])]
    .filter((s) => s && s.url)
  if (!sources.length) return true
  const wanted = new Set(blockingSources.map((s) => repoSlug(s).toLowerCase()))
  return sources.some((s) => wanted.has(repoSlug(s.url).toLowerCase()))
}

function checkBuildLog ({ text, siteDir, minPages, blockingSources } = {}) {
  const { records, unparsed } = parseLog(text)
  const counts = Object.fromEntries(LEVELS.map((l) => [l, 0]))
  const groups = new Map()
  let blocking = 0
  for (const record of records) {
    let level = normalizeLevel(record.level)
    counts[level] = (counts[level] || 0) + 1
    if (!BLOCKING_LEVELS.has(level) && level !== 'warn') continue
    if (BLOCKING_LEVELS.has(level)) {
      if (isBlocking(record, level, blockingSources)) blocking++
      else level = 'error-elsewhere'
    }
    const msg = messageOf(record)
    const key = `${level}\u0000${msg}`
    let group = groups.get(key)
    if (!group) {
      group = { level, msg, count: 0, locations: [] }
      groups.set(key, group)
    }
    group.count++
    const loc = locationOf(record)
    if (loc && !group.locations.includes(loc)) group.locations.push(loc)
  }

  const failures = []
  if (blocking > 0) {
    const scope = blockingSources && blockingSources.length ? ` from ${blockingSources.join(', ')}` : ''
    failures.push(`${blocking} log ${blocking === 1 ? 'record' : 'records'} at level error or fatal${scope}`)
  }

  let pages = null
  if (minPages != null) {
    if (!siteDir) throw new Error('--min-pages needs --site-dir')
    pages = fs.existsSync(siteDir) ? countHtmlPages(siteDir) : 0
    if (pages < minPages) {
      failures.push(`${pages} HTML ${pages === 1 ? 'page' : 'pages'} written under ${siteDir}, fewer than the required ${minPages}`)
    }
  }

  const byLevel = (level) => [...groups.values()]
    .filter((g) => g.level === level)
    .sort((a, b) => b.count - a.count || a.msg.localeCompare(b.msg))

  return {
    ok: failures.length === 0,
    failures,
    counts,
    total: records.length,
    unparsed,
    pages,
    minPages: minPages == null ? null : minPages,
    blocking,
    blockingSources: blockingSources && blockingSources.length ? blockingSources : null,
    groups: {
      fatal: byLevel('fatal'),
      error: byLevel('error'),
      errorElsewhere: byLevel('error-elsewhere'),
      warn: byLevel('warn')
    }
  }
}

// Markdown table cells and inline code cannot hold a raw pipe or backtick
// run, and a message can contain both.
function mdInline (text) {
  return String(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/</g, '&lt;')
}

function formatGroups (title, groups, { maxGroups, maxLocations }) {
  if (!groups.length) return []
  const lines = [`### ${title}`, '']
  for (const g of groups.slice(0, maxGroups)) {
    lines.push(`- ${g.count > 1 ? `(${g.count}x) ` : ''}${mdInline(g.msg)}`)
    for (const loc of g.locations.slice(0, maxLocations)) lines.push(`  - ${mdInline(loc)}`)
    if (g.locations.length > maxLocations) lines.push(`  - and ${g.locations.length - maxLocations} more locations`)
  }
  if (groups.length > maxGroups) lines.push(`- and ${groups.length - maxGroups} more distinct messages`)
  lines.push('')
  return lines
}

function formatMarkdown (result, opts = {}) {
  const { maxGroups, maxLocations } = { ...DEFAULTS, ...opts }
  const lines = []
  lines.push(`## Antora build log: ${result.ok ? 'passed' : 'failed'}`, '')
  if (!result.ok) {
    for (const f of result.failures) lines.push(`- **Blocking:** ${f}`)
    lines.push('')
  }
  lines.push('| Level | Count |', '|---|---|')
  for (const level of LEVELS) {
    if (level === 'debug' || level === 'trace') {
      if (!result.counts[level]) continue
    }
    lines.push(`| ${level} | ${result.counts[level] || 0} |`)
  }
  if (result.pages != null) lines.push(`| HTML pages | ${result.pages} (minimum ${result.minPages}) |`)
  if (result.unparsed) lines.push(`| non-JSON lines | ${result.unparsed} |`)
  lines.push('')
  lines.push(...formatGroups('Fatal', result.groups.fatal, { maxGroups, maxLocations }))
  lines.push(...formatGroups('Errors', result.groups.error, { maxGroups, maxLocations }))
  if (result.groups.errorElsewhere.length) {
    lines.push(...formatGroups(`Errors from other sources (do not block; only ${result.blockingSources.join(', ')} block)`, result.groups.errorElsewhere, { maxGroups, maxLocations }))
  }
  lines.push(...formatGroups('Warnings (do not block)', result.groups.warn, { maxGroups, maxLocations }))
  return lines.join('\n')
}

function intOption (value, flag) {
  if (value == null) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer, got ${value}`)
  return n
}

function runCli (logFile, options = {}) {
  let result
  try {
    if (!logFile || !fs.existsSync(logFile)) throw new Error(`log file not found: ${logFile}`)
    result = checkBuildLog({
      text: fs.readFileSync(logFile, 'utf8'),
      siteDir: options.siteDir,
      minPages: intOption(options.minPages, '--min-pages'),
      blockingSources: options.blockingSources
        ? String(options.blockingSources).split(',').map((x) => x.trim()).filter(Boolean)
        : undefined
    })
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(2)
  }
  const out = options.format === 'json' ? JSON.stringify(result, null, 2) : formatMarkdown(result)
  console.log(out)
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true })
    fs.writeFileSync(path.resolve(options.output), out + '\n')
  }
  process.exit(result.ok ? 0 : 1)
}

module.exports = {
  DEFAULTS,
  parseLog,
  checkBuildLog,
  countHtmlPages,
  formatMarkdown,
  locationOf,
  isBlocking,
  runCli
}
