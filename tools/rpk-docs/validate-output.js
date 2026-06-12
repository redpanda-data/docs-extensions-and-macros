'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Validation rules for generated rpk documentation
 * Each rule returns an array of issues found
 */
const VALIDATION_RULES = [
  {
    name: 'raw-external-urls',
    description: 'Raw external URLs that should be links or removed',
    severity: 'warning',
    // Allow certain external URLs that are intentional
    allowlist: [
      'https://github.com/redpanda-data/', // GitHub links are OK as links
    ],
    check: (content, filePath) => {
      const issues = []
      // Match URLs not inside link:[] or xref:[]
      const urlPattern = /(?<!link:)(?<!xref:)(https?:\/\/[^\s\[\]]+)/g
      let match
      while ((match = urlPattern.exec(content)) !== null) {
        const url = match[1]
        // Check if it's a docs.redpanda.com URL (should always be xref)
        if (url.includes('docs.redpanda.com')) {
          issues.push({
            line: getLineNumber(content, match.index),
            message: `Raw docs.redpanda.com URL should be an xref: ${url}`,
            severity: 'error'
          })
        }
      }
      return issues
    }
  },
  {
    name: 'invalid-xref-syntax',
    description: 'xref: followed by http URL (invalid)',
    severity: 'error',
    check: (content, filePath) => {
      const issues = []
      const pattern = /xref:https?:\/\/[^\[]+/g
      let match
      while ((match = pattern.exec(content)) !== null) {
        issues.push({
          line: getLineNumber(content, match.index),
          message: `Invalid xref syntax (cannot use URLs): ${match[0]}`,
          severity: 'error'
        })
      }
      return issues
    }
  },
  {
    name: 'markdown-emphasis',
    description: 'Markdown-style **text** should be AsciiDoc',
    severity: 'warning',
    check: (content, filePath) => {
      const issues = []
      // Match **WORD** patterns (markdown bold)
      const pattern = /\*\*([A-Z]+)\*\*/g
      let match
      while ((match = pattern.exec(content)) !== null) {
        issues.push({
          line: getLineNumber(content, match.index),
          message: `Markdown emphasis should be AsciiDoc: ${match[0]} → use admonition block instead`,
          severity: 'warning'
        })
      }
      return issues
    }
  },
  {
    name: 'truncated-description',
    description: 'Description appears truncated or garbled',
    severity: 'error',
    check: (content, filePath) => {
      const issues = []
      const descMatch = content.match(/^:description:\s*(.+)$/m)
      if (descMatch) {
        const desc = descMatch[1]
        // Check for signs of truncation
        if (desc.length < 20 && !desc.match(/^(List|Get|Set|Create|Delete|Update|Show|Print|Run|Start|Stop)\b/)) {
          // Very short and doesn't start with a verb
          if (desc.match(/^[a-z]/) || desc.match(/[^.!?]$/) || desc.match(/^\W/)) {
            issues.push({
              line: getLineNumber(content, descMatch.index),
              message: `Description appears truncated: "${desc}"`,
              severity: 'error'
            })
          }
        }
        // Check for garbled content (starts with punctuation or code, but allow backtick-wrapped words)
        if ((desc.match(/^[)}\]'"]/) || desc.match(/^\s*[a-z]+\(\)/)) && !desc.match(/^`[a-z]+`/i)) {
          issues.push({
            line: getLineNumber(content, descMatch.index),
            message: `Description appears garbled: "${desc}"`,
            severity: 'error'
          })
        }
      }
      return issues
    }
  },
  {
    name: 'inline-allcaps-warning',
    description: 'ALLCAPS warnings in middle of paragraph (not standalone admonitions)',
    severity: 'warning',
    check: (content, filePath) => {
      const issues = []
      const lines = content.split('\n')
      let inCodeBlock = false

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]

        // Track code blocks
        if (line.startsWith('----') || line.startsWith('....')) {
          inCodeBlock = !inCodeBlock
          continue
        }
        if (inCodeBlock) continue

        // Skip proper AsciiDoc admonitions:
        // - [WARNING] style block markers
        // - Standalone KEYWORD: lines (valid single-line admonitions)
        if (line.match(/^\[(WARNING|IMPORTANT|NOTE|CAUTION|TIP)\]$/)) continue

        // Check for ALLCAPS warnings that are NOT at start of line (inline in text)
        // e.g., "This is text WARNING: more text" - this is wrong
        const inlineMatch = line.match(/\S\s+(WARNING|IMPORTANT|CAUTION|DEPRECATED):\s/)
        if (inlineMatch) {
          issues.push({
            line: i + 1,
            message: `Inline ${inlineMatch[1]}: found mid-sentence - should be standalone admonition`,
            severity: 'warning'
          })
        }
      }
      return issues
    }
  },
  {
    name: 'coming-soon-placeholder',
    description: 'Coming soon placeholder content',
    severity: 'info',
    check: (content, filePath) => {
      const issues = []
      if (content.toLowerCase().includes('coming soon')) {
        issues.push({
          line: 1,
          message: 'Contains "coming soon" placeholder - may need documentation when feature ships',
          severity: 'info'
        })
      }
      return issues
    }
  },
  {
    name: 'bang-bang-callout',
    description: '!!TEXT!! style callouts are not allowed',
    severity: 'error',
    check: (content, filePath) => {
      const issues = []
      const pattern = /!![A-Z]+!!/g
      let match
      while ((match = pattern.exec(content)) !== null) {
        issues.push({
          line: getLineNumber(content, match.index),
          message: `!!CALLOUT!! style not allowed: ${match[0]}`,
          severity: 'error'
        })
      }
      return issues
    }
  },
  {
    name: 'duplicate-content',
    description: 'Duplicate paragraphs or sections',
    severity: 'warning',
    check: (content, filePath) => {
      const issues = []
      // Split into paragraphs (double newline separated)
      const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 100)
      const seen = new Map()

      for (const para of paragraphs) {
        // Skip table rows, code blocks, and list items
        if (para.startsWith('|') || para.startsWith('----') ||
            para.startsWith('* ') || para.startsWith('[')) continue

        const normalized = para.trim().toLowerCase().replace(/\s+/g, ' ')
        // Only check substantial prose paragraphs (longer threshold)
        if (normalized.length > 100) {
          if (seen.has(normalized)) {
            issues.push({
              line: getLineNumber(content, content.indexOf(para)),
              message: 'Duplicate paragraph detected',
              severity: 'warning'
            })
          }
          seen.set(normalized, true)
        }
      }
      return issues
    }
  }
]

