'use strict'

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { runRules, mergeResults } = require('./engine')
const { getDiffLines, classifyDiff, spanIntersects, SURFACE_ROUTES } = require('./diff')
const { COMMON_RULES } = require('./rules/common')
const { VERBATIM_ASCIIDOC_RULES } = require('./rules/verbatim-asciidoc')

/**
 * doc-tools lint-strings: deterministic linting of user-facing doc strings
 * embedded in engineering source code (the strings doc-tools publishes
 * verbatim to docs.redpanda.com).
 *
 * Registered surfaces. SEAM: new surface modules plug in here - implement
 * ./surfaces/<name>.js with the same contract as the existing modules
 * ({ name, convention, extract({repo, files}), rules, [skipRules] }) and
 * add it to this registry plus ./diff.js SURFACE_ROUTES for diff-mode path
 * routing.
 */
const SURFACES = {
  properties: require('./surfaces/properties'),
  metrics: require('./surfaces/metrics'),
  rpk: require('./surfaces/rpk'),
  helm: require('./surfaces/helm'),
  crd: require('./surfaces/crd'),
  connect: require('./surfaces/connect'),
  api: require('./surfaces/api')
}

/**
 * Build the rule set for a surface: common rules + verbatim-AsciiDoc rules
 * (for surfaces whose strings ship unescaped) + surface-specific rules.
 * A surface may opt out of specific auto-applied rules via an optional
 * skipRules array (for example, rpk skips too-short: one-line Shorts and
 * flag usages are the convention, not a defect).
 */
function rulesFor (surface) {
  const rules = [...COMMON_RULES]
  if (surface.convention.verbatim_asciidoc) rules.push(...VERBATIM_ASCIIDOC_RULES)
  rules.push(...surface.rules)
  const skip = new Set(surface.skipRules || [])
  return skip.size > 0 ? rules.filter((rule) => !skip.has(rule.name)) : rules
}

/**
 * Run the linter.
 *
 * @param {Object} options
 * @param {string} options.repo - Path to the engineering checkout (required)
 * @param {string[]} [options.surfaces] - Surface names (default: all registered)
 * @param {string} [options.diffBase] - Declaration-anchored diff mode: lint
 *   only declarations whose span intersects lines changed since this ref
 * @param {string[]} [options.skipRules]
 * @param {string[]} [options.onlyRules]
 * @param {Set<string>} [options.reviewedFingerprints] - Diff mode: skip
 *   declarations (and removals) whose fingerprint is in this set, so a PR
 *   review sees each string once across pushes
 * @param {Function} [options.log] - Progress logger (stderr by default)
 * @returns {Object} { findings, summary, unsupported_surfaces }
 */
