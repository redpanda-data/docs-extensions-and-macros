'use strict'

const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { findRepoRoot } = require('./doc-tools-utils')

/**
 * Run the cluster documentation generator script for a specific release/tag.
 *
 * Invokes the external `generate-cluster-docs.sh` script with the provided mode, tag,
 * and Docker-related options.
 *
 * @param {string} mode - Operation mode passed to the script (for example, "generate" or "clean").
 * @param {string} tag - Release tag or version to generate docs for.
 * @param {Object} options - Runtime options.
 * @param {string} options.dockerRepo - Docker repository used by the script.
 * @param {string} options.consoleTag - Console image tag passed to the script.
 * @param {string} options.consoleDockerRepo - Console Docker repository used by the script.
 */
function runClusterDocs (mode, tag, options) {
  const script = path.join(__dirname, 'generate-cluster-docs.sh')
  const args = [mode, tag, options.dockerRepo, options.consoleTag, options.consoleDockerRepo]
  console.log(`Running ${script} with arguments: ${args.join(' ')}`)
  const r = spawnSync('bash', [script, ...args], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status)
}

/**
 * Cleanup old diff files, keeping only the 2 most recent.
 *
 * @param {string} diffDir - Directory containing diff files
 */
function cleanupOldDiffs (diffDir) {
  try {
    console.log('Cleaning up old diff JSON files (keeping only 2 most recent)…')

    const absoluteDiffDir = path.resolve(diffDir)
    if (!fs.existsSync(absoluteDiffDir)) {
      return
    }

    // Get all diff files sorted by modification time (newest first)
    const files = fs.readdirSync(absoluteDiffDir)
      .filter(file => file.startsWith('redpanda-property-changes-') && file.endsWith('.json'))
      .map(file => ({
        name: file,
        path: path.join(absoluteDiffDir, file),
        time: fs.statSync(path.join(absoluteDiffDir, file)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time)

    // Delete all but the 2 most recent
    if (files.length > 2) {
      files.slice(2).forEach(file => {
        console.log(`   Removing old file: ${file.name}`)
        fs.unlinkSync(file.path)
      })
    }
  } catch (error) {
    console.error(`  Failed to cleanup old diff files: ${error.message}`)
  }
}

/**
 * Generate a detailed JSON report describing property changes between two releases.
 *
 * @param {string} oldTag - Release tag or identifier for the "old" properties set.
 * @param {string} newTag - Release tag or identifier for the "new" properties set.
 * @param {string} outputDir - Directory where the comparison report will be written.
 */
function generatePropertyComparisonReport (oldTag, newTag, outputDir) {
  try {
    console.log('\nGenerating detailed property comparison report...')

    // Look for the property JSON files in the standard location
    const repoRoot = findRepoRoot()
    const attachmentsDir = path.join(repoRoot, 'modules/reference/attachments')
    const oldJsonPath = path.join(attachmentsDir, `redpanda-properties-${oldTag}.json`)
    const newJsonPath = path.join(attachmentsDir, `redpanda-properties-${newTag}.json`)

    if (!fs.existsSync(oldJsonPath)) {
      console.log(`Warning: Old properties JSON not found at: ${oldJsonPath}`)
      console.log('   Skipping detailed property comparison.')
      return
    }

    if (!fs.existsSync(newJsonPath)) {
      console.log(`Warning: New properties JSON not found at: ${newJsonPath}`)
      console.log('   Skipping detailed property comparison.')
      return
    }

    // Ensure output directory exists
    const absoluteOutputDir = path.resolve(outputDir)
    fs.mkdirSync(absoluteOutputDir, { recursive: true })

    // Run the property comparison tool
    const propertyExtractorDir = path.resolve(__dirname, '../tools/property-extractor')
    const compareScript = path.join(propertyExtractorDir, 'compare-properties.js')
    const reportFilename = `redpanda-property-changes-${oldTag}-to-${newTag}.json`
    const reportPath = path.join(absoluteOutputDir, reportFilename)
    const args = [compareScript, oldJsonPath, newJsonPath, oldTag, newTag, absoluteOutputDir, reportFilename]

    const result = spawnSync('node', args, {
      stdio: 'inherit',
      cwd: propertyExtractorDir
    })

    if (result.error) {
      console.error(`Error: Property comparison failed: ${result.error.message}`)
    } else if (result.status !== 0) {
      console.error(`Error: Property comparison exited with code: ${result.status}`)
    } else {
      console.log(`Done: Property comparison report saved to: ${reportPath}`)
    }
  } catch (error) {
    console.error(`Error: Error generating property comparison: ${error.message}`)
  }
}

/**
 * Update property overrides file with version information for new properties
 *
 * @param {string} overridesPath - Path to property-overrides.json file
 * @param {object} diffData - Diff data from property comparison
 * @param {string} newTag - Version tag for new properties (e.g., "v25.3.3")
 */
function updatePropertyOverridesWithVersion (overridesPath, diffData, newTag) {
  try {
    console.log('\nUpdating property overrides with version information...')

    // Load existing overrides
    let overridesRoot = { properties: {} }
    if (fs.existsSync(overridesPath)) {
      const overridesContent = fs.readFileSync(overridesPath, 'utf8')
      overridesRoot = JSON.parse(overridesContent)

      if (!overridesRoot.properties) {
        overridesRoot.properties = {}
      }
    }

    const overrides = overridesRoot.properties
    const newProperties = diffData.details?.newProperties || []

    if (newProperties.length === 0) {
      console.log('   No new properties to update')
      return
    }

    let updatedCount = 0
    let createdCount = 0

    newProperties.forEach(prop => {
      const propertyName = prop.name

      if (overrides[propertyName]) {
        if (overrides[propertyName].version !== newTag) {
          overrides[propertyName].version = newTag
          updatedCount++
        }
      } else {
        overrides[propertyName] = { version: newTag }
        createdCount++
      }
    })

    // Save updated overrides (sorted)
    const sortedOverrides = {}
    Object.keys(overrides).sort().forEach(key => {
      sortedOverrides[key] = overrides[key]
    })

    overridesRoot.properties = sortedOverrides
    fs.writeFileSync(overridesPath, JSON.stringify(overridesRoot, null, 2) + '\n', 'utf8')

    if (updatedCount > 0 || createdCount > 0) {
      console.log('Done: Updated property overrides:')
      if (createdCount > 0) {
        console.log(`   • Created ${createdCount} new override ${createdCount === 1 ? 'entry' : 'entries'}`)
      }
      if (updatedCount > 0) {
        console.log(`   • Updated ${updatedCount} existing override ${updatedCount === 1 ? 'entry' : 'entries'}`)
      }

      newProperties.forEach(prop => {
        console.log(`   • ${prop.name} → ${newTag}`)
      })
    }
  } catch (error) {
    console.error(`Warning: Failed to update property overrides: ${error.message}`)
  }
}

/**
 * Create a unified diff patch between two directories and clean them up.
 *
 * @param {string} kind - Logical category for the diff (for example, "metrics" or "rpk")
 * @param {string} oldTag - Identifier for the "old" version
 * @param {string} newTag - Identifier for the "new" version
 * @param {string} oldTempDir - Path to the directory containing the old output
 * @param {string} newTempDir - Path to the directory containing the new output
 */
function diffDirs (kind, oldTag, newTag, oldTempDir, newTempDir) {
  // Backwards compatibility: if temp directories not provided, use autogenerated paths
  if (!oldTempDir) {
    oldTempDir = path.join('autogenerated', oldTag, kind)
  }
  if (!newTempDir) {
    newTempDir = path.join('autogenerated', newTag, kind)
  }

  const diffDir = path.join('tmp', 'diffs', kind, `${oldTag}_to_${newTag}`)

  if (!fs.existsSync(oldTempDir)) {
    console.error(`Error: Cannot diff: missing ${oldTempDir}`)
    process.exit(1)
  }
  if (!fs.existsSync(newTempDir)) {
    console.error(`Error: Cannot diff: missing ${newTempDir}`)
    process.exit(1)
  }

  fs.mkdirSync(diffDir, { recursive: true })

  // Generate traditional patch
  const patch = path.join(diffDir, 'changes.patch')
  const cmd = `diff -ru "${oldTempDir}" "${newTempDir}" > "${patch}" || true`
  const res = spawnSync(cmd, { stdio: 'inherit', shell: true })

  if (res.error) {
    console.error(`Error: diff failed: ${res.error.message}`)
    process.exit(1)
  }
  console.log(`Done: Wrote patch: ${patch}`)

  // Safety guard: only clean up directories that are explicitly passed as temp directories
  const tmpRoot = path.resolve('tmp') + path.sep
  const workspaceRoot = path.resolve('.') + path.sep

  // Only clean up if directories were explicitly provided as temp directories
  const explicitTempDirs = arguments.length >= 5

  if (explicitTempDirs) {
    [oldTempDir, newTempDir].forEach(dirPath => {
      const resolvedPath = path.resolve(dirPath) + path.sep
      const isInTmp = resolvedPath.startsWith(tmpRoot)
      const isInWorkspace = resolvedPath.startsWith(workspaceRoot)

      if (isInWorkspace && isInTmp) {
        try {
          fs.rmSync(dirPath, { recursive: true, force: true })
          console.log(`🧹 Cleaned up temporary directory: ${dirPath}`)
        } catch (err) {
          console.warn(`Warning: Could not clean up directory ${dirPath}: ${err.message}`)
        }
      } else {
        console.log(`ℹ️  Skipping cleanup of directory outside tmp/: ${dirPath}`)
      }
    })
  } else {
    console.log('ℹ️  Using autogenerated directories - skipping cleanup for safety')
  }
}

module.exports = {
  runClusterDocs,
  cleanupOldDiffs,
  generatePropertyComparisonReport,
  updatePropertyOverridesWithVersion,
  diffDirs
}