/**
 * Get line number for a character index
 */
function getLineNumber(content, index) {
  return content.substring(0, index).split('\n').length
}

/**
 * Validate a single file
 * @param {string} filePath - Path to the file
 * @param {Object} options - Validation options
 * @returns {Object} Validation result
 */
function validateFile(filePath, options = {}) {
  const content = fs.readFileSync(filePath, 'utf8')
  const relativePath = options.basePath ? path.relative(options.basePath, filePath) : filePath

  const result = {
    file: relativePath,
    errors: [],
    warnings: [],
    info: []
  }

  for (const rule of VALIDATION_RULES) {
    // Skip rules if filtered
    if (options.skipRules && options.skipRules.includes(rule.name)) continue
    if (options.onlyRules && !options.onlyRules.includes(rule.name)) continue

    try {
      const issues = rule.check(content, filePath)
      for (const issue of issues) {
        const entry = {
          rule: rule.name,
          line: issue.line,
          message: issue.message
        }

        const severity = issue.severity || rule.severity
        if (severity === 'error') {
          result.errors.push(entry)
        } else if (severity === 'warning') {
          result.warnings.push(entry)
        } else {
          result.info.push(entry)
        }
      }
    } catch (err) {
      result.errors.push({
        rule: rule.name,
        line: 0,
        message: `Rule execution failed: ${err.message}`
      })
    }
  }

  return result
}

/**
 * Validate all files in a directory
 * @param {string} dirPath - Directory to validate
 * @param {Object} options - Validation options
 * @returns {Object} Validation summary
 */