function lintStrings (options) {
  const {
    repo,
    surfaces = null,
    diffBase = null,
    skipRules = [],
    onlyRules = null,
    reviewedFingerprints = null,
    log = (msg) => process.stderr.write(`${msg}\n`)
  } = options

  if (!repo) throw new Error('lint-strings requires --repo <path>')
  const repoPath = path.resolve(repo)
  if (!fs.existsSync(repoPath)) throw new Error(`Repo path does not exist: ${repoPath}`)

  const requested = surfaces && surfaces.length > 0 ? surfaces : Object.keys(SURFACES)
  for (const name of requested) {
    if (!SURFACES[name]) {
      const known = SURFACE_ROUTES.some((route) => route.surface === name)
      throw new Error(known
        ? `Surface "${name}" is routed but has no extractor registered yet. Registered: ${Object.keys(SURFACES).join(', ')}`
        : `Unknown surface "${name}". Registered: ${Object.keys(SURFACES).join(', ')}`)
    }
  }

  const results = []
  const unsupportedSurfaces = []
  const reviewed = reviewedFingerprints || new Set()
  const pending = []
  let alreadyReviewed = 0
  let removal = { rawFiles: [], declarations: [] }

  if (diffBase) {
    const { changed, removed } = getDiffLines(repoPath, diffBase)
    const classified = classifyDiff(changed)
    const removedBySurface = classifyDiff(removed)
    const headBySurface = {}

    for (const [surfaceName, files] of Object.entries(classified)) {
      if (!SURFACES[surfaceName]) {
        // Routed by path but no extractor registered yet (rpk/helm/crd/connect
        // until their surface modules land). Report instead of dropping.
        unsupportedSurfaces.push({ surface: surfaceName, files: [...files.keys()] })
        continue
      }
      if (!requested.includes(surfaceName)) continue

      const surface = SURFACES[surfaceName]
      log(`[${surfaceName}] ${files.size} changed file(s) in diff; extracting declarations at HEAD...`)
      // Files that only lost lines are extracted too: a declaration that
      // still exists at HEAD, in any touched file, was edited or moved, not
      // removed.
      const removedFiles = removedBySurface[surfaceName] ? [...removedBySurface[surfaceName].keys()] : []
      const head = surface.extract({ repo: repoPath, files: new Set([...files.keys(), ...removedFiles]), log })
      headBySurface[surfaceName] = head
      const declarations = []
      for (const decl of head) {
        if (!touches(decl, files.get(decl.file))) continue
        decl.in_pr_diff = true
        decl.fingerprint = fingerprint(decl)
        if (reviewed.has(decl.fingerprint)) {
          alreadyReviewed++
          continue
        }
        declarations.push(decl)
        pending.push(pendingEntry(decl))
      }
      results.push(runRules(declarations, rulesFor(surface), { skipRules, onlyRules }))
    }

    removal = collectRemovals({ repoPath, diffBase, removed: removedBySurface, surfaces, requested, headBySurface, log })
    const kept = removal.declarations.filter((decl) => !reviewed.has(decl.fingerprint))
    alreadyReviewed += removal.declarations.length - kept.length
    removal.declarations = kept
  } else {
    for (const surfaceName of requested) {
      const surface = SURFACES[surfaceName]
      log(`[${surfaceName}] extracting declarations from ${repoPath}...`)
      const declarations = surface.extract({ repo: repoPath, log })
      for (const decl of declarations) decl.in_pr_diff = false
      results.push(runRules(declarations, rulesFor(surface), { skipRules, onlyRules }))
    }
  }

  const merged = mergeResults(results)
  for (const finding of merged.findings) {
    if (finding.in_pr_diff) finding.fingerprint = fingerprint(finding)
  }
  merged.findings.sort((a, b) =>
    a.surface.localeCompare(b.surface) || a.file.localeCompare(b.file) || (a.line_start || 0) - (b.line_start || 0))
  merged.unsupported_surfaces = unsupportedSurfaces
  if (diffBase) {
    merged.declarations = pending
    merged.summary.alreadyReviewed = alreadyReviewed
  }
  merged.summary.removedDeclarations = removal.declarations.map(pendingEntry)
  const removedSurfaceFiles = [...removal.rawFiles, ...removedFilesFor(removal.declarations)]
    .sort((a, b) => a.surface.localeCompare(b.surface) || a.file.localeCompare(b.file))
  merged.summary.removedSurfaceFiles = removedSurfaceFiles
  merged.summary.removedSurfaceLines = removedSurfaceFiles.reduce((sum, entry) => sum + entry.lines, 0)
  return merged
}

/**
 * A declaration's anchor lines: its span, plus any lines a surface records
 * separately because the declared name lives outside it (metrics names sit
 * in the enclosing make_*() call).
 */
function spansOf (decl) {
  const spans = [[decl.line_start, decl.line_end]]
  const extra = decl.meta && decl.meta.name_lines
  if (extra) spans.push(extra)
  return spans
}

function inSpans (decl, line) {
  return spansOf(decl).some(([start, end]) => start != null && line >= start && line <= end)
}

function touches (decl, lineSet) {
  return spansOf(decl).some(([start, end]) => spanIntersects(start, end, lineSet))
}

/**
 * Stable identity for one version of one doc string. A PR review records the
 * fingerprints it has seen, and a later push skips any declaration whose
 * surface, name and text are unchanged, so rebases, moves and unrelated edits
 * never re-review a string. Editing the string changes the fingerprint.
 */
function fingerprint (decl) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([decl.surface, decl.name, decl.string == null ? null : decl.string]))
    .digest('hex')
    .slice(0, 16)
}

function removalFingerprint (decl) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(['removed', decl.surface, decl.name]))
    .digest('hex')
    .slice(0, 16)
}

function pendingEntry (decl) {
  return {
    surface: decl.surface,
    name: decl.name,
    file: decl.file,
    line_start: decl.line_start,
    line_end: decl.line_end,
    fingerprint: decl.fingerprint
  }
}

function removedFilesFor (declarations) {
  const byFile = new Map()
  for (const decl of declarations) {
    const key = `${decl.surface}\0${decl.file}`
    const lines = (decl.removed_lines || 0)
    byFile.set(key, { surface: decl.surface, file: decl.file, lines: (byFile.has(key) ? byFile.get(key).lines : 0) + lines })
  }
  return [...byFile.values()].sort((a, b) => a.surface.localeCompare(b.surface) || a.file.localeCompare(b.file))
}

/**
 * Materialize the merge-base version of `files` into a scratch tree, so a
 * surface extractor can read the pre-image. A surface that declares
 * baseScope 'directory' gets the whole directories instead: the properties
 * extractor pairs each .cc with its .h.
 */
