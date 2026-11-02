'use strict'

/**
 * Accumulates errors and warnings across a validation pass, so a set of
 * independent checks (schema shape, cross-references, semantic rules) can
 * each report findings and have them merged into one result the caller
 * prints and exits on. Shared by every overrides validator in this repo —
 * originally written for tools/rpk-docs/validate-overrides.js, extracted
 * here once tools/property-extractor needed the identical accumulator.
 */
class ValidationResult {
  constructor() {
    this.valid = true
    this.errors = []
    this.warnings = []
  }

  addError(message, context = null) {
    this.valid = false
    this.errors.push({ message, context })
  }

  addWarning(message, context = null) {
    this.warnings.push({ message, context })
  }

  merge(other) {
    if (!other.valid) this.valid = false
    this.errors.push(...other.errors)
    this.warnings.push(...other.warnings)
  }

  format() {
    const lines = []
    if (this.errors.length > 0) {
      lines.push('ERRORS:')
      for (const err of this.errors) {
        lines.push(`  ✗ ${err.message}`)
        if (err.context) lines.push(`    at: ${err.context}`)
      }
    }
    if (this.warnings.length > 0) {
      lines.push('WARNINGS:')
      for (const warn of this.warnings) {
        lines.push(`  ⚠ ${warn.message}`)
        if (warn.context) lines.push(`    at: ${warn.context}`)
      }
    }
    return lines.join('\n')
  }
}

module.exports = { ValidationResult }
