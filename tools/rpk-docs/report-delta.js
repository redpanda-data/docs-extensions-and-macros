'use strict'

/**
 * Diff generator for rpk command documentation
 * Compares two rpk command trees and generates a detailed diff report
 */

/**
 * Deep equality check that handles object key ordering
 * Objects with same keys in different order are considered equal
 * @param {*} a - First value
 * @param {*} b - Second value
 * @returns {boolean} True if values are deeply equal
 */
function deepEqual(a, b) {
  // Handle primitives and null/undefined
  if (a === b) return true
  if (a == null || b == null) return a === b
  if (typeof a !== typeof b) return false

  // Handle arrays
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }

  // Handle objects
  if (typeof a === 'object') {
    const keysA = Object.keys(a).sort()
    const keysB = Object.keys(b).sort()
    if (keysA.length !== keysB.length) return false
    if (!keysA.every((key, i) => key === keysB[i])) return false
    return keysA.every(key => deepEqual(a[key], b[key]))
  }

  // Primitives that aren't strictly equal
  return false
}

/**
 * Flatten command tree into a map of path -> command
 * @param {Object} node - Tree node
 * @param {string} parentPath - Parent command path
 * @returns {Map} Map of command path to command object
 */
function flattenToMap(node, parentPath = '') {
  const result = new Map()

  // Defensive check for missing or invalid node
  if (!node || typeof node !== 'object') {
    return result
  }

  // Validate node.name exists and is a non-empty string
  const nodeName = node.name
  if (typeof nodeName !== 'string' || nodeName.trim() === '') {
    // Skip nodes without valid names but still process children
    if (node.commands && Array.isArray(node.commands)) {
      for (const child of node.commands) {
        const childMap = flattenToMap(child, parentPath)
        for (const [path, cmd] of childMap) {
          result.set(path, cmd)
        }
      }
    }
    return result
  }

  const currentPath = parentPath ? `${parentPath} ${nodeName}` : nodeName
  result.set(currentPath, node)

  if (node.commands && Array.isArray(node.commands)) {
    for (const child of node.commands) {
      const childMap = flattenToMap(child, currentPath)
      for (const [path, cmd] of childMap) {
        result.set(path, cmd)
      }
    }
  }

  return result
}

/**
 * Get flags as a map of name -> flag
 * @param {Object} command - Command object
 * @returns {Map} Map of flag name to flag object
 */
function getFlagsMap(command) {
  const flags = command.flags || []
  return new Map(flags.map(f => [f.name, f]))
}

/**
 * Compare two flags and find differences
 * @param {Object} oldFlag - Old flag object
 * @param {Object} newFlag - New flag object
 * @returns {Object|null} Differences or null if identical
 */
function compareFlags(oldFlag, newFlag) {
  // Defensive checks for missing flags
  if (!oldFlag || !newFlag) {
    return null
  }

  const changes = {}

  if (oldFlag.type !== newFlag.type) {
    changes.type = { old: oldFlag.type, new: newFlag.type }
  }

  if (!deepEqual(oldFlag.default, newFlag.default)) {
    changes.default = { old: oldFlag.default, new: newFlag.default }
  }

  if (oldFlag.description !== newFlag.description) {
    changes.description = { old: oldFlag.description, new: newFlag.description }
  }

  if (oldFlag.required !== newFlag.required) {
    changes.required = { old: oldFlag.required, new: newFlag.required }
  }

  return Object.keys(changes).length > 0 ? changes : null
}

/**
 * Generate diff between two rpk command trees
 * @param {Object} oldTree - Old command tree
 * @param {Object} newTree - New command tree
 * @param {Object} options - Options
 * @returns {Object} Diff report
 */