function materializeBase (repoPath, diffBase, files, scope = 'file') {
  const mb = spawnSync('git', ['merge-base', diffBase, 'HEAD'], { cwd: repoPath, encoding: 'utf8' })
  if (mb.status !== 0) throw new Error(`git merge-base ${diffBase} HEAD failed: ${mb.stderr}`)
  const base = mb.stdout.trim()
  const paths = scope === 'directory' ? [...new Set(files.map((f) => path.dirname(f)))] : files
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-strings-base-'))
  const archive = spawnSync('git', ['archive', '--format=tar', base, '--', ...paths], { cwd: repoPath, maxBuffer: 1024 * 1024 * 1024 })
  if (archive.status !== 0) {
    fs.rmSync(scratch, { recursive: true, force: true })
    throw new Error(`git archive ${base} failed: ${archive.stderr}`)
  }
  const untar = spawnSync('tar', ['-x', '-C', scratch], { input: archive.stdout })
  if (untar.status !== 0) {
    fs.rmSync(scratch, { recursive: true, force: true })
    throw new Error(`tar failed: ${untar.stderr}`)
  }
  return scratch
}

/**
 * Doc-string declarations the diff removed or renamed.
 *
 * A deleted line only matters when it belonged to a declaration: removing an
 * include, a struct field or a checksum from a surface file is not a removed
 * surface. So the old side of each affected file is extracted at the merge
 * base, and a declaration counts as removed when its span there lost lines
 * and its name no longer appears at HEAD in any file the diff touched (still
 * present means it was edited or moved, and HEAD-side review covers it).
 *
 * Declarations are absent from HEAD by construction, so they cannot be linted;
 * they are reported for the published-content check instead.
 *
 * Surfaces routed without a registered extractor, and any base extraction
 * that fails, fall back to counting raw deleted lines: without an extractor
 * there is no way to tell, and the gate should err toward reviewing.
 *
 * @returns {{ rawFiles: Array, declarations: Array }}
 */
function collectRemovals ({ repoPath, diffBase, removed, surfaces, requested, headBySurface, log }) {
  const only = surfaces && surfaces.length > 0 ? new Set(surfaces) : null
  const rawFiles = []
  const declarations = []

  for (const [surfaceName, files] of Object.entries(removed)) {
    if (only && !only.has(surfaceName)) continue
    const surface = SURFACES[surfaceName]
    const raw = () => {
      for (const [file, lines] of files) rawFiles.push({ surface: surfaceName, file, lines: lines.size })
    }
    if (!surface || !requested.includes(surfaceName)) {
      raw()
      continue
    }

    let scratch = null
    try {
      scratch = materializeBase(repoPath, diffBase, [...files.keys()], surface.baseScope)
      log(`[${surfaceName}] ${files.size} file(s) lost lines; extracting declarations at the merge base...`)
      const baseDecls = surface.extract({ repo: scratch, files: new Set(files.keys()), log })
      const headNames = new Set((headBySurface[surfaceName] ||
        surface.extract({ repo: repoPath, files: new Set(files.keys()), log })).map((d) => d.name))
      for (const decl of baseDecls) {
        const lost = files.get(decl.file)
        if (!touches(decl, lost)) continue
        if (headNames.has(decl.name)) continue
        let count = 0
        for (const line of lost) if (inSpans(decl, line)) count++
        declarations.push({
          surface: surfaceName,
          name: decl.name,
          file: decl.file,
          line_start: decl.line_start,
          line_end: decl.line_end,
          string: decl.string,
          removed_lines: count,
          fingerprint: removalFingerprint({ surface: surfaceName, name: decl.name })
        })
      }
    } catch (err) {
      log(`[${surfaceName}] could not extract the merge-base side (${err.message}); counting raw deleted lines instead`)
      raw()
    } finally {
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
    }
  }

  return { rawFiles, declarations }
}

/**
 * Human-readable report (the default --format).
 */
