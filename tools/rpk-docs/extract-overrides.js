'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Extract custom content from existing rpk docs and generate override suggestions
 *
 * This tool scans existing rpk documentation files, identifies editorial content
 * that would be lost during auto-generation, and produces override entries
 * that preserve this content.
 */

/**
 * Parse an AsciiDoc file and extract its structure
 * @param {string} content - File content
 * @returns {Object} Parsed structure
 */
function parseAsciiDoc(content) {
  const result = {
    title: '',
    attributes: {},
    description: '',
    includesAfterHeader: [],
    includesAfterDescription: [],
    usageSection: '',
    flagsSection: '',
    customSections: [],
    conditionalBlocks: [],
    contentAfterFlags: '',
    seeAlso: [],
    rawContent: content
  }

  const lines = content.split('\n')
  let currentSection = 'header'
  let sectionContent = []
  let inConditional = null
  let conditionalContent = []
  let conditionalDepth = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmedLine = line.trim()

    // Extract title
    if (trimmedLine.startsWith('= ') && !result.title) {
      result.title = trimmedLine.substring(2).trim()
      continue
    }

    // Extract attributes
    if (trimmedLine.startsWith(':') && trimmedLine.includes(':') && currentSection === 'header') {
      const match = trimmedLine.match(/^:([^:]+):\s*(.*)$/)
      if (match) {
        result.attributes[match[1]] = match[2]
      }
      continue
    }

    // Track conditional blocks (ifdef/ifndef)
    if (trimmedLine.startsWith('ifdef::') || trimmedLine.startsWith('ifndef::')) {
      if (conditionalDepth === 0) {
        inConditional = {
          type: trimmedLine.startsWith('ifdef::') ? 'ifdef' : 'ifndef',
          condition: trimmedLine.match(/::(.*)\[\]/)?.[1] || '',
          content: [],
          startLine: i
        }
      }
      conditionalDepth++
      if (conditionalDepth > 1) {
        inConditional.content.push(line)
      }
      continue
    }

    if (trimmedLine === 'endif::[]') {
      conditionalDepth--
      if (conditionalDepth === 0 && inConditional) {
        inConditional.endLine = i
        result.conditionalBlocks.push(inConditional)
        inConditional = null
      } else if (conditionalDepth > 0 && inConditional) {
        inConditional.content.push(line)
      }
      continue
    }

    if (inConditional && conditionalDepth > 0) {
      inConditional.content.push(line)
      continue
    }

    // Extract includes
    if (trimmedLine.startsWith('include::')) {
      const includePath = trimmedLine.match(/include::([^\[]+)/)?.[1]
      if (includePath) {
        if (currentSection === 'header' || currentSection === 'description') {
          result.includesAfterHeader.push(includePath)
        } else {
          result.includesAfterDescription.push(includePath)
        }
      }
      continue
    }

    // Detect section transitions
    if (trimmedLine === '== Usage') {
      if (currentSection === 'header' || currentSection === 'description') {
        result.description = sectionContent.join('\n').trim()
      }
      currentSection = 'usage'
      sectionContent = []
      continue
    }

    if (trimmedLine === '== Flags') {
      if (currentSection === 'usage') {
        result.usageSection = sectionContent.join('\n').trim()
      }
      currentSection = 'flags'
      sectionContent = []
      continue
    }

    if (trimmedLine === '== Global flags') {
      if (currentSection === 'flags') {
        result.flagsSection = sectionContent.join('\n').trim()
      }
      currentSection = 'globalflags'
      sectionContent = []
      continue
    }

    // Detect custom sections (== or === headers after flags)
    if ((trimmedLine.startsWith('== ') || trimmedLine.startsWith('=== ')) &&
        (currentSection === 'flags' || currentSection === 'globalflags' || currentSection === 'custom')) {

      // Save previous section
      if (currentSection === 'flags') {
        result.flagsSection = sectionContent.join('\n').trim()
      } else if (sectionContent.length > 0) {
        const lastCustom = result.customSections[result.customSections.length - 1]
        if (lastCustom) {
          lastCustom.content = sectionContent.join('\n').trim()
        }
      }

      // Start new custom section
      const level = trimmedLine.startsWith('=== ') ? 3 : 2
      const title = trimmedLine.substring(level + 1).trim()

      // Check if it's a "See also" or "Related topics" section
      if (title.toLowerCase() === 'see also' || title.toLowerCase() === 'related topics') {
        currentSection = 'seealso'
      } else {
        result.customSections.push({
          title,
          level,
          content: ''
        })
        currentSection = 'custom'
      }
      sectionContent = []
      continue
    }

    // Collect content
    sectionContent.push(line)
  }

  // Handle remaining content
  if (currentSection === 'seealso') {
    // Extract see also links
    const seeAlsoContent = sectionContent.join('\n')
    const xrefMatches = seeAlsoContent.matchAll(/xref:([^\[]+)\[([^\]]*)\]/g)
    for (const match of xrefMatches) {
      result.seeAlso.push(`xref:${match[1]}[${match[2]}]`)
    }
  } else if (currentSection === 'custom' && result.customSections.length > 0) {
    result.customSections[result.customSections.length - 1].content = sectionContent.join('\n').trim()
  } else if (currentSection === 'flags') {
    result.flagsSection = sectionContent.join('\n').trim()
  }

  return result
}

