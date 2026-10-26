'use strict'

const fs = require('fs')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const { parseDiff, sideSnippets, excerpt } = require('./diff')
const { compareFindings, SEVERITY_RANK, KINDS, makeFinding } = require('./finding')
const { sameValue } = require('./values')

/**
 * doc-tools detect-user-facing-changes: a registry of deterministic
 * detectors that read an engineering PR's diff and report the
 * user-facing changes they recognize in it, whether or not a doc string
 * changed.
 *
 * The doc-strings review gates its doc-impact dispatch on the lint's
 * declaration count, so a PR that changes a default inside a property
 * initializer, adds an rpk flag, removes a metric, renames an API field or
 * adds an enum value, all without touching a description, filed nothing
 * (streaming-enterprise PR 579 and DOC-2600 were the first miss). These
 * detectors are the mechanical backstop: no model, no network, the diff
 * and the two sides of each changed file. Their findings open the dispatch
 * gate and merge into the dispatched doc-impact report.
 *
 * SEAM: a detector is a module exporting
 *   { id, surface, routes: RegExp[], detect(ctx) -> finding[] }
 * where ctx carries the routed diff files, `sides(file)` (both sides of a
 * file as line-numbered snippets, from the checkout when there is one and
 * from the hunks otherwise), `excerpt(file, side, from, to)` for evidence,
 * `readBase`/`readHead` for whole files, `listHead(dir)` for the files of
 * one directory at head (null without a checkout), and `note()` for
 * anything it could not resolve. Every finding goes through finding.js makeFinding, so
 * the shape and vocabulary cannot drift between detectors.
 */

const DETECTORS = [
  require('./detectors/properties'),
  require('./detectors/rpk'),
  require('./detectors/metrics'),
  require('./detectors/api'),
  require('./detectors/helm'),
  require('./detectors/crd'),
  require('./detectors/enums'),
  require('./detectors/enterprise-gating'),
  require('./detectors/constants')
]

/**
 * Run the detectors over a diff.
 *
 * @param {string} diffText - unified diff (`git diff base...head`)
 * @param {object} [options]
 * @param {(path: string) => string|null} [options.readBase] - pre-image file text
 * @param {(path: string) => string|null} [options.readHead] - post-image file text
 * @param {(dir: string) => string[]|null} [options.listHead] - repo-relative paths of the files directly in `dir` at head
 * @param {(dir: string) => string[]|null} [options.listBase] - the same at the base revision
 * @param {string[]} [options.detectors] - detector ids to run (default all)
 * @returns {{ findings: object[], notes: Array<{detector: string, message: string, file: string|null, line: number|null}>, byDetector: Object<string, number>, routed: Object<string, string[]> }}
 */