function validateDirectory(dirPath, options = {}) {
  const results = []
  const summary = {
    totalFiles: 0,
    filesWithErrors: 0,
    filesWithWarnings: 0,
    totalErrors: 0,
    totalWarnings: 0,
    totalInfo: 0,
    byRule: {}
  }

  function walkDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walkDir(fullPath)
      } else if (entry.name.endsWith('.adoc')) {
        summary.totalFiles++
        const result = validateFile(fullPath, { ...options, basePath: dirPath })

        if (result.errors.length > 0) summary.filesWithErrors++
        if (result.warnings.length > 0) summary.filesWithWarnings++
        summary.totalErrors += result.errors.length
        summary.totalWarnings += result.warnings.length
        summary.totalInfo += result.info.length

        // Track by rule
        for (const err of [...result.errors, ...result.warnings, ...result.info]) {
          if (!summary.byRule[err.rule]) {
            summary.byRule[err.rule] = { errors: 0, warnings: 0, info: 0 }
          }
          if (result.errors.includes(err)) summary.byRule[err.rule].errors++
          else if (result.warnings.includes(err)) summary.byRule[err.rule].warnings++
          else summary.byRule[err.rule].info++
        }

        if (result.errors.length > 0 || result.warnings.length > 0 ||
            (options.showInfo && result.info.length > 0)) {
          results.push(result)
        }
      }
    }
  }

  walkDir(dirPath)

  return { results, summary }
}

/**
 * Format validation results for console output
 */
function formatResults(validationOutput, options = {}) {
  const { results, summary } = validationOutput
  const lines = []

  lines.push('\n' + '='.repeat(60))
  lines.push('RPK DOCUMENTATION VALIDATION REPORT')
  lines.push('='.repeat(60))

  // Summary
  lines.push(`\nFiles scanned: ${summary.totalFiles}`)
  lines.push(`Files with errors: ${summary.filesWithErrors}`)
  lines.push(`Files with warnings: ${summary.filesWithWarnings}`)
  lines.push(`Total errors: ${summary.totalErrors}`)
  lines.push(`Total warnings: ${summary.totalWarnings}`)

  // By rule
  if (Object.keys(summary.byRule).length > 0) {
    lines.push('\nIssues by rule:')
    for (const [rule, counts] of Object.entries(summary.byRule)) {
      const parts = []
      if (counts.errors > 0) parts.push(`${counts.errors} errors`)
      if (counts.warnings > 0) parts.push(`${counts.warnings} warnings`)
      if (counts.info > 0) parts.push(`${counts.info} info`)
      lines.push(`  ${rule}: ${parts.join(', ')}`)
    }
  }

  // Details
  if (results.length > 0 && !options.summaryOnly) {
    lines.push('\n' + '-'.repeat(60))
    lines.push('DETAILS')
    lines.push('-'.repeat(60))

    for (const result of results) {
      lines.push(`\n${result.file}:`)
      for (const err of result.errors) {
        lines.push(`  ❌ [${err.rule}] Line ${err.line}: ${err.message}`)
      }
      for (const warn of result.warnings) {
        lines.push(`  ⚠️  [${warn.rule}] Line ${warn.line}: ${warn.message}`)
      }
      if (options.showInfo) {
        for (const info of result.info) {
          lines.push(`  ℹ️  [${info.rule}] Line ${info.line}: ${info.message}`)
        }
      }
    }
  }

  lines.push('\n' + '='.repeat(60))

  return lines.join('\n')
}

module.exports = {
  validateFile,
  validateDirectory,
  formatResults,
  VALIDATION_RULES
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2)
  const dirPath = args[0] || '.'

  if (!fs.existsSync(dirPath)) {
    console.error(`Directory not found: ${dirPath}`)
    process.exit(1)
  }

  const options = {
    showInfo: args.includes('--info'),
    summaryOnly: args.includes('--summary')
  }

  const output = validateDirectory(dirPath, options)
  console.log(formatResults(output, options))

  // Exit with error if any errors found
  if (output.summary.totalErrors > 0) {
    process.exit(1)
  }
}