/**
 * Determine the command path from a file path
 * @param {string} filePath - Path to the .adoc file
 * @param {string} baseDir - Base rpk docs directory
 * @returns {string} Command path (e.g., "rpk topic create")
 */
function filePathToCommandPath(filePath, baseDir) {
  const relativePath = path.relative(baseDir, filePath)
  const withoutExt = relativePath.replace(/\.adoc$/, '')

  // Convert path separators and dashes to spaces
  // e.g., "rpk-topic/rpk-topic-create" -> "rpk topic create"
  const parts = withoutExt.split(path.sep)
  const lastPart = parts[parts.length - 1]

  return lastPart.replace(/-/g, ' ')
}

/**
 * Clean up extracted content by removing markers and noise
 * @param {string} content
 * @returns {string}
 */
function cleanContent(content) {
  if (!content) return ''
  return content
    // Remove single-source tags
    .replace(/\/\/\s*tag::single-source\[\]\s*/g, '')
    .replace(/\/\/\s*end::single-source\[\]\s*/g, '')
    // Remove trailing endif markers that got captured
    .replace(/\s*endif::\[\]\s*$/g, '')
    // Clean up multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Check if content is meaningful (not just whitespace or comments)
 * @param {string} content
 * @returns {boolean}
 */
function isMeaningfulContent(content) {
  if (!content) return false
  const cleaned = cleanContent(content)
  if (!cleaned) return false
  return true
}

/**
 * Extract override suggestions from a parsed document
 * @param {Object} parsed - Parsed AsciiDoc structure
 * @param {string} commandPath - Command path
 * @returns {Object|null} Override suggestion or null if no custom content
 */
function extractOverrideSuggestion(parsed, commandPath) {
  const override = {}
  let hasCustomContent = false

  // Check for custom description (more than just the auto-generated short desc)
  if (parsed.description && parsed.description.length > 100) {
    // Check if description has multiple paragraphs or detailed content
    const paragraphs = parsed.description.split(/\n\n+/).filter(p => p.trim())
    if (paragraphs.length > 1) {
      override.appendToDescription = cleanContent(paragraphs.slice(1).join('\n\n'))
      hasCustomContent = true
    }
  }

  // Check for includes
  if (parsed.includesAfterHeader.length > 0) {
    override.includes = override.includes || {}
    override.includes.after_header = parsed.includesAfterHeader
    hasCustomContent = true
  }

  // Check for unsupported-os attribute - convert to a note
  if (parsed.attributes['unsupported-os']) {
    const unsupportedOs = parsed.attributes['unsupported-os']
    override.notes = override.notes || {}
    override.notes.after_header = `This command is not supported on ${unsupportedOs}.`
    hasCustomContent = true
  }

  // Check for custom sections
  if (parsed.customSections.length > 0) {
    override.customSections = {}
    for (const section of parsed.customSections) {
      const cleanedContent = cleanContent(section.content)
      if (isMeaningfulContent(cleanedContent)) {
        const key = section.title.toLowerCase().replace(/\s+/g, '-')
        override.customSections[key] = {
          title: section.title,
          content: cleanedContent,
          position: 'after_flags'
        }
        hasCustomContent = true
      }
    }
    if (Object.keys(override.customSections).length === 0) {
      delete override.customSections
    }
  }

  // Check for see also links
  if (parsed.seeAlso.length > 0) {
    override.seeAlso = parsed.seeAlso
    hasCustomContent = true
  }

  // Check for conditional blocks (cloud/self-hosted specific content)
  for (const block of parsed.conditionalBlocks) {
    const content = cleanContent(block.content.join('\n'))
    if (isMeaningfulContent(content)) {
      if (block.type === 'ifdef' && block.condition === 'env-cloud') {
        override.cloudContent = override.cloudContent || {}
        override.cloudContent.after_flags = content
        hasCustomContent = true
      } else if (block.type === 'ifndef' && block.condition === 'env-cloud') {
        override.selfHostedContent = override.selfHostedContent || {}
        override.selfHostedContent.after_flags = content
        hasCustomContent = true
      }
    }
  }

  return hasCustomContent ? override : null
}

/**
 * Scan a directory of rpk docs and extract override suggestions
 * @param {string} docsDir - Path to rpk docs directory
 * @param {Object} existingOverrides - Current overrides to merge with
 * @returns {Object} Results with suggestions and report
 */
function extractOverridesFromDocs(docsDir, existingOverrides = {}) {
  const results = {
    suggestions: {},
    report: {
      totalFiles: 0,
      filesWithCustomContent: 0,
      newOverrides: 0,
      updatedOverrides: 0,
      details: []
    }
  }

  const existingCommands = existingOverrides.commands || {}

  function processDirectory(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        processDirectory(fullPath)
      } else if (entry.isFile() && entry.name.endsWith('.adoc')) {
        results.report.totalFiles++

        try {
          const content = fs.readFileSync(fullPath, 'utf8')
          const parsed = parseAsciiDoc(content)
          const commandPath = filePathToCommandPath(fullPath, docsDir)

          const suggestion = extractOverrideSuggestion(parsed, commandPath)

          if (suggestion) {
            results.report.filesWithCustomContent++

            const existing = existingCommands[commandPath]
            if (existing) {
              // Merge with existing, only add new fields
              const merged = { ...existing }
              let hasNewContent = false

              for (const [key, value] of Object.entries(suggestion)) {
                if (!existing[key]) {
                  merged[key] = value
                  hasNewContent = true
                }
              }

              if (hasNewContent) {
                results.suggestions[commandPath] = merged
                results.report.updatedOverrides++
                results.report.details.push({
                  file: fullPath,
                  commandPath,
                  action: 'update',
                  newFields: Object.keys(suggestion).filter(k => !existing[k])
                })
              }
            } else {
              results.suggestions[commandPath] = suggestion
              results.report.newOverrides++
              results.report.details.push({
                file: fullPath,
                commandPath,
                action: 'new',
                fields: Object.keys(suggestion)
              })
            }
          }
        } catch (err) {
          console.error(`Error processing ${fullPath}: ${err.message}`)
        }
      }
    }
  }

  processDirectory(docsDir)
  return results
}