function formatHuman (result) {
  const lines = []
  const { findings, summary } = result

  for (const finding of findings) {
    const span = finding.line_start != null ? `:${finding.line_start}-${finding.line_end}` : ''
    const diffMark = finding.in_pr_diff ? ' [in PR diff]' : ''
    lines.push(`${finding.file}${span}  ${finding.name || '(unresolved name)'}  (${finding.surface})${diffMark}`)
    if (finding.string != null) {
      const preview = finding.string.length > 100 ? `${finding.string.slice(0, 100)}...` : finding.string
      lines.push(`  string: ${JSON.stringify(preview)}`)
    }
    for (const issue of finding.rules) {
      lines.push(`  ${issue.severity.toUpperCase().padEnd(7)} [${issue.id}] ${issue.message}`)
    }
    lines.push('')
  }

  lines.push('='.repeat(60))
  lines.push('LINT-STRINGS SUMMARY')
  lines.push('='.repeat(60))
  lines.push(`Declarations checked: ${summary.totalDeclarations}`)
  lines.push(`Declarations flagged: ${summary.flaggedDeclarations}`)
  if (summary.alreadyReviewed) {
    lines.push(`Already reviewed on an earlier push (skipped): ${summary.alreadyReviewed}`)
  }
  for (const decl of summary.removedDeclarations || []) {
    lines.push(`Removed or renamed: ${decl.name} (${decl.surface}, ${decl.file})`)
  }
  if (summary.removedSurfaceLines && !(summary.removedDeclarations || []).length) {
    lines.push(`Lines deleted from doc-string surfaces: ${summary.removedSurfaceLines} ` +
      `(${summary.removedSurfaceFiles.length} file(s) with no extractor, so every deleted line counts)`)
  }
  lines.push(`Errors: ${summary.errors}  Warnings: ${summary.warnings}  Info: ${summary.info}`)
  if (Object.keys(summary.byRule).length > 0) {
    lines.push('\nBy rule:')
    for (const [rule, counts] of Object.entries(summary.byRule).sort()) {
      const parts = []
      if (counts.errors) parts.push(`${counts.errors} errors`)
      if (counts.warnings) parts.push(`${counts.warnings} warnings`)
      if (counts.info) parts.push(`${counts.info} info`)
      lines.push(`  ${rule}: ${parts.join(', ')}`)
    }
  }
  if (Object.keys(summary.bySurface).length > 0) {
    lines.push('\nBy surface:')
    for (const [surface, counts] of Object.entries(summary.bySurface).sort()) {
      lines.push(`  ${surface}: ${counts.flagged}/${counts.declarations} declarations flagged (${counts.errors} errors, ${counts.warnings} warnings, ${counts.info} info)`)
    }
  }
  for (const entry of result.unsupported_surfaces || []) {
    lines.push(`\nNote: diff touches ${entry.surface} files but that surface has no extractor registered yet: ${entry.files.join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * Read a --reviewed file: fingerprints separated by whitespace or commas.
 * Anything that is not a 16-hex-digit fingerprint is ignored, and a missing
 * file is an empty set, so a first run and a corrupted cache both mean
 * "review everything" rather than an error.
 */
function readFingerprints (file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return new Set()
  }
  return new Set(text.split(/[\s,]+/).filter((token) => /^[0-9a-f]{16}$/.test(token)))
}

/**
 * CLI entry point shared by bin/doc-tools.js and direct invocation
 * (node tools/lint-strings --repo <path> ...).
 *
 * Exit code contract: always 0 (suggest, never block), unless --strict is
 * passed AND there is at least one error-severity finding.
 */
function runCli (options) {
  let result
  try {
    result = lintStrings({
      repo: options.repo,
      surfaces: options.surface ? String(options.surface).split(',').map((s) => s.trim()).filter(Boolean) : null,
      diffBase: options.diff || null,
      skipRules: options.skipRules ? String(options.skipRules).split(',').map((s) => s.trim()).filter(Boolean) : [],
      onlyRules: options.onlyRules ? String(options.onlyRules).split(',').map((s) => s.trim()).filter(Boolean) : null,
      reviewedFingerprints: options.reviewed ? readFingerprints(options.reviewed) : null
    })
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(2)
  }

  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(formatHuman(result))
  }

  if (options.strict && result.summary.errors > 0) process.exit(1)
  process.exit(0)
}

module.exports = { lintStrings, formatHuman, runCli, SURFACES, rulesFor, fingerprint, readFingerprints }

// Direct usage: node tools/lint-strings --repo <path> [--surface a,b]
//   [--diff <base>] [--format json|human] [--strict]
if (require.main === module) {
  const args = process.argv.slice(2)
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--repo') options.repo = args[++i]
    else if (arg === '--surface') options.surface = args[++i]
    else if (arg === '--diff') options.diff = args[++i]
    else if (arg === '--format') options.format = args[++i]
    else if (arg === '--skip-rules') options.skipRules = args[++i]
    else if (arg === '--only-rules') options.onlyRules = args[++i]
    else if (arg === '--reviewed') options.reviewed = args[++i]
    else if (arg === '--strict') options.strict = true
    else {
      console.error(`Unknown argument: ${arg}`)
      console.error('Usage: node tools/lint-strings --repo <path> [--surface a,b] [--diff <base>] [--format json|human] [--skip-rules a,b] [--only-rules a,b] [--reviewed <file>] [--strict]')
      process.exit(2)
    }
  }
  runCli(options)
}