function generateRpkDiff(oldTree, newTree, options = {}) {
  const { oldVersion = 'old', newVersion = 'new' } = options

  const oldCommands = flattenToMap(oldTree)
  const newCommands = flattenToMap(newTree)

  const oldPaths = new Set(oldCommands.keys())
  const newPaths = new Set(newCommands.keys())

  // Find new commands
  const newCommandPaths = [...newPaths].filter(p => !oldPaths.has(p))
  const newCommandsDetails = newCommandPaths.map(path => {
    const cmd = newCommands.get(path)
    return {
      path,
      name: cmd.name,
      description: cmd.description || '',
      introducedInVersion: newVersion
    }
  })

  // Find removed commands
  const removedCommandPaths = [...oldPaths].filter(p => !newPaths.has(p))
  const removedCommandsDetails = removedCommandPaths.map(path => {
    const cmd = oldCommands.get(path)
    return {
      path,
      name: cmd.name,
      description: cmd.description || '',
      removedInVersion: newVersion
    }
  })

  // Find flag changes in existing commands
  const newFlags = []
  const removedFlags = []
  const changedDefaults = []
  const descriptionChanges = []

  for (const path of newPaths) {
    if (!oldPaths.has(path)) continue // Skip new commands

    const oldCmd = oldCommands.get(path)
    const newCmd = newCommands.get(path)

    const oldFlags = getFlagsMap(oldCmd)
    const newFlagsMap = getFlagsMap(newCmd)

    // Find new flags
    for (const [flagName, flag] of newFlagsMap) {
      if (!oldFlags.has(flagName)) {
        newFlags.push({
          commandPath: path,
          flagName,
          type: flag.type,
          description: flag.description,
          default: flag.default,
          introducedInVersion: newVersion
        })
      }
    }

    // Find removed flags
    for (const [flagName, flag] of oldFlags) {
      if (!newFlagsMap.has(flagName)) {
        removedFlags.push({
          commandPath: path,
          flagName,
          type: flag.type,
          description: flag.description,
          removedInVersion: newVersion
        })
      }
    }

    // Find changed flags
    for (const [flagName, newFlag] of newFlagsMap) {
      if (!oldFlags.has(flagName)) continue

      const oldFlag = oldFlags.get(flagName)
      const changes = compareFlags(oldFlag, newFlag)

      if (changes) {
        if (changes.default) {
          changedDefaults.push({
            commandPath: path,
            flagName,
            oldDefault: changes.default.old,
            newDefault: changes.default.new
          })
        }
      }
    }

    // Check command description changes
    if (oldCmd.description !== newCmd.description) {
      descriptionChanges.push({
        path,
        type: 'command',
        oldDescription: oldCmd.description,
        newDescription: newCmd.description
      })
    }
  }

  return {
    comparison: {
      oldVersion,
      newVersion,
      timestamp: new Date().toISOString()
    },
    summary: {
      newCommands: newCommandsDetails.length,
      removedCommands: removedCommandsDetails.length,
      newFlags: newFlags.length,
      removedFlags: removedFlags.length,
      changedDefaults: changedDefaults.length,
      descriptionChanges: descriptionChanges.length
    },
    details: {
      newCommands: newCommandsDetails,
      removedCommands: removedCommandsDetails,
      newFlags,
      removedFlags,
      changedDefaults,
      descriptionChanges
    }
  }
}

/**
 * Print a human-readable diff report to console
 * @param {Object} diff - Diff object from generateRpkDiff
 */
function printDiffReport(diff) {
  console.log('\n=== rpk Documentation Diff Report ===')
  console.log(`Comparing ${diff.comparison.oldVersion} → ${diff.comparison.newVersion}`)
  console.log(`Generated: ${diff.comparison.timestamp}\n`)

  console.log('Summary:')
  console.log(`  New commands: ${diff.summary.newCommands}`)
  console.log(`  Deprecated commands: ${diff.summary.removedCommands}`)
  console.log(`  New flags: ${diff.summary.newFlags}`)
  console.log(`  Deprecated flags: ${diff.summary.removedFlags}`)
  console.log(`  Changed defaults: ${diff.summary.changedDefaults}`)
  console.log(`  Description changes: ${diff.summary.descriptionChanges}`)

  if (diff.details.newCommands.length > 0) {
    console.log('\nNew Commands:')
    for (const cmd of diff.details.newCommands) {
      console.log(`  + ${cmd.path}`)
      if (cmd.description) {
        const shortDesc = cmd.description.split('\n')[0].substring(0, 60)
        console.log(`      ${shortDesc}${cmd.description.length > 60 ? '...' : ''}`)
      }
    }
  }

  if (diff.details.removedCommands.length > 0) {
    console.log('\nDeprecated Commands (no longer in command tree):')
    for (const cmd of diff.details.removedCommands) {
      console.log(`  ⚠ ${cmd.path}`)
    }
  }

  if (diff.details.newFlags.length > 0) {
    console.log('\nNew Flags:')
    for (const flag of diff.details.newFlags) {
      console.log(`  + ${flag.commandPath} --${flag.flagName} (${flag.type})`)
    }
  }

  if (diff.details.removedFlags.length > 0) {
    console.log('\nDeprecated Flags (no longer in command tree):')
    for (const flag of diff.details.removedFlags) {
      console.log(`  ⚠ ${flag.commandPath} --${flag.flagName}`)
    }
  }

  if (diff.details.changedDefaults.length > 0) {
    console.log('\nChanged Defaults:')
    for (const change of diff.details.changedDefaults) {
      console.log(`  ~ ${change.commandPath} --${change.flagName}`)
      console.log(`      ${JSON.stringify(change.oldDefault)} → ${JSON.stringify(change.newDefault)}`)
    }
  }

  console.log('')
}

/**
 * Generate markdown summary for PR description
 * @param {Object} diff - Diff object
 * @returns {string} Markdown content
 */