/**
 * Generate a migration report
 * @param {Object} results - Results from extractOverridesFromDocs
 * @returns {string} Markdown report
 */
function generateReport(results) {
  const lines = [
    '# RPK Docs Override Migration Report',
    '',
    '## Summary',
    '',
    `- **Total files scanned:** ${results.report.totalFiles}`,
    `- **Files with custom content:** ${results.report.filesWithCustomContent}`,
    `- **New overrides to add:** ${results.report.newOverrides}`,
    `- **Existing overrides to update:** ${results.report.updatedOverrides}`,
    ''
  ]

  if (results.report.details.length > 0) {
    lines.push('## Details', '')

    const newOverrides = results.report.details.filter(d => d.action === 'new')
    const updates = results.report.details.filter(d => d.action === 'update')

    if (newOverrides.length > 0) {
      lines.push('### New Overrides', '')
      for (const detail of newOverrides) {
        lines.push(`- **${detail.commandPath}**`)
        lines.push(`  - File: \`${detail.file}\``)
        lines.push(`  - Content types: ${detail.fields.join(', ')}`)
        lines.push('')
      }
    }

    if (updates.length > 0) {
      lines.push('### Updates to Existing Overrides', '')
      for (const detail of updates) {
        lines.push(`- **${detail.commandPath}**`)
        lines.push(`  - File: \`${detail.file}\``)
        lines.push(`  - New fields: ${detail.newFields.join(', ')}`)
        lines.push('')
      }
    }
  }

  return lines.join('\n')
}

