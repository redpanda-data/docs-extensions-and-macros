'use strict'

const fs = require('fs')
const path = require('path')

const { runRules, mergeResults } = require('./engine')
const { getChangedLines, classifyDiff, spanIntersects, SURFACE_ROUTES } = require('./diff')
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
  connect: require('./surfaces/connect')
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

  if (diffBase) {
    const changed = getChangedLines(repoPath, diffBase)
    const classified = classifyDiff(changed)

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
      const fileSet = new Set(files.keys())
      const declarations = surface
        .extract({ repo: repoPath, files: fileSet, log })
        .filter((decl) => spanIntersects(decl.line_start, decl.line_end, files.get(decl.file)))
      for (const decl of declarations) decl.in_pr_diff = true
      results.push(runRules(declarations, rulesFor(surface), { skipRules, onlyRules }))
    }
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
  merged.findings.sort((a, b) =>
    a.surface.localeCompare(b.surface) || a.file.localeCompare(b.file) || (a.line_start || 0) - (b.line_start || 0))
  merged.unsupported_surfaces = unsupportedSurfaces
  return merged
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
      onlyRules: options.onlyRules ? String(options.onlyRules).split(',').map((s) => s.trim()).filter(Boolean) : null
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

module.exports = { lintStrings, formatHuman, runCli, SURFACES, rulesFor }

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
    else if (arg === '--strict') options.strict = true
    else {
      console.error(`Unknown argument: ${arg}`)
      console.error('Usage: node tools/lint-strings --repo <path> [--surface a,b] [--diff <base>] [--format json|human] [--skip-rules a,b] [--only-rules a,b] [--strict]')
      process.exit(2)
    }
  }
  runCli(options)
}