function generateMarkdownSummary(diff) {
  const lines = []

  lines.push(`## rpk Documentation Changes`)
  lines.push(``)
  lines.push(`**Version:** ${diff.comparison.oldVersion} → ${diff.comparison.newVersion}`)
  lines.push(``)

  lines.push(`### Summary`)
  lines.push(``)
  lines.push(`| Category | Count |`)
  lines.push(`|----------|-------|`)
  lines.push(`| New commands | ${diff.summary.newCommands} |`)
  lines.push(`| Deprecated commands | ${diff.summary.removedCommands} |`)
  lines.push(`| New flags | ${diff.summary.newFlags} |`)
  lines.push(`| Deprecated flags | ${diff.summary.removedFlags} |`)
  lines.push(`| Changed defaults | ${diff.summary.changedDefaults} |`)
  lines.push(``)

  if (diff.details.newCommands.length > 0) {
    lines.push(`### New Commands`)
    lines.push(``)
    for (const cmd of diff.details.newCommands) {
      lines.push(`- \`${cmd.path}\``)
    }
    lines.push(``)
  }

  if (diff.details.removedCommands.length > 0) {
    lines.push(`### Deprecated Commands`)
    lines.push(``)
    lines.push(`> Commands no longer in the active command tree. These may still work but are deprecated.`)
    lines.push(``)
    for (const cmd of diff.details.removedCommands) {
      lines.push(`- ~~\`${cmd.path}\`~~`)
    }
    lines.push(``)
  }

  if (diff.details.newFlags.length > 0 && diff.details.newFlags.length <= 20) {
    lines.push(`### New Flags`)
    lines.push(``)
    for (const flag of diff.details.newFlags) {
      lines.push(`- \`${flag.commandPath}\`: \`--${flag.flagName}\` (${flag.type})`)
    }
    lines.push(``)
  } else if (diff.details.newFlags.length > 20) {
    lines.push(`### New Flags`)
    lines.push(``)
    lines.push(`${diff.details.newFlags.length} new flags added. See diff JSON for details.`)
    lines.push(``)
  }

  return lines.join('\n')
}

/**
 * Convert command path to xref path
 * @param {string} commandPath - Command path like "rpk cluster info"
 * @returns {string} Xref path like "rpk-cluster/rpk-cluster-info.adoc"
 */
function commandPathToXref(commandPath) {
  const parts = commandPath.split(' ')
  if (parts.length === 1) {
    return `rpk.adoc`
  }
  const dashified = commandPath.replace(/ /g, '-')
  if (parts.length === 2) {
    return `${dashified}.adoc`
  }
  // For deeper commands: rpk cluster info -> rpk-cluster/rpk-cluster-info.adoc
  const parentDir = parts.slice(0, 2).join('-')
  return `${parentDir}/${dashified}.adoc`
}

/**
 * Generate AsciiDoc content for what's-new file
 * @param {Object} diff - Diff object from generateRpkDiff
 * @param {Object} options - Options
 * @param {string} options.version - Version string to display
 * @returns {string} AsciiDoc content
 */
function generateWhatsNewSection(diff, options = {}) {
  const lines = []
  const version = options.version || diff.comparison.newVersion

  // Check if there are any changes worth documenting
  const hasNewCommands = diff.details.newCommands.length > 0
  const hasNewFlags = diff.details.newFlags.length > 0
  const hasChangedDefaults = diff.details.changedDefaults.length > 0

  if (!hasNewCommands && !hasNewFlags && !hasChangedDefaults) {
    return '' // No changes to document
  }

  lines.push(`== Redpanda CLI`)
  lines.push(``)

  if (hasNewCommands) {
    lines.push(`=== New commands`)
    lines.push(``)
    for (const cmd of diff.details.newCommands) {
      const xrefPath = commandPathToXref(cmd.path)
      const desc = cmd.description ? ` - ${cmd.description}` : ''
      lines.push(`* xref:reference:rpk/${xrefPath}[\`${cmd.path}\`]${desc}`)
    }
    lines.push(``)
  }

  if (hasNewFlags) {
    lines.push(`=== New flags`)
    lines.push(``)
    // Group flags by command
    const flagsByCommand = {}
    for (const flag of diff.details.newFlags) {
      if (!flagsByCommand[flag.commandPath]) {
        flagsByCommand[flag.commandPath] = []
      }
      flagsByCommand[flag.commandPath].push(flag)
    }

    for (const [cmdPath, flags] of Object.entries(flagsByCommand)) {
      const xrefPath = commandPathToXref(cmdPath)
      const flagList = flags.map(f => `\`--${f.flagName}\``).join(', ')
      lines.push(`* xref:reference:rpk/${xrefPath}[\`${cmdPath}\`]: Added ${flagList}`)
    }
    lines.push(``)
  }

  if (hasChangedDefaults) {
    lines.push(`=== Changed defaults`)
    lines.push(``)
    for (const change of diff.details.changedDefaults) {
      const xrefPath = commandPathToXref(change.commandPath)
      lines.push(`* xref:reference:rpk/${xrefPath}[\`${change.commandPath}\`]: \`--${change.flagName}\` default changed from \`${change.oldDefault}\` to \`${change.newDefault}\``)
    }
    lines.push(``)
  }

  return lines.join('\n')
}

module.exports = {
  generateRpkDiff,
  printDiffReport,
  generateMarkdownSummary,
  generateWhatsNewSection,
  flattenToMap,
  getFlagsMap,
  compareFlags
}