function detectUserFacingChanges (diffText, { readBase = null, readHead = null, listHead = null, listBase = null, detectors = null } = {}) {
  if (detectors) {
    const known = DETECTORS.map((d) => d.id)
    const unknown = detectors.filter((id) => !known.includes(id))
    // An unknown id used to run nothing and report a clean diff.
    if (unknown.length) throw new Error(`unknown detector id(s): ${unknown.join(', ')}; registered: ${known.join(', ')}`)
  }
  const files = parseDiff(diffText).filter((f) => !f.isBinary)
  const errors = []
  const notes = []
  const findings = []
  const byDetector = {}
  const routed = {}
  const sideCache = new Map()
  const sides = (file) => {
    if (sideCache.has(file)) return sideCache.get(file)
    let base = null
    let head = null
    if (file.isNew) base = []
    else if (readBase) { const t = readBase(file.oldPath); if (t !== null && t !== undefined) base = [{ startLine: 1, text: t }] }
    if (file.isDeleted) head = []
    else if (readHead) { const t = readHead(file.path); if (t !== null && t !== undefined) head = [{ startLine: 1, text: t }] }
    const partial = base === null || head === null
    if (base === null) base = sideSnippets(file, 'base')
    if (head === null) head = sideSnippets(file, 'head')
    const result = { base, head, partial }
    sideCache.set(file, result)
    return result
  }
  const excerptAt = (file, side, line) => (line == null ? '' : excerpt(file, side, line, line))

  for (const detector of DETECTORS) {
    if (detectors && !detectors.includes(detector.id)) continue
    const mine = files.filter((f) => detector.routes.some((re) => re.test(f.path) || re.test(f.oldPath)))
    routed[detector.id] = mine.map((f) => f.path)
    if (mine.length === 0) { byDetector[detector.id] = 0; continue }
    const note = (message, { file = null, line = null } = {}) => {
      // Both sides of a cut declaration report the same gap; say it once.
      if (!notes.some((n) => n.detector === detector.id && n.message === message)) notes.push({ detector: detector.id, message, file, line })
    }
    let found = []
    try {
      found = detector.detect({ files: mine, diffText, sides, excerpt, excerptAt, readBase, readHead, listHead, listBase, note }) || []
    } catch (err) {
      // One broken detector must not hide the others' findings, and must
      // not be silent either: a crash is an error on the report, not only
      // a note, so a caller never reads it as "nothing changed".
      note(`detector crashed: ${err.message}`)
      errors.push(`${detector.id}: ${err.message}`)
    }
    found = found.filter((f) => {
      if (KINDS.includes(f.change_kind)) return true
      note(`dropped a finding with unknown change_kind ${f.change_kind}`)
      return false
    })
    for (const f of found) {
      if (!f.detector) f.detector = detector.id
      f.confidence = 'mechanical'
    }
    found = pairMoves(found)
    byDetector[detector.id] = found.length
    findings.push(...found)
  }
  // One finding per (surface, page, name, change_kind): two detectors reading the
  // same file (properties and enterprise-gating both read configuration.h)
  // must not file the same change twice.
  const seen = new Set()
  const unique = []
  for (const f of findings.sort(compareFindings)) {
    const key = `${f.surface}\0${f.affected_pages[0]}\0${f.name}\0${f.change_kind}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(f)
  }
  for (const f of unique) {
    delete f.moveKey
    delete f.moveValue
    f.fingerprint = fingerprint(f)
  }
  return { findings: unique, notes, errors, byDetector, routed }
}

/**
 * Every detector compares base and head one file at a time, so a
 * declaration that moved to another file (rpk splitting a command into
 * its own file, a proto message moved into a common package) comes out as
 * a removal in one file and an addition in the other. Pair them across
 * files on the same page by the declaration's identity (`moveKey`, or the
 * finding name):
 * a pair is a move and reports nothing, unless both sides carry a
 * `moveValue` (a default) and the value changed on the way, which is then
 * reported once as a changed default.
 */
function pairMoves (found) {
  // The page is part of the identity: a property moved from node_config.cc
  // to configuration.cc, or a Helm key moved between charts, leaves two pages
  // stale, so it stays a removal plus an addition.
  const keyOf = (f) => `${f.surface}\0${f.affected_pages[0]}\0${f.moveKey || f.name}`
  const added = new Map()
  for (const f of found) {
    if (f.change_kind !== 'added') continue
    const k = keyOf(f)
    if (!added.has(k)) added.set(k, [])
    added.get(k).push(f)
  }
  const drop = new Set()
  const extra = []
  for (const r of found) {
    if (r.change_kind !== 'removed' || r.detail === 'hidden') continue
    const candidates = (added.get(keyOf(r)) || []).filter((a) => !drop.has(a) && a.file !== r.file)
    if (candidates.length === 0) continue
    const a = candidates[0]
    drop.add(a)
    drop.add(r)
    const same = (a.moveValue && a.moveValue.same) || ((x, y) => sameValue(x, y, (a.moveValue && a.moveValue.lang) || 'cpp'))
    if (r.moveValue != null && a.moveValue != null && !same(r.moveValue.text, a.moveValue.text)) {
      extra.push(makeFinding({
        detector: a.detector,
        surface: a.surface,
        name: a.name,
        change_kind: 'default-changed',
        file: a.file,
        line: a.line,
        evidence: a.evidence,
        page: a.affected_pages[0],
        summary: `\`${a.name}\` moved from \`${r.file}\` to \`${a.file}\`, and its default changed on the way, from \`${r.moveValue.text}\` to \`${a.moveValue.text}\`. Any page that quotes the old default states the wrong value.`
      }))
    }
  }
  return found.filter((f) => !drop.has(f)).concat(extra)
}

/**
 * A stable id for one finding: what changed and how, not where. The
 * workflow keeps the fingerprints it has dispatched for a PR, so a later
 * push that carries the same finding does not dispatch it again; a
 * different default, or a different kind of change to the same name, is a
 * new fingerprint.
 */