/**
 * Main extraction function
 * @param {string} docsDir - Path to rpk docs directory
 * @param {string} overridesPath - Path to existing overrides JSON
 * @param {Object} options - Options
 * @returns {Object} Results
 */
function extractOverrides(docsDir, overridesPath, options = {}) {
  // Load existing overrides
  let existingOverrides = {}
  if (overridesPath && fs.existsSync(overridesPath)) {
    try {
      existingOverrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
    } catch (err) {
      console.warn(`Warning: Could not load existing overrides: ${err.message}`)
    }
  }

  // Extract suggestions
  const results = extractOverridesFromDocs(docsDir, existingOverrides)

  // Generate outputs
  const report = generateReport(results)

  // Build merged overrides
  const mergedOverrides = {
    ...existingOverrides,
    commands: {
      ...(existingOverrides.commands || {}),
      ...results.suggestions
    }
  }

  return {
    suggestions: results.suggestions,
    report,
    mergedOverrides,
    stats: results.report
  }
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2)

  if (args.length < 1) {
    console.log('Usage: node extract-overrides.js <docs-dir> [overrides-path] [--output-json <path>] [--output-report <path>]')
    console.log('')
    console.log('Arguments:')
    console.log('  docs-dir        Path to rpk docs directory (e.g., ../docs/modules/reference/pages/rpk)')
    console.log('  overrides-path  Path to existing rpk-overrides.json (optional)')
    console.log('')
    console.log('Options:')
    console.log('  --output-json <path>    Write merged overrides to file')
    console.log('  --output-report <path>  Write migration report to file')
    console.log('  --dry-run               Print report without writing files')
    process.exit(1)
  }

  const docsDir = args[0]
  let overridesPath = null
  let outputJson = null
  let outputReport = null
  let dryRun = false

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--output-json' && args[i + 1]) {
      outputJson = args[++i]
    } else if (args[i] === '--output-report' && args[i + 1]) {
      outputReport = args[++i]
    } else if (args[i] === '--dry-run') {
      dryRun = true
    } else if (!args[i].startsWith('--')) {
      overridesPath = args[i]
    }
  }

  if (!fs.existsSync(docsDir)) {
    console.error(`Error: Docs directory not found: ${docsDir}`)
    process.exit(1)
  }

  console.log(`Extracting overrides from: ${docsDir}`)
  if (overridesPath) {
    console.log(`Using existing overrides: ${overridesPath}`)
  }

  const results = extractOverrides(docsDir, overridesPath)

  console.log('')
  console.log(results.report)

  if (!dryRun) {
    if (outputJson) {
      fs.writeFileSync(outputJson, JSON.stringify(results.mergedOverrides, null, 2))
      console.log(`\nWrote merged overrides to: ${outputJson}`)
    }

    if (outputReport) {
      fs.writeFileSync(outputReport, results.report)
      console.log(`Wrote report to: ${outputReport}`)
    }
  }

  console.log(`\nFound ${Object.keys(results.suggestions).length} commands with custom content to migrate`)
}

module.exports = {
  extractOverrides,
  extractOverridesFromDocs,
  parseAsciiDoc,
  extractOverrideSuggestion,
  generateReport,
  filePathToCommandPath
}
