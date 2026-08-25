'use strict'

/**
 * Rule runner for lint-strings.
 *
 * Adopts the VALIDATION_RULES shape from tools/rpk-docs/validate-output.js:
 * each rule is { name, description, severity, check() -> issues[] }, with
 * skipRules/onlyRules filtering and a byRule summary. The difference is the
 * unit of work: rules here check one extracted *declaration* (a property,
 * metric, rpk command, ...) rather than a generated .adoc file.
 *
 * Declaration shape (produced by the surface modules in ./surfaces):
 *   {
 *     surface: 'properties',          // surface id
 *     name: 'cluster_id',             // declared name (null if unresolvable)
 *     file: 'src/v/config/...',       // path relative to --repo
 *     line_start: 1852,               // 1-indexed, inclusive
 *     line_end: 1857,                 //   spans the FULL declaration
 *     string: 'The doc string',       // extracted doc string (null if none)
 *     declaration_text: '...',        // exact source lines of the span
 *     convention: { ... },            // surface conventions (echoed in findings)
 *     meta: { ... }                   // surface-specific extras for rules
 *   }
 *
 * Severity levels: error | warning | info.
 */

const SEVERITIES = ['error', 'warning', 'info']

/**
 * Run rules over a list of declarations.
 *
 * @param {Array} declarations - Declarations from a surface module
 * @param {Array} rules - Rules ({ name, severity, check(decl) -> issues[] }).
 *   Optional rule fields:
 *   - runOnUnverifiable: also run when decl.meta.unverifiable is set
 *     (all other rules are skipped for unverifiable declarations, so a
 *     non-literal source string can never produce an error)
 * @param {Object} options - { skipRules: [names], onlyRules: [names] }
 * @returns {Object} { findings, summary: { byRule, bySurface } }
 */
function runRules (declarations, rules, options = {}) {
  const { skipRules = [], onlyRules = null } = options
  const findings = []
  const summary = emptySummary()

  for (const decl of declarations) {
    summary.totalDeclarations++
    ensureSurface(summary, decl.surface).declarations++
    const issues = []

    for (const rule of rules) {
      if (skipRules.includes(rule.name)) continue
      if (onlyRules && !onlyRules.includes(rule.name)) continue
      // Unverifiable declarations (for example, a metric description built
      // with fmt::format) only run rules that opt in; they must never error.
      if (decl.meta && decl.meta.unverifiable && !rule.runOnUnverifiable) continue

      try {
        for (const issue of rule.check(decl) || []) {
          const severity = issue.severity || rule.severity
          issues.push({
            id: rule.name,
            severity: SEVERITIES.includes(severity) ? severity : 'warning',
            message: issue.message
          })
        }
      } catch (err) {
        issues.push({
          id: rule.name,
          severity: 'error',
          message: `Rule execution failed: ${err.message}`
        })
      }
    }

    if (issues.length === 0) continue

    findings.push({
      surface: decl.surface,
      name: decl.name,
      file: decl.file,
      line_start: decl.line_start,
      line_end: decl.line_end,
      string: decl.string,
      declaration_text: decl.declaration_text,
      rules: issues,
      convention: decl.convention || {},
      in_pr_diff: Boolean(decl.in_pr_diff)
    })

    tally(summary, decl.surface, issues)
  }

  return { findings, summary }
}

function emptySummary () {
  return {
    totalDeclarations: 0,
    flaggedDeclarations: 0,
    errors: 0,
    warnings: 0,
    info: 0,
    byRule: {},
    bySurface: {}
  }
}

function ensureSurface (summary, surface) {
  if (!summary.bySurface[surface]) {
    summary.bySurface[surface] = { declarations: 0, flagged: 0, errors: 0, warnings: 0, info: 0 }
  }
  return summary.bySurface[surface]
}

function tally (summary, surface, issues) {
  summary.flaggedDeclarations++
  ensureSurface(summary, surface).flagged++

  for (const issue of issues) {
    if (!summary.byRule[issue.id]) {
      summary.byRule[issue.id] = { errors: 0, warnings: 0, info: 0 }
    }
    const bucket = issue.severity === 'error' ? 'errors' : issue.severity === 'warning' ? 'warnings' : 'info'
    summary.byRule[issue.id][bucket]++
    summary.bySurface[surface][bucket]++
    summary[bucket]++
  }
}

/**
 * Merge per-surface run results into one combined result.
 */
function mergeResults (results) {
  const merged = { findings: [], summary: emptySummary() }
  for (const result of results) {
    merged.findings.push(...result.findings)
    const s = result.summary
    merged.summary.totalDeclarations += s.totalDeclarations
    merged.summary.flaggedDeclarations += s.flaggedDeclarations
    merged.summary.errors += s.errors
    merged.summary.warnings += s.warnings
    merged.summary.info += s.info
    for (const [rule, counts] of Object.entries(s.byRule)) {
      if (!merged.summary.byRule[rule]) merged.summary.byRule[rule] = { errors: 0, warnings: 0, info: 0 }
      merged.summary.byRule[rule].errors += counts.errors
      merged.summary.byRule[rule].warnings += counts.warnings
      merged.summary.byRule[rule].info += counts.info
    }
    for (const [surface, counts] of Object.entries(s.bySurface)) {
      if (!merged.summary.bySurface[surface]) {
        merged.summary.bySurface[surface] = { declarations: 0, flagged: 0, errors: 0, warnings: 0, info: 0 }
      }
      for (const key of Object.keys(counts)) {
        merged.summary.bySurface[surface][key] += counts[key]
      }
    }
  }
  return merged
}

module.exports = { runRules, mergeResults, SEVERITIES }