function fingerprint (f) {
  return crypto.createHash('sha256').update([f.surface, f.name, f.change_kind, f.detail || '', String(f.summary).replace(/:\d+\b/g, '')].join('\0')).digest('hex').slice(0, 16)
}

/** Findings that open the doc-impact gate: low ones ride along, never open it. */
const gating = (findings) => findings.filter((f) => f.severity !== 'low')

const CAP = 10

/**
 * The doc-impact report the review workflow dispatches (the shape the
 * dispatch step schema-checks and the docs-site router reads), or null when
 * there is nothing to report. Findings are ordered high severity first and
 * capped at ten; the ticket names only the findings it carries and counts
 * the rest, because the receiver dedupes on finding names.
 */
function buildDocImpact (result) {
  const findings = (result && result.findings) || []
  // Low means the generated reference picks the change up on
  // regeneration: worth carrying in a ticket that opens anyway, never a
  // reason to open one.
  if (gating(findings).length === 0) return null
  const capped = findings.slice(0, CAP)
  const overflow = findings.length - capped.length
  const rest = findings.slice(CAP).map((f) => f.name)
  const names = capped.map((f) => f.name)
  const counts = {}
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1
  const sevLine = Object.keys(SEVERITY_RANK).filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(', ')
  let title = `Document user-facing changes: ${names.join(', ')}${overflow > 0 ? ` and ${overflow} more` : ''}`
  if (title.length > 250) title = `${title.slice(0, 247)}...`
  const bullets = capped.map((f) => {
    const where = f.file ? ` Evidence: ${f.file}${f.line ? `:${f.line}` : ''}.` : ''
    return `- ${f.name} (${f.change_kind}, ${f.severity}): ${f.summary}${where}`
  })
  return {
    findings: capped,
    proposed_ticket: {
      title,
      body: [
        `This PR changes what users see, type or configure without changing a doc string, so the doc-strings review had nothing to show the docs team. ${findings.length} user-facing change(s) were detected mechanically from the diff (${sevLine}); each carries the diff lines as evidence and a confidence of \`mechanical\`.`,
        '',
        'Severity follows the docs-gate ladder: high means a published page now contradicts the shipped behaviour (a changed default, limit or restart requirement, a removed or renamed surface); medium means a user-facing change with nothing filed yet, including a deprecation; low means the generated reference picks it up on regeneration.',
        '',
        ...bullets,
        ...(overflow > 0 ? [`- ${overflow} more change(s) are not listed above: ${listNames(rest)}. See the PR diff for their evidence.`] : []),
        '',
        'The change is on the default branch until a release contains it; the docs change belongs to the version branch for that release. Confirm the affected release with the PR author.'
      ].join('\n')
    }
  }
}

/** Overflow names for the ticket body, bounded so the body stays readable. */
function listNames (names) {
  const shown = []
  let len = 0
  for (const n of names) {
    if (len + n.length > 1500) break
    shown.push(n)
    len += n.length + 2
  }
  return shown.join(', ') + (shown.length < names.length ? ` and ${names.length - shown.length} more` : '')
}

function formatHuman (result) {
  const lines = []
  for (const f of result.findings) {
    lines.push(`${f.severity.toUpperCase().padEnd(6)} ${f.surface} ${f.change_kind}: ${f.name}  (${f.file || '?'}${f.line ? `:${f.line}` : ''}, ${f.detector})`)
    if (f.evidence) for (const l of f.evidence.split('\n')) lines.push(`    ${l}`)
  }
  for (const e of result.errors || []) lines.push(`ERROR: ${e}`)
  if (result.findings.length === 0) lines.push((result.errors || []).length ? 'No findings, but the detection did not complete: see the errors above.' : 'No user-facing changes detected.')
  for (const n of result.notes) lines.push(`note [${n.detector}]: ${n.message}`)
  lines.push(`Detectors: ${Object.entries(result.byDetector).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  return lines.join('\n')
}

function git (repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${repo}: ${(r.stderr || '').trim()}`)
  return r.stdout
}

/**
 * Readers for a checkout: `git show <rev>:<path>`, null for a path that
 * does not exist at that revision.
 */
