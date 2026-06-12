#!/usr/bin/env node

/**
 * Extract conditional blocks (ifdef/ifndef) and includes from original rpk docs
 * and add them to rpk-overrides.json
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const docsDir = process.argv[2] || '../docs'
const rpkDir = path.join(docsDir, 'modules/reference/pages/rpk')
const overridesPath = path.join(__dirname, '../../docs-data/rpk-overrides.json')

// Validate docsDir exists and is a directory
if (!fs.existsSync(docsDir) || !fs.statSync(docsDir).isDirectory()) {
  console.error(`ERROR: Invalid docs directory: ${docsDir}`)
  process.exit(1)
}

console.log('Extracting conditional content from original rpk docs...')
console.log(`  Docs directory: ${docsDir}`)
console.log(`  Overrides file: ${overridesPath}`)

// Get list of modified files using spawnSync to avoid command injection
const gitDiffResult = spawnSync('git', ['diff', '--name-only', 'modules/reference/pages/rpk/'], {
  cwd: docsDir,
  encoding: 'utf8'
})

if (gitDiffResult.error) {
  console.error(`ERROR: Failed to run git diff: ${gitDiffResult.error.message}`)
  process.exit(1)
}

const modifiedFilesOutput = gitDiffResult.stdout

const modifiedFiles = modifiedFilesOutput
  .trim()
  .split('\n')
  .filter(f => f.endsWith('.adoc'))

console.log(`\nFound ${modifiedFiles.length} modified files`)

// Load existing overrides
let overrides = {}
if (fs.existsSync(overridesPath)) {
  overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
}

let extractedCount = 0
let filesWithContent = 0

for (const relPath of modifiedFiles) {
  // Get the command path from filename
  // e.g., "rpk/rpk-cluster/rpk-cluster-config.adoc" → "rpk cluster config"
  const filename = path.basename(relPath, '.adoc')
  const commandPath = filename.replace(/-/g, ' ')

  // Get the original content (before changes)
  try {
    const gitShowResult = spawnSync('git', ['show', `HEAD:${relPath}`], {
      cwd: docsDir,
      encoding: 'utf8'
    })

    if (gitShowResult.error || gitShowResult.status !== 0) {
      throw new Error(gitShowResult.stderr || 'git show failed')
    }

    const originalContent = gitShowResult.stdout

    // Extract conditional blocks and includes
    const conditionals = []
    const includes = []

    const lines = originalContent.split('\n')
    let inConditional = false
    let conditionalStart = -1
    let conditionalLines = []
    let conditionalType = null

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Check for conditional start
      if (/^(ifdef|ifndef)::/.test(line)) {
        inConditional = true
        conditionalStart = i
        conditionalLines = [line]
        conditionalType = line
      } else if (inConditional) {
        conditionalLines.push(line)
        if (/^endif::/.test(line)) {
          // End of conditional block
          conditionals.push({
            startLine: conditionalStart,
            endLine: i,
            type: conditionalType,
            content: conditionalLines.join('\n')
          })
          inConditional = false
          conditionalLines = []
        }
      }

      // Check for includes
      if (/^include::/.test(line)) {
        includes.push({
          line: i,
          content: line
        })
      }
    }

    // Add to overrides if we found content
    if (conditionals.length > 0 || includes.length > 0) {
      filesWithContent++

      if (!overrides[commandPath]) {
        overrides[commandPath] = { content: [] }
      }

      if (!overrides[commandPath].content) {
        overrides[commandPath].content = []
      }

      // Add conditionals
      for (const cond of conditionals) {
        const lines = cond.content.split('\n')
        const isCloudOnly = cond.type.includes('ifdef::env-cloud')
        const isSelfHostedOnly = cond.type.includes('ifndef::env-cloud')

        // Extract the actual content (skip ifdef/endif lines)
        const innerContent = lines.slice(1, -1).join('\n').trim()

        if (innerContent) {
          overrides[commandPath].content.push({
            type: isCloudOnly ? 'cloud-only' : 'self-hosted',
            position: 'after_description',
            content: innerContent,
            note: `Extracted from line ${cond.startLine + 1}`
          })
          extractedCount++
        }
      }

      // Add includes
      for (const inc of includes) {
        overrides[commandPath].content.push({
          type: 'include',
          position: 'after_description',
          path: inc.content,
          note: `Extracted from line ${inc.line + 1}`
        })
        extractedCount++
      }
    }
  } catch (err) {
    console.warn(`  ⚠ Could not read original ${relPath}: ${err.message}`)
  }
}

console.log(`\nExtracted ${extractedCount} content items from ${filesWithContent} files`)

// Save overrides
fs.writeFileSync(overridesPath, JSON.stringify(overrides, null, 2))
console.log(`\n✓ Updated ${overridesPath}`)
