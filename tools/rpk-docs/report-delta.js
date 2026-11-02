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
  const {
    oldVersion = 'old',
    newVersion = 'new',
    // deprecated_commands maps from the snapshots (path -> metadata), as
    // produced by scan-deprecated-commands.js
    oldDeprecatedCommands = {},
    newDeprecatedCommands = {}
  } = options

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

  // Newly deprecated commands: in the new snapshot's deprecation map but not
  // the old one. Detected by source scanning, because deprecated commands
  // that are also hidden never appear in --print-tree output.
  const newlyDeprecatedRaw = Object.entries(newDeprecatedCommands)
    .filter(([path]) => !oldDeprecatedCommands[path])
    .map(([path, info]) => ({
      path,
      message: info.deprecatedMessage || '',
      replacement: info.replacement || '',
      hidden: info.hidden === true || /Hidden:\s*true/.test(info._note || ''),
      deprecatedInVersion: newVersion
    }))

  // Roll deprecated subcommands up into their nearest deprecated ancestor:
  // one entry for `rpk redpanda admin` with its subcommands listed reads
  // better than a dozen sibling entries
  const newlyDeprecatedDetails = newlyDeprecatedRaw.filter(d =>
    !newlyDeprecatedRaw.some(other => other !== d && d.path.startsWith(other.path + ' ')))
  for (const child of newlyDeprecatedRaw) {
    if (newlyDeprecatedDetails.includes(child)) continue
    const root = newlyDeprecatedDetails.find(r => child.path.startsWith(r.path + ' '))
    if (root) {
      root.affectedSubcommands = root.affectedSubcommands || []
      if (!root.affectedSubcommands.includes(child.path)) {
        root.affectedSubcommands.push(child.path)
      }
    }
  }

  // Find removed commands, then separate genuine removals from commands that
  // disappeared from the tree because they (or an ancestor) were deprecated
  // and hidden — those still work as aliases and should be reported as
  // deprecations, not removals.
  const deprecatedRoots = newlyDeprecatedDetails.map(d => d.path)
  const isUnderNewlyDeprecated = (p) =>
    deprecatedRoots.some(root => p === root || p.startsWith(root + ' '))

  const removedCommandPaths = [...oldPaths].filter(p => !newPaths.has(p))
  const removedCommandsDetails = []
  for (const path of removedCommandPaths) {
    if (isUnderNewlyDeprecated(path)) {
      const root = deprecatedRoots.find(r => path === r || path.startsWith(r + ' '))
      const entry = newlyDeprecatedDetails.find(d => d.path === root)
      if (path !== root) {
        entry.affectedSubcommands = entry.affectedSubcommands || []
        if (!entry.affectedSubcommands.includes(path)) {
          entry.affectedSubcommands.push(path)
        }
      }
      continue
    }
    const cmd = oldCommands.get(path)
    removedCommandsDetails.push({
      path,
      name: cmd.name,
      description: cmd.description || '',
      removedInVersion: newVersion
    })
  }

  for (const dep of newlyDeprecatedDetails) {
    if (dep.affectedSubcommands) dep.affectedSubcommands.sort()
  }

  // Find flag changes in existing commands
  const newFlags = []
  const removedFlags = []
  const changedDefaults = []
  const changedFlagTypes = []
  const changedFlagRequirements = []
  const changedFlagDescriptions = []
  const descriptionChanges = []
  const flagDataBackfilled = []

  // Baseline gap detection: plugin subtrees captured before flag extraction
  // existed record no flags on any of their own commands (the install/
  // uninstall/upgrade shims are rpk-native and do carry flags). Flag
  // "additions" inside such a group are newly captured documentation, not
  // newly introduced flags, and stamping them "New in <version>" would
  // mislabel long-standing flags. Core groups have baseline flag data, so a
  // zero-flag command there that gains a flag is a genuine addition.
  const groupsWithBaselineFlagData = new Set()
  for (const [path, cmd] of oldCommands) {
    const parts = path.split(' ')
    if (parts.length < 2) continue
    // "rpk <plugin> install|uninstall|upgrade" shims are rpk-native
    if (parts.length === 3 && /^(install|uninstall|upgrade)$/.test(parts[2])) continue
    if ((cmd.flags || []).length > 0) groupsWithBaselineFlagData.add(parts[1])
  }

  for (const path of newPaths) {
    if (!oldPaths.has(path)) continue // Skip new commands

    const oldCmd = oldCommands.get(path)
    const newCmd = newCommands.get(path)

    const oldFlags = getFlagsMap(oldCmd)
    const newFlagsMap = getFlagsMap(newCmd)

    const topLevel = path.split(' ')[1]
    const isFlagBackfill = topLevel !== undefined &&
      !groupsWithBaselineFlagData.has(topLevel) &&
      oldFlags.size === 0 && newFlagsMap.size > 0
    if (isFlagBackfill) {
      flagDataBackfilled.push({ commandPath: path, flagCount: newFlagsMap.size })
    }

    // Find new flags (skipped entirely for backfilled commands)
    for (const [flagName, flag] of isFlagBackfill ? [] : newFlagsMap) {
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
        if (changes.type) {
          changedFlagTypes.push({
            commandPath: path,
            flagName,
            oldType: changes.type.old,
            newType: changes.type.new
          })
        }
        if (changes.required) {
          changedFlagRequirements.push({
            commandPath: path,
            flagName,
            oldRequired: changes.required.old,
            newRequired: changes.required.new
          })
        }
        if (changes.description) {
          changedFlagDescriptions.push({
            commandPath: path,
            flagName,
            oldDescription: changes.description.old,
            newDescription: changes.description.new
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
      newlyDeprecatedCommands: newlyDeprecatedDetails.length,
      removedCommands: removedCommandsDetails.length,
      newFlags: newFlags.length,
      removedFlags: removedFlags.length,
      changedDefaults: changedDefaults.length,
      changedFlagTypes: changedFlagTypes.length,
      changedFlagRequirements: changedFlagRequirements.length,
      changedFlagDescriptions: changedFlagDescriptions.length,
      descriptionChanges: descriptionChanges.length,
      flagDataBackfilled: flagDataBackfilled.length
    },
    details: {
      newCommands: newCommandsDetails,
      newlyDeprecatedCommands: newlyDeprecatedDetails,
      removedCommands: removedCommandsDetails,
      newFlags,
      removedFlags,
      changedDefaults,
      changedFlagTypes,
      changedFlagRequirements,
      changedFlagDescriptions,
      descriptionChanges,
      flagDataBackfilled
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
  console.log(`  Deprecated commands: ${diff.summary.newlyDeprecatedCommands || 0}`)
  console.log(`  Removed commands: ${diff.summary.removedCommands}`)
  console.log(`  New flags: ${diff.summary.newFlags}`)
  if (diff.summary.flagDataBackfilled) {
    console.log(`  Flag documentation backfilled: ${diff.summary.flagDataBackfilled} command(s) (baseline had no flag data; not reported as new flags)`)
  }
  console.log(`  Removed flags: ${diff.summary.removedFlags}`)
  console.log(`  Changed defaults: ${diff.summary.changedDefaults}`)
  console.log(`  Changed flag types: ${diff.summary.changedFlagTypes || 0}`)
  console.log(`  Changed flag requirements: ${diff.summary.changedFlagRequirements || 0}`)
  console.log(`  Changed flag descriptions: ${diff.summary.changedFlagDescriptions || 0}`)
  console.log(`  Command description changes: ${diff.summary.descriptionChanges}`)

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

  if ((diff.details.newlyDeprecatedCommands || []).length > 0) {
    console.log('\nDeprecated Commands (still work, hidden or discouraged):')
    for (const cmd of diff.details.newlyDeprecatedCommands) {
      console.log(`  ⚠ ${cmd.path}${cmd.hidden ? ' (hidden)' : ''}`)
      if (cmd.message) console.log(`      ${cmd.message}`)
      if ((cmd.affectedSubcommands || []).length > 0) {
        console.log(`      affects ${cmd.affectedSubcommands.length} subcommand(s)`)
      }
    }
  }

  if (diff.details.removedCommands.length > 0) {
    console.log('\nRemoved Commands (no longer in command tree):')
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
    console.log('\nRemoved Flags (no longer in command tree):')
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

  if ((diff.details.changedFlagTypes || []).length > 0) {
    console.log('\nChanged Flag Types:')
    for (const change of diff.details.changedFlagTypes) {
      console.log(`  ~ ${change.commandPath} --${change.flagName}: ${change.oldType} → ${change.newType}`)
    }
  }

  if ((diff.details.changedFlagRequirements || []).length > 0) {
    console.log('\nChanged Flag Requirements:')
    for (const change of diff.details.changedFlagRequirements) {
      console.log(`  ~ ${change.commandPath} --${change.flagName}: required ${change.oldRequired} → ${change.newRequired}`)
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
  lines.push(`| Removed commands | ${diff.summary.removedCommands} |`)
  lines.push(`| New flags | ${diff.summary.newFlags} |`)
  lines.push(`| Removed flags | ${diff.summary.removedFlags} |`)
  lines.push(`| Changed defaults | ${diff.summary.changedDefaults} |`)
  if (diff.summary.flagDataBackfilled) {
    lines.push(`| Flag docs backfilled (baseline had no flag data) | ${diff.summary.flagDataBackfilled} commands |`)
  }
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
    lines.push(`### Removed Commands`)
    lines.push(``)
    lines.push(`> Commands no longer in the active command tree.`)
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
  // Plugin subtrees may render as partials with no linkable pages, so plugin
  // runs disable xrefs and render plain command names instead.
  const useXrefs = options.xrefs !== false
  // Commands that render as partials or are excluded have no linkable page
  const linkable = typeof options.linkable === 'function' ? options.linkable : () => true
  // Section heading for the page ("== Redpanda CLI" for core rpk changes,
  // "== rpk plugins" for plugin releases). When blockLabel is set, the block
  // opens with a "=== <label>" heading and category headings nest one level
  // deeper, so accumulated blocks never produce colliding section ids.
  const sectionHeading = options.sectionHeading || '== Redpanda CLI'
  const blockLabel = options.blockLabel || null
  const h = blockLabel ? '====' : '==='
  // Command groups (two-part commands with subcommands) render into their own
  // directory: rpk check -> rpk-check/rpk-check.adoc, not rpk-check.adoc
  const hasSubcommands = typeof options.hasSubcommands === 'function'
    ? options.hasSubcommands
    : () => false
  const cmdRef = (commandPath) => {
    if (!useXrefs || !linkable(commandPath)) return `\`${commandPath}\``
    let xrefPath = commandPathToXref(commandPath)
    if (commandPath.split(' ').length === 2 && hasSubcommands(commandPath)) {
      const dashified = commandPath.replace(/ /g, '-')
      xrefPath = `${dashified}/${dashified}.adoc`
    }
    return `xref:reference:rpk/${xrefPath}[\`${commandPath}\`]`
  }

  // Check if there are any changes worth documenting
  const hasNewCommands = diff.details.newCommands.length > 0
  const hasDeprecatedCommands = (diff.details.newlyDeprecatedCommands || []).length > 0
  const hasRemovedCommands = diff.details.removedCommands.length > 0
  const hasNewFlags = diff.details.newFlags.length > 0
  const hasRemovedFlags = diff.details.removedFlags.length > 0
  const hasChangedDefaults = diff.details.changedDefaults.length > 0
  const hasChangedFlagTypes = (diff.details.changedFlagTypes || []).length > 0

  if (!hasNewCommands && !hasDeprecatedCommands && !hasRemovedCommands &&
      !hasNewFlags && !hasRemovedFlags && !hasChangedDefaults && !hasChangedFlagTypes) {
    return '' // No changes to document
  }

  lines.push(sectionHeading)
  lines.push(``)
  if (blockLabel) {
    lines.push(`=== ${blockLabel}`)
    lines.push(``)
  }

  if (hasNewCommands) {
    lines.push(`${h} New commands`)
    lines.push(``)
    for (const cmd of diff.details.newCommands) {
      const shortDesc = firstSentence(cmd.description || '')
      const desc = shortDesc ? ` - ${shortDesc}` : ''
      lines.push(`* ${cmdRef(cmd.path)}${desc}`)
    }
    lines.push(``)
  }

  if (hasNewFlags) {
    lines.push(`${h} New flags`)
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
      const flagList = flags.map(f => `\`--${f.flagName}\``).join(', ')
      lines.push(`* ${cmdRef(cmdPath)}: Added ${flagList}`)
    }
    lines.push(``)
  }

  if (hasChangedDefaults) {
    lines.push(`${h} Changed defaults`)
    lines.push(``)
    for (const change of diff.details.changedDefaults) {
      const oldVal = formatFlagValue(change.oldDefault)
      const newVal = formatFlagValue(change.newDefault)
      lines.push(`* ${cmdRef(change.commandPath)}: \`--${change.flagName}\` default changed from \`${oldVal}\` to \`${newVal}\``)
    }
    lines.push(``)
  }

  if (hasChangedFlagTypes) {
    lines.push(`${h} Changed flag types`)
    lines.push(``)
    for (const change of diff.details.changedFlagTypes) {
      lines.push(`* ${cmdRef(change.commandPath)}: \`--${change.flagName}\` type changed from \`${change.oldType}\` to \`${change.newType}\``)
    }
    lines.push(``)
  }

  if (hasDeprecatedCommands) {
    lines.push(`${h} Deprecated commands`)
    lines.push(``)
    for (const cmd of diff.details.newlyDeprecatedCommands) {
      let entry = `* \`${cmd.path}\``
      if (cmd.replacement) {
        entry += `: ${cmd.replacement}`
      } else if (cmd.message) {
        entry += `: ${cmd.message}`
      }
      lines.push(entry)
      if ((cmd.affectedSubcommands || []).length > 0) {
        lines.push(`+`)
        lines.push(`Includes its subcommands: ${cmd.affectedSubcommands.map(s => `\`${s}\``).join(', ')}.`)
      }
    }
    lines.push(``)
  }

  if (hasRemovedCommands) {
    lines.push(`${h} Removed commands`)
    lines.push(``)
    for (const cmd of diff.details.removedCommands) {
      lines.push(`* \`${cmd.path}\``)
    }
    lines.push(``)
  }

  if (hasRemovedFlags) {
    lines.push(`${h} Removed flags`)
    lines.push(``)
    const removedByCommand = {}
    for (const flag of diff.details.removedFlags) {
      if (!removedByCommand[flag.commandPath]) {
        removedByCommand[flag.commandPath] = []
      }
      removedByCommand[flag.commandPath].push(flag)
    }
    for (const [cmdPath, flags] of Object.entries(removedByCommand)) {
      const flagList = flags.map(f => `\`--${f.flagName}\``).join(', ')
      lines.push(`* ${cmdRef(cmdPath)}: Removed ${flagList}`)
    }
    lines.push(``)
  }

  return lines.join('\n')
}

/**
 * Extract the first sentence of a description for a one-line bullet.
 * Newlines are collapsed first (cobra help wraps mid-sentence), and decimal
 * points in version numbers do not end a sentence. Falls back to the whole
 * collapsed text when no sentence boundary exists.
 * @param {string} str - Command description
 * @returns {string}
 */
function firstSentence(str) {
  if (!str) return ''
  // A blank line separates the summary from the long text even when the
  // summary has no terminal period ("Install Redpanda Check\n\nThis
  // command..."), so cut at the paragraph break before joining the
  // hard-wrapped lines within it.
  const firstParagraph = String(str).split(/\n\s*\n/, 1)[0]
  const singleLine = firstParagraph.replace(/\s*\n+\s*/g, ' ').trim()
  const protectedText = singleLine.replace(/(\d)\.(\d)/g, '$1__DECIMAL__$2')
  const match = protectedText.match(/^.*?[.!?](?=\s|$)/)
  const sentence = match ? match[0] : protectedText
  return sentence.replace(/__DECIMAL__/g, '.').trim()
}

/**
 * Render a flag value for display. Objects and arrays are JSON-encoded so
 * they never render as [object Object].
 * @param {*} value - Flag default value
 * @returns {string}
 */
function formatFlagValue(value) {
  if (value === undefined) return 'unset'
  if (value === null) return 'null'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

module.exports = {
  generateRpkDiff,
  printDiffReport,
  generateMarkdownSummary,
  generateWhatsNewSection,
  flattenToMap,
  getFlagsMap,
  compareFlags,
  // Exported for testing
  firstSentence
}