function gitReader (repo, rev) {
  const cache = new Map()
  return (p) => {
    if (cache.has(p)) return cache.get(p)
    const r = spawnSync('git', ['show', `${rev}:${p}`], { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    const text = r.status === 0 ? r.stdout : null
    cache.set(p, text)
    return text
  }
}

/**
 * Lister for a checkout: the files directly in a directory at `rev`
 * (`git ls-tree`), null when git fails.
 */
function gitLister (repo, rev) {
  const cache = new Map()
  return (dir) => {
    if (cache.has(dir)) return cache.get(dir)
    const r = spawnSync('git', ['ls-tree', '--name-only', rev, '--', `${dir.replace(/\/$/, '')}/`], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const out = r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null
    cache.set(dir, out)
    return out
  }
}

/**
 * CLI entry point. Exit code is always 0 and the JSON is always printed, so
 * a caller's fail-open gate stays closed rather than red. A run that could
 * not complete (a git failure, an unreadable patch, an unknown detector id,
 * a detector crash) says so in an `error` field, and the reason goes to
 * stderr: an empty `findings` array alone never stands for a failure.
 *
 * `--dispatched <file>` names fingerprints (one per line) already
 * dispatched for this PR; findings carrying one are left out and counted
 * in `summary.alreadyDispatched`.
 */
function runCli (options) {
  const fail = (message) => {
    console.error(`detect-user-facing-changes: ${message}`)
    console.log(JSON.stringify({ findings: [], error: message, summary: { total: 0, bySeverity: {}, byDetector: {}, notes: [] } }))
  }
  let diffText
  let readBase = null
  let readHead = null
  let listHead = null
  let listBase = null
  try {
    if (options.patch) {
      diffText = fs.readFileSync(options.patch, 'utf8')
      if (options.repo) {
        // --base names the pre-image revision; without it the pre-image is
        // the parent of --head, which is what a saved single-commit diff is.
        const head = options.head || 'HEAD'
        const base = options.base || git(options.repo, ['rev-parse', '--verify', `${head}^`]).trim()
        readBase = gitReader(options.repo, base)
        readHead = gitReader(options.repo, head)
        listHead = gitLister(options.repo, head)
        listBase = gitLister(options.repo, base)
      }
    } else {
      if (!options.repo || !options.diff) throw new Error('detect-user-facing-changes needs --repo <path> and --diff <base>, or --patch <file>')
      const head = options.head || 'HEAD'
      const mergeBase = git(options.repo, ['merge-base', options.diff, head]).trim()
      diffText = git(options.repo, ['diff', '--no-color', '--no-ext-diff', mergeBase, head])
      readBase = gitReader(options.repo, mergeBase)
      readHead = gitReader(options.repo, head)
      listHead = gitLister(options.repo, head)
      listBase = gitLister(options.repo, mergeBase)
    }
  } catch (err) {
    fail(err.message)
    return
  }
  const detectors = options.detectors ? String(options.detectors).split(',').map((s) => s.trim()).filter(Boolean) : null
  let result
  try {
    result = detectUserFacingChanges(diffText, { readBase, readHead, listHead, listBase, detectors })
  } catch (err) {
    fail(err.message)
    return
  }
  let alreadyDispatched = 0
  if (options.dispatched) {
    let seen = new Set()
    try {
      seen = new Set(fs.readFileSync(options.dispatched, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean))
    } catch (err) {
      if (err.code !== 'ENOENT') { fail(`could not read --dispatched ${options.dispatched}: ${err.message}`); return }
    }
    const kept = result.findings.filter((f) => !seen.has(f.fingerprint))
    alreadyDispatched = result.findings.length - kept.length
    result.findings = kept
  }
  if (options.format === 'human') {
    console.log(formatHuman(result))
    return
  }
  for (const n of result.notes) console.error(`note [${n.detector}]: ${n.message}`)
  const bySeverity = {}
  for (const f of result.findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1
  const report = buildDocImpact(result) || { findings: [] }
  if (result.errors.length) {
    report.error = `detection did not complete: ${result.errors.join('; ')}`
    console.error(`detect-user-facing-changes: ${report.error}`)
  }
  report.summary = {
    total: result.findings.length,
    gating: gating(result.findings).length,
    bySeverity,
    byDetector: result.byDetector,
    notes: result.notes,
    alreadyDispatched
  }
  console.log(JSON.stringify(report, null, 2))
}

module.exports = { DETECTORS, detectUserFacingChanges, buildDocImpact, formatHuman, runCli, gitReader, gitLister, pairMoves, fingerprint, CAP }
