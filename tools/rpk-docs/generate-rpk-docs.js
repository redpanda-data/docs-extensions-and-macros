'use strict'

const fs = require('fs')
const path = require('path')
const handlebars = require('handlebars')
const helpers = require('./helpers')

// Register Handlebars helpers
Object.entries(helpers).forEach(([name, fn]) => {
  if (typeof fn === 'function') {
    handlebars.registerHelper(name, fn)
  }
})

// Template paths
const TEMPLATES_DIR = path.resolve(__dirname, './templates')

/**
 * Register a Handlebars partial from file
 * @param {string} name - Partial name
 * @param {string} filePath - Path to template file
 */
function registerPartial(name, filePath) {
  const resolved = path.resolve(filePath)
  try {
    const source = fs.readFileSync(resolved, 'utf8')
    handlebars.registerPartial(name, source)
  } catch (err) {
    console.warn(`Warning: Could not load partial "${name}" from ${resolved}`)
  }
}

/**
 * Load and compile a Handlebars template
 * @param {string} templatePath - Path to template file
 * @returns {Function} Compiled template function
 */
function loadTemplate(templatePath) {
  const source = fs.readFileSync(templatePath, 'utf8')
  return handlebars.compile(source)
}

/**
 * Resolve $ref references in overrides object with cycle detection
 * @param {Object} obj - Object to resolve
 * @param {Object} root - Root object containing definitions
 * @param {string} [context] - Context for error messages (e.g., command path)
 * @param {Set} [visited] - Set of visited refs for cycle detection
 * @param {number} [depth] - Current recursion depth
 * @returns {Object} Resolved object
 */
function resolveReferences(obj, root, context = '', visited = new Set(), depth = 0) {
  // Prevent infinite recursion
  const MAX_DEPTH = 50
  if (depth > MAX_DEPTH) {
    console.error(`ERROR: Maximum reference resolution depth exceeded (${MAX_DEPTH})`)
    console.error(`  Context: ${context || 'root'}`)
    console.error(`  This may indicate circular references in your overrides.`)
    return obj
  }

  if (!obj || typeof obj !== 'object') return obj

  if (Array.isArray(obj)) {
    return obj.map((item, i) =>
      resolveReferences(item, root, `${context}[${i}]`, visited, depth + 1)
    )
  }

  // Handle $ref
  if (obj.$ref && typeof obj.$ref === 'string') {
    const ref = obj.$ref

    // Check for cycles
    if (visited.has(ref)) {
      console.error(`ERROR: Circular reference detected: ${ref}`)
      console.error(`  Context: ${context || 'root'}`)
      console.error(`  Reference chain would create infinite loop.`)
      const { $ref, ...rest } = obj
      return rest // Return without the reference to prevent infinite loop
    }

    // Validate ref format
    if (!ref.startsWith('#/')) {
      console.error(`ERROR: Invalid $ref format: "${ref}"`)
      console.error(`  Context: ${context || 'root'}`)
      console.error(`  References must start with #/ (e.g., #/definitions/my-flags)`)
      return obj
    }

    const refPath = ref.replace(/^#\//, '').split('/')
    let resolved = root
    for (const part of refPath) {
      if (resolved && typeof resolved === 'object') {
        resolved = resolved[part]
      } else {
        resolved = undefined
        break
      }
    }

    if (resolved !== undefined) {
      const newVisited = new Set(visited)
      newVisited.add(ref)
      const { $ref: _, ...rest } = obj
      return {
        ...resolveReferences(resolved, root, `${context}.$ref(${ref})`, newVisited, depth + 1),
        ...rest
      }
    }

    // Reference not found - provide helpful error
    console.error(`ERROR: Cannot resolve $ref: "${ref}"`)
    console.error(`  Context: ${context || 'root'}`)

    // Suggest similar paths
    const findPaths = (obj, prefix = '#') => {
      const paths = []
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const key of Object.keys(obj)) {
          const path = `${prefix}/${key}`
          paths.push(path)
          paths.push(...findPaths(obj[key], path))
        }
      }
      return paths
    }
    const availablePaths = findPaths(root)
    const refBase = ref.split('/').slice(0, -1).join('/')
    const similar = availablePaths
      .filter(p => p.startsWith(refBase) || p.includes(refPath[refPath.length - 1]))
      .slice(0, 3)

    if (similar.length > 0) {
      console.error(`  Did you mean: ${similar.join(', ')}?`)
    }

    // Return object without the unresolved $ref
    const { $ref: _, ...rest } = obj
    return rest
  }

  // Handle $refs array (merge multiple references)
  // Order: $refs provide defaults, explicit properties override
  if (obj.$refs && Array.isArray(obj.$refs)) {
    const { $refs, ...rest } = obj
    let merged = {}

    // First, merge all $refs in order (later $refs override earlier ones)
    for (let i = 0; i < $refs.length; i++) {
      const ref = $refs[i]

      // Check for cycles
      if (visited.has(ref)) {
        console.error(`ERROR: Circular reference detected in $refs: ${ref}`)
        console.error(`  Context: ${context || 'root'}.$refs[${i}]`)
        continue
      }

      if (!ref.startsWith('#/')) {
        console.error(`ERROR: Invalid $refs entry: "${ref}" (must start with #/)`)
        console.error(`  Context: ${context || 'root'}.$refs[${i}]`)
        continue
      }

      const refPath = ref.replace(/^#\//, '').split('/')
      let resolved = root
      for (const part of refPath) {
        if (resolved && typeof resolved === 'object') {
          resolved = resolved[part]
        } else {
          resolved = undefined
          break
        }
      }

      if (resolved !== undefined) {
        const newVisited = new Set(visited)
        newVisited.add(ref)
        merged = deepMerge(
          merged,
          resolveReferences(resolved, root, `${context}.$refs[${i}](${ref})`, newVisited, depth + 1)
        )
      } else {
        console.error(`ERROR: Cannot resolve $refs entry: "${ref}"`)
        console.error(`  Context: ${context || 'root'}.$refs[${i}]`)
      }
    }

    // Then overlay explicit properties (they take precedence over $refs)
    return deepMerge(merged, rest)
  }

  // Recursively resolve nested objects
  const result = {}
  for (const [key, value] of Object.entries(obj)) {
    result[key] = resolveReferences(value, root, `${context}.${key}`, visited, depth + 1)
  }
  return result
}

/**
 * Deep merge two objects with array deduplication
 * @param {Object} target - Target object
 * @param {Object} source - Source object
 * @returns {Object} Merged object
 */
function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target
  if (!target || typeof target !== 'object') return source

  const result = { ...target }

  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value) && Array.isArray(result[key])) {
      const targetArray = result[key]

      // Check if this is a string-only array (prerequisites, seeAlso, etc.)
      const isStringArray = targetArray.every(item => typeof item === 'string') &&
                           value.every(item => typeof item === 'string')

      if (isStringArray) {
        // Deduplicate string arrays
        const combined = [...targetArray, ...value]
        result[key] = [...new Set(combined)]
      } else {
        // Merge arrays by name if items have name property
        const merged = [...targetArray]

        for (const sourceItem of value) {
          if (sourceItem && typeof sourceItem === 'object' && sourceItem.name) {
            const targetIdx = merged.findIndex(t => t && t.name === sourceItem.name)
            if (targetIdx >= 0) {
              merged[targetIdx] = deepMerge(merged[targetIdx], sourceItem)
            } else {
              merged.push(sourceItem)
            }
          } else if (sourceItem && typeof sourceItem === 'object') {
            // Object without name - check for duplicates by deep equality
            const isDuplicate = merged.some(t =>
              JSON.stringify(t) === JSON.stringify(sourceItem)
            )
            if (!isDuplicate) {
              merged.push(sourceItem)
            }
          } else {
            // Primitive - add if not already present
            if (!merged.includes(sourceItem)) {
              merged.push(sourceItem)
            }
          }
        }
        result[key] = merged
      }
    } else if (typeof value === 'object' && typeof result[key] === 'object' && !Array.isArray(value)) {
      result[key] = deepMerge(result[key], value)
    } else {
      result[key] = value
    }
  }

  return result
}

/**
 * Check if a command should be excluded from documentation
 * @param {Object} overrides - Overrides object (resolved)
 * @param {string} commandPath - Full command path (e.g., "rpk topic create")
 * @returns {boolean} True if command should be excluded
 */
function shouldExcludeCommand(overrides, commandPath) {
  if (!overrides || !overrides.commands) return false
  const commandOverride = overrides.commands[commandPath]
  return commandOverride?.exclude === true
}

/**
 * Get command metadata from overrides
 * @param {Object} overrides - Overrides object (resolved)
 * @param {string} commandPath - Full command path (e.g., "rpk topic create")
 * @returns {Object} Command metadata
 */
function getCommandMetadata(overrides, commandPath) {
  if (!overrides || !overrides.commands) return {}
  return overrides.commands[commandPath] || {}
}

/**
 * Valid content positions
 */
const VALID_CONTENT_POSITIONS = new Set([
  'after_header',
  'after_description',
  'after_usage',
  'after_aliases',
  'after_flags',
  'after_modifiers',
  'after_examples',
  'before_see_also',
  'end'
])

/**
 * Check if admonition content needs block format (complex) vs simple format
 * @param {string} content - Admonition content
 * @returns {boolean} True if complex format needed
 */
function isComplexAdmonition(content) {
  if (!content) return false
  // Check for includes, multiple paragraphs, code blocks, tables
  return content.includes('\n\n') ||
         content.includes('include::') ||
         content.includes('[,') ||
         content.includes('----') ||
         content.includes('|===')
}

/**
 * Wrap admonition content in appropriate format
 * @param {string} type - Admonition type (note, warning, etc.)
 * @param {string} content - Content to wrap
 * @returns {string} Wrapped admonition
 */
function wrapAdmonition(type, content) {
  const upperType = type.toUpperCase()

  // Check if already manually wrapped (backward compatibility)
  if (content.trim().startsWith(`[${upperType}]`)) {
    return content
  }

  // Detect complexity and wrap accordingly
  if (isComplexAdmonition(content)) {
    // Block format for complex content
    return `[${upperType}]\n====\n${content}\n====`
  } else {
    // Simple format for single paragraph
    return `${upperType}: ${content}`
  }
}

/**
 * Process unified content array into position-grouped content
 * @param {Array} contentArray - Array of content items from overrides
 * @param {string} [context] - Context for error messages (e.g., command path)
 * @returns {Object} Content grouped by position, with rendered AsciiDoc
 */
function processContentArray(contentArray, context = '') {
  if (!contentArray || !Array.isArray(contentArray)) {
    return {
      sections: {},
      admonitions: {},
      cloudContent: {},
      selfHostedContent: {},
      includes: {}
    }
  }

  const result = {
    sections: {},      // position -> array of {id, title, content}
    admonitions: {},   // position -> rendered admonition string
    cloudContent: {},  // position -> content string
    selfHostedContent: {}, // position -> content string
    includes: {}       // position -> array of paths
  }

  // Initialize arrays/objects for each position
  for (const pos of VALID_CONTENT_POSITIONS) {
    result.sections[pos] = []
    result.admonitions[pos] = []
    result.cloudContent[pos] = []
    result.selfHostedContent[pos] = []
    result.includes[pos] = []
  }

  for (const item of contentArray) {
    const { type, position, content, id, title, path, paths, exclude } = item

    // Skip excluded items
    if (exclude === true) {
      continue
    }

    // Validate position
    if (!VALID_CONTENT_POSITIONS.has(position)) {
      console.warn(`WARNING: Invalid content position "${position}" for type "${type}"`)
      if (context) console.warn(`  Context: ${context}`)
      console.warn(`  Valid positions: ${[...VALID_CONTENT_POSITIONS].join(', ')}`)
      continue
    }

    switch (type) {
      case 'section': {
        // Escape {word} (no hyphens) in table cell lines — CLI format specifiers like {hex}
        // are not AsciiDoc attribute refs and must be escaped to prevent substitution.
        const escapedContent = typeof content === 'string'
          ? content.replace(/^\|(.*)$/gm, (m, cell) =>
              /\{[a-z_][a-z0-9_]*\}/.test(cell)
                ? '|' + cell.replace(/\{([a-z_][a-z0-9_]*)\}/g, '\\{$1}')
                : m)
          : content
        // Pass through all section properties (subsections, parent, headingLevel, exclude)
        result.sections[position].push({
          type: 'section',
          id,
          title,
          content: escapedContent,
          subsections: item.subsections,
          parent: item.parent,
          headingLevel: item.headingLevel,
          exclude
        })
        // Deprecation warning for manual "See also" sections
        if (content && content.includes('== See also')) {
          console.warn(`⚠️  Deprecated: Manual "See also" section in ${context || 'unknown'}`)
          console.warn(`   Use seeAlso key instead`)
        }
        break
      }

      case 'example':
        // Structured single example
        result.sections[position].push({
          type: 'example',
          description: item.description,
          code: item.code,
          language: item.language || 'bash',
          attributes: item.attributes
        })
        break

      case 'examples':
        // Structured multiple examples
        result.sections[position].push({
          type: 'examples',
          title: item.title || 'Examples',
          items: item.items
        })
        break

      case 'note':
        // Use wrapAdmonition for smart formatting
        result.admonitions[position].push(wrapAdmonition('note', content))
        break

      case 'warning':
        result.admonitions[position].push(wrapAdmonition('warning', content))
        break

      case 'tip':
        result.admonitions[position].push(wrapAdmonition('tip', content))
        break

      case 'caution':
        result.admonitions[position].push(wrapAdmonition('caution', content))
        break

      case 'important':
        result.admonitions[position].push(wrapAdmonition('important', content))
        break

      case 'cloud-only':
        result.cloudContent[position].push(content)
        break

      case 'self-hosted':
        result.selfHostedContent[position].push(content)
        break

      case 'include':
        if (path) {
          result.includes[position].push(path)
        }
        if (paths && Array.isArray(paths)) {
          result.includes[position].push(...paths)
        }
        break

      default:
        console.warn(`WARNING: Unknown content type "${type}"`)
        if (context) console.warn(`  Context: ${context}`)
    }
  }

  // Convert arrays to rendered strings where appropriate
  const rendered = {
    sections: result.sections,
    admonitions: {},
    cloudContent: {},
    selfHostedContent: {},
    includes: {}
  }

  for (const pos of VALID_CONTENT_POSITIONS) {
    // Join admonitions with double newlines
    rendered.admonitions[pos] = result.admonitions[pos].join('\n\n')

    // Join cloud content
    rendered.cloudContent[pos] = result.cloudContent[pos].join('\n\n')

    // Join self-hosted content
    rendered.selfHostedContent[pos] = result.selfHostedContent[pos].join('\n\n')

    // Keep includes as array
    rendered.includes[pos] = result.includes[pos]
  }

  return rendered
}

/**
 * Merge overrides into command data
 * @param {Object} command - Command object
 * @param {Object} overrides - Overrides object (resolved)
 * @param {string} commandPath - Full command path (e.g., "rpk topic create")
 * @returns {Object} Merged command
 */
function mergeCommandOverrides(command, overrides, commandPath) {
  if (!overrides || !overrides.commands) return command

  const commandOverride = overrides.commands[commandPath]
  if (!commandOverride) return command

  const result = { ...command }

  // Override description while preserving sections from original
  if (commandOverride.description) {

    // Parse sections from original description
    const originalParsed = parseDescriptionSections(command.description || '')
    // Parse sections from override description (in case override includes sections)
    const overrideParsed = parseDescriptionSections(commandOverride.description)

    // If override only has main description (no sections), preserve original sections
    // UNLESS the override has content items (which replace the sections)
    const hasOverrideSections = Object.keys(overrideParsed.sections).length > 0
    const hasContentItems = commandOverride.content && commandOverride.content.length > 0
    if (!hasOverrideSections && !hasContentItems && Object.keys(originalParsed.sections).length > 0) {
      // Rebuild description with override main text + original sections
      let rebuiltDescription = overrideParsed.mainDescription
      for (const [sectionName, sectionContent] of Object.entries(originalParsed.sections)) {
        rebuiltDescription += `\n\n${sectionName}\n\n${sectionContent}`
      }
      result.description = rebuiltDescription
    } else {
      // Override has sections, content items, or original has none - use override as-is
      result.description = commandOverride.description
    }

  }

  // Append to description if specified
  if (commandOverride.appendToDescription) {
    result.description = (result.description || '') + '\n\n' + commandOverride.appendToDescription
  }

  // Copy description scope (for conditional rendering)
  if (commandOverride.descriptionScope) {
    result.descriptionScope = commandOverride.descriptionScope
  }

  // Override flags
  if (result.flags) {
    // First, filter out excluded flags
    if (commandOverride.excludeFlags) {
      const excludeSet = new Set(commandOverride.excludeFlags)
      result.flags = result.flags.filter(flag => !excludeSet.has(flag.name))
    }

    // Then apply flag overrides
    if (commandOverride.flags) {
      result.flags = result.flags.map(flag => {
        const flagOverride = commandOverride.flags[flag.name]
        if (flagOverride) {
          return { ...flag, ...flagOverride }
        }
        return flag
      })
    }
  }

  // Add introduced version if specified
  if (commandOverride.introducedInVersion) {
    result.introducedInVersion = commandOverride.introducedInVersion
  }

  // Copy deprecation info
  if (commandOverride.deprecated) {
    result.deprecated = true
    result.deprecatedMessage = commandOverride.deprecatedMessage
    result.deprecatedInVersion = commandOverride.deprecatedInVersion
    result.removedInVersion = commandOverride.removedInVersion
    result.replacement = commandOverride.replacement
  }

  // Copy minVersion
  if (commandOverride.minVersion) {
    result.minVersion = commandOverride.minVersion
  }

  // Copy platforms from override (explicit override takes precedence)
  if (commandOverride.platforms) {
    result.platforms = commandOverride.platforms
  }

  // Copy prerequisites
  if (commandOverride.prerequisites) {
    result.prerequisites = commandOverride.prerequisites
  }

  // Copy seeAlso
  if (commandOverride.seeAlso) {
    result.seeAlso = commandOverride.seeAlso
  }

  // Copy pageAliases
  if (commandOverride.pageAliases) {
    result.pageAliases = commandOverride.pageAliases
  }

  // Copy aliases override
  if (commandOverride.aliases) {
    result.aliases = commandOverride.aliases
  }

  // Merge unified content array
  if (command.content || commandOverride.content) {
    const baseContent = command.content || []
    const overrideContent = commandOverride.content || []

    // Build a map of override items by id for quick lookup
    const overrideById = new Map()
    for (const item of overrideContent) {
      if (item.id) {
        overrideById.set(item.id, item)
      }
    }

    // Merge: start with base content, applying overrides by id
    const mergedContent = []
    for (const item of baseContent) {
      if (item.id && overrideById.has(item.id)) {
        const override = overrideById.get(item.id)
        // If override has exclude: true, skip this item entirely
        if (override.exclude === true) {
          continue
        }
        // Otherwise, merge the override with the base item
        mergedContent.push({ ...item, ...override })
      } else {
        mergedContent.push(item)
      }
    }

    // Add any override items that don't have an id match in base content
    for (const item of overrideContent) {
      if (!item.id || !baseContent.some(baseItem => baseItem.id === item.id)) {
        // Include all items, even those with exclude: true
        // (exclude directives may be used to remove sections from description)
        mergedContent.push(item)
      }
    }

    result.content = mergedContent
  }

  // Copy cloud/self-hosted only flags
  if (commandOverride.cloudOnly) {
    result.cloudOnly = true
  }
  if (commandOverride.selfHostedOnly) {
    result.selfHostedOnly = true
  }

  // Copy excludeExamples
  if (commandOverride.excludeExamples) {
    result.excludeExamples = commandOverride.excludeExamples
  }

  return result
}

/**
 * Deep clone an object (simple JSON-safe clone)
 * @param {Object} obj - Object to clone
 * @returns {Object} Deep copy of the object
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj))
}

/**
 * Recursively apply overrides to an entire command tree
 * Creates an enhanced tree with all overrides merged in, suitable for saving as canonical JSON
 * IMPORTANT: This function deep clones the tree to avoid mutating the original
 * @param {Object} tree - The rpk command tree
 * @param {Object} overrides - Resolved overrides object
 * @param {string} [parentPath=''] - Parent command path for recursion
 * @param {boolean} [isRoot=true] - Whether this is the root call (triggers deep clone)
 * @returns {Object} Enhanced tree with overrides applied (new object, original unchanged)
 */
function applyOverridesToTree(tree, overrides, parentPath = '', isRoot = true) {
  if (!tree) return tree
  if (!overrides) return isRoot ? deepClone(tree) : tree

  // Deep clone at root level to avoid mutating the original tree
  const workingTree = isRoot ? deepClone(tree) : tree

  const commandPath = parentPath ? `${parentPath} ${workingTree.name}` : workingTree.name
  const enhanced = mergeCommandOverrides(workingTree, overrides, commandPath)

  // Recursively process subcommands (not root, already cloned)
  if (enhanced.commands && enhanced.commands.length > 0) {
    enhanced.commands = enhanced.commands.map(subCmd =>
      applyOverridesToTree(subCmd, overrides, commandPath, false)
    )
  }

  return enhanced
}

/**
 * Decode HTML entities in text
 * @param {string} text - Text with HTML entities
 * @returns {string} Decoded text
 */
function decodeHtmlEntities(text) {
  if (!text) return text
  return text
    .replace(/&#x3D;/g, '=')
    .replace(/&#x27;/g, "'")
    .replace(/&#x60;/g, '`')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
}

/**
 * Convert indented code examples and YAML/config blocks to protected placeholders
 * Detects patterns like:
 *   --flag value --other "arg"    (command examples)
 *   - job_name: test              (YAML lists)
 *     key: value                  (YAML nested content)
 *
 * Returns placeholders that must be restored after other transformations.
 *
 * @param {string} text - Text potentially containing indented code
 * @param {Array} codeBlockStore - Array to store extracted code blocks
 * @returns {string} Text with code blocks replaced by placeholders
 */
function convertIndentedCodeBlocksToAsciiDoc(text, codeBlockStore = []) {
  if (!text) return text

  const lines = text.split('\n')
  const result = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Check for indented command example: 2+ spaces then --, rpk, or $ (shell prompt)
    // e.g. "  --job-name test --labels ..."
    // e.g. "  rpk cluster info"
    // e.g. "  $ echo 'command'"
    if (/^[ ]{2,}(--|rpk\s|\$\s)/.test(line)) {
      // Collect all consecutive indented lines that look like command continuation
      // Strip trailing backslashes as we'll add them during join
      // Also strip leading "$ " shell prompt if present
      const codeLines = [line.trim().replace(/^\$\s+/, '').replace(/\s*\\$/, '')]
      let j = i + 1
      while (j < lines.length && /^[ ]{2,}\S/.test(lines[j]) && !/^[ ]{2,}-\s+[A-Z]/.test(lines[j])) {
        // Continue if indented and not a markdown list item (dash followed by capital letter = prose)
        codeLines.push(lines[j].trim().replace(/\s*\\$/, ''))
        j++
      }

      // Create code block - join with backslash continuation if multi-line
      const joinedCode = codeLines.length > 1
        ? codeLines.join(' \\\n')
        : codeLines[0]
      const codeBlock = `\n[,bash]\n----\n${joinedCode}\n----\n`
      const placeholder = `__EARLY_CODE_BLOCK_${codeBlockStore.length}__`
      codeBlockStore.push(codeBlock)
      result.push('')
      result.push(placeholder)
      result.push('')
      i = j
      continue
    }

    // Check for indented YAML block: 2+ spaces, starts with "- key:" or "key:"
    // and is followed by more indented content with ":" patterns
    // IMPORTANT: Exclude prose definition lists like "  - Term: Long description text"
    // YAML has short values or values on next line, prose has long text after colon
    const isYamlStart = (
      // "  - key:" with no text or short value after colon (YAML style)
      /^[ ]{2,}-\s+\w+:(?:\s*$|\s+\S{1,20}\s*$)/.test(line) ||
      // "  key:" at end of line (YAML block start)
      /^[ ]{2,}\w+:\s*$/.test(line)
    )
    // Exclude if it looks like a prose definition list (colon followed by long text)
    const isProse = /^[ ]{2,}-\s+\w+:\s+\w+\s+\w+\s+\w+/.test(line)

    if (isYamlStart && !isProse) {
      // Look ahead to see if this is a YAML block (multiple lines with : patterns)
      let j = i
      const potentialYamlLines = []
      let hasMultipleYamlLines = false

      while (j < lines.length) {
        const currentLine = lines[j]
        // YAML patterns: indented with "- key:", "key:", or just indented continuation
        if (/^[ ]{2,}/.test(currentLine) && (
          /^[ ]*-?\s*\w+:/.test(currentLine) ||  // key: or - key:
          /^[ ]*-?\s*\[/.test(currentLine) ||    // - [array]
          /^[ ]{4,}\w+:/.test(currentLine) ||    // deeply indented key:
          (potentialYamlLines.length > 0 && /^[ ]{4,}\S/.test(currentLine))  // continuation
        )) {
          potentialYamlLines.push(currentLine)
          if (potentialYamlLines.length > 1) hasMultipleYamlLines = true
          j++
        } else if (/^[ ]*$/.test(currentLine) && potentialYamlLines.length > 0) {
          // Blank line - check if YAML continues after
          if (j + 1 < lines.length && /^[ ]{2,}-?\s*\w+:/.test(lines[j + 1])) {
            potentialYamlLines.push(currentLine)
            j++
          } else {
            break
          }
        } else {
          break
        }
      }

      // If we have a multi-line YAML block, convert to code block
      if (hasMultipleYamlLines && potentialYamlLines.length >= 2) {
        // Find minimum indentation to normalize
        const minIndent = Math.min(...potentialYamlLines
          .filter(l => l.trim())
          .map(l => l.match(/^([ ]*)/)[1].length))

        const yamlContent = potentialYamlLines.map(l => l.slice(minIndent)).join('\n')
        const codeBlock = `\n[,yaml]\n----\n${yamlContent}\n----\n`
        const placeholder = `__EARLY_CODE_BLOCK_${codeBlockStore.length}__`
        codeBlockStore.push(codeBlock)
        result.push('')
        result.push(placeholder)
        result.push('')
        i = j
        continue
      }
    }

    // Not a code block pattern, keep line as-is
    result.push(line)
    i++
  }

  return result.join('\n')
}

/**
 * Convert markdown-style lists to AsciiDoc format
 * Handles: "text:\n  - item1\n  - item2" -> "text:\n\n* item1\n* item2"
 * @param {string} text - Text with potential markdown lists
 * @returns {string} Text with AsciiDoc lists
 */
function convertMarkdownLists(text) {
  if (!text) return text

  // Find and convert markdown-style indented lists
  // Pattern: text followed by newline + spaces + dash + space (first item)
  // then more items with same pattern
  //
  // We use a single regex that:
  // 1. Matches the text before the list (group 1)
  // 2. Captures all the list items together
  // 3. Converts dashes to asterisks and removes indentation

  // Process the text to find list blocks
  const lines = text.split('\n')
  const result = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Check if this line starts a markdown-style list item (indented dash)
    if (/^[ \t]+-[ \t]+/.test(line)) {
      // We found a list item - check if we need a blank line before it
      // (need blank line if previous line is not empty and not a list item)
      if (result.length > 0) {
        const prevLine = result[result.length - 1]
        if (prevLine !== '' && !/^\* /.test(prevLine)) {
          result.push('') // Add blank line before list
        }
      }

      // Convert this item: remove leading whitespace, change - to *
      const converted = line.replace(/^[ \t]+-[ \t]+/, '* ')
      result.push(converted)
    } else {
      result.push(line)
    }
    i++
  }

  return result.join('\n')
}

/**
 * Convert numbered lists to AsciiDoc list format
 * Detects patterns like:
 *   1. First item
 *   2. Second item
 *   3. Third item
 * Converts to:
 * . First item
 * . Second item
 * . Third item
 *
 * @param {string} text - Text potentially containing numbered lists
 * @param {Object} [options] - Conversion options
 * @param {boolean} [options.skip] - If true, skip list conversion entirely
 * @returns {string} Text with lists converted to AsciiDoc format
 */
function convertNumberedListsToAsciiDoc(text, options = {}) {
  if (!text || options.skip) return text

  const lines = text.split('\n')
  const result = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Check if this line starts a numbered list (indented number followed by period and space)
    // Pattern: spaces, then 1-3 digits, period, space, content
    if (/^[ \t]+(\d{1,3})\.\s+.+/.test(line)) {
      // Found potential list start - collect consecutive numbered items
      const listLines = [line]
      let j = i + 1
      let expectedNum = parseInt(line.match(/^[ \t]+(\d{1,3})\./)[1]) + 1

      while (j < lines.length) {
        const nextLine = lines[j]

        // Check if it's the next numbered item
        const nextMatch = nextLine.match(/^[ \t]+(\d{1,3})\.\s+.+/)
        if (nextMatch && parseInt(nextMatch[1]) === expectedNum) {
          listLines.push(nextLine)
          expectedNum++
          j++
        }
        // Allow blank lines within the list
        else if (/^[ \t]*$/.test(nextLine) && j + 1 < lines.length) {
          const afterBlank = lines[j + 1]
          const afterMatch = afterBlank.match(/^[ \t]+(\d{1,3})\.\s+.+/)
          if (afterMatch && parseInt(afterMatch[1]) === expectedNum) {
            listLines.push(nextLine) // Include blank line
            j++
            continue
          } else {
            break
          }
        } else {
          break
        }
      }

      // Convert to AsciiDoc list format if we have at least 2 items
      if (listLines.length >= 2) {
        // Add blank line before list if previous line isn't blank
        if (result.length > 0 && result[result.length - 1].trim() !== '') {
          result.push('')
        }

        // Convert each numbered item to AsciiDoc format (. instead of 1., 2., etc.)
        for (const listLine of listLines) {
          if (/^[ \t]*$/.test(listLine)) {
            result.push(listLine) // Keep blank lines
          } else {
            // Remove indentation and number, replace with '.'
            const content = listLine.replace(/^[ \t]+\d{1,3}\.\s+/, '')
            result.push(`. ${content}`)
          }
        }

        i = j
        continue
      }
    }

    // Not a list, keep the line as-is
    result.push(line)
    i++
  }

  return result.join('\n')
}

/**
 * Convert indented bulleted definition lists to AsciiDoc-compliant format
 * Detects patterns like:
 *   * Term: description text that may
 *           continue on next line
 *   * Another: more description
 *
 * Converts to proper AsciiDoc bullet list with bold terms:
 *   * *Term*: description text
 *   * *Another*: more description
 *
 * @param {string} text - Text potentially containing definition lists
 * @param {Object} [options] - Conversion options
 * @param {boolean} [options.skip] - If true, skip conversion entirely
 * @returns {string} Text with definition lists formatted as AsciiDoc
 */
function convertBulletedDefinitionListsToAsciiDoc(text, options = {}) {
  if (!text || options.skip) return text

  const lines = text.split('\n')
  const result = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Check for indented bullet with term:description pattern
    // Pattern: spaces, bullet (* or -), optional space, word(s), colon, description
    const bulletMatch = line.match(/^(\s{2,})([*-])\s+([A-Za-z][A-Za-z0-9_]*(?:\s+[A-Za-z][A-Za-z0-9_]*)*):\s+(.*)$/)

    if (bulletMatch) {
      const indent = bulletMatch[1]
      const bullet = bulletMatch[2]
      // Collect all consecutive bullets at same level with term: pattern
      const definitionItems = []
      let j = i

      while (j < lines.length) {
        const currentLine = lines[j]
        const currentMatch = currentLine.match(/^(\s{2,})([*-])\s+([A-Za-z][A-Za-z0-9_]*(?:\s+[A-Za-z][A-Za-z0-9_]*)*):\s+(.*)$/)

        if (currentMatch && currentMatch[1] === indent && currentMatch[2] === bullet) {
          // Start new definition item
          definitionItems.push({
            term: currentMatch[3],
            description: currentMatch[4]
          })
          j++

          // Check for continuation lines (more indented than the bullet)
          while (j < lines.length) {
            const nextLine = lines[j]
            // Continuation: starts with more indentation than the bullet, no bullet char
            if (nextLine.match(/^\s+/) && !nextLine.match(/^\s*[*-]\s/) && nextLine.trim()) {
              const continuationIndent = nextLine.match(/^(\s*)/)[1].length
              if (continuationIndent > indent.length) {
                // Append to description
                definitionItems[definitionItems.length - 1].description += ' ' + nextLine.trim()
                j++
              } else {
                break
              }
            } else if (/^\s*$/.test(nextLine)) {
              // Blank line - might be between items, peek ahead
              if (j + 1 < lines.length && lines[j + 1].match(new RegExp(`^${indent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[*-]\\s+[A-Za-z]`))) {
                j++ // Skip blank line between definition items
              } else {
                break
              }
            } else {
              break
            }
          }
        } else {
          break
        }
      }

      // Only convert if we have 2+ items (makes sense as a list)
      if (definitionItems.length >= 2) {
        result.push('')
        for (const item of definitionItems) {
          // Format as AsciiDoc bullet with backticked term
          result.push(`* \`${item.term}\`: ${item.description}`)
        }
        result.push('')
        i = j
        continue
      }
    }

    // Not a definition list, keep line as-is
    result.push(line)
    i++
  }

  return result.join('\n')
}

/**
 * Convert indented columnar text to AsciiDoc tables
 * Detects patterns like:
 *     value1    description of value1
 *     value2    description of value2
 *
 * @param {string} text - Text potentially containing indented tables
 * @param {Object} [options] - Conversion options
 * @param {boolean} [options.skip] - If true, skip table conversion entirely
 * @returns {string} Text with tables converted to AsciiDoc format
 */
function convertIndentedTablesToAsciiDoc(text, options = {}) {
  if (!text || options.skip) return text

  // Skip conversion if text contains code patterns (struct definitions, type declarations)
  if (/\b(type|struct|interface|class)\s+\w+\s*(struct\s*)?\{/.test(text)) {
    return text
  }

  const lines = text.split('\n')
  const result = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Check if this line starts a potential table (indented, has content)
    // Pattern: starts with spaces, has non-space content, then 2+ spaces, then more content
    if (/^[ \t]{2,}[^ \t].*  /.test(line)) {
      // Found potential table start - look ahead for consecutive similar lines
      const tableLines = [line]
      let j = i + 1

      while (j < lines.length) {
        const nextLine = lines[j]
        // Continue if line is indented and has columnar structure
        if (/^[ \t]{2,}[^ \t].*  /.test(nextLine)) {
          tableLines.push(nextLine)
          j++
        }
        // Or if it's a continuation line (indented more deeply, no column separator)
        else if (/^[ \t]{4,}[^ \t]/.test(nextLine) && !/  /.test(nextLine.trim())) {
          tableLines.push(nextLine)
          j++
        }
        // Or blank line followed by another table row
        else if (/^[ \t]*$/.test(nextLine) && j + 1 < lines.length && /^[ \t]{2,}[^ \t].*  /.test(lines[j + 1])) {
          tableLines.push(nextLine)
          j++
        } else {
          break
        }
      }

      // Only convert if we have 2+ rows (actual table)
      if (tableLines.length >= 2) {
        // Parse the table rows
        const parsedRows = []
        let currentRow = null

        for (const tableLine of tableLines) {
          if (/^[ \t]*$/.test(tableLine)) continue // Skip blank lines

          const trimmed = tableLine.trim()

          // Check if this is a continuation line (no column separator)
          if (currentRow && !/  /.test(trimmed)) {
            // Append to the last column of the current row
            const lastColIndex = currentRow.length - 1
            currentRow[lastColIndex] += ' ' + trimmed
          } else {
            // Extract columns: split on 2+ spaces
            const columns = trimmed.split(/  +/)

            if (columns.length >= 2) {
              currentRow = columns
              parsedRows.push(currentRow)
            }
          }
        }

        if (parsedRows.length >= 2) {
          // Convert to AsciiDoc table
          result.push('')
          result.push('[cols="1m,1a"]')
          result.push('|===')
          result.push('|Value |Description')
          result.push('')
          for (const [value, ...descParts] of parsedRows) {
            // Remove trailing colon from value (e.g., "Organization:" -> "Organization")
            const cleanValue = value.replace(/:$/, '')
            const desc = descParts.join(' ')
            // Escape {word} (no hyphens) in table cells — CLI format specifiers like {hex}, {json}
            // are not AsciiDoc attribute refs and must be escaped to prevent substitution.
            const escapeAttrs = s => s.replace(/\{([a-z_][a-z0-9_]*)\}/g, '\\{$1}')
            result.push(`|${escapeAttrs(cleanValue)} |${escapeAttrs(desc)}`)
          }
          result.push('|===')
          result.push('')

          i = j
          continue
        }
      }
    }

    // Not a table, keep the line as-is
    result.push(line)
    i++
  }

  return result.join('\n')
}

/**
 * Apply only the text replacements from textTransformations to a raw string.
 * Used for examples content where we want string substitutions (e.g. rpai → rpk ai)
 * but NOT AsciiDoc structural formatting or inlineCode wrapping.
 * @param {string} text
 * @param {Object|null} customTransformations
 * @returns {string}
 */
function applyTextTransformations(text, customTransformations) {
  if (!text || !customTransformations?.replacements) return text
  let result = text
  for (const rule of customTransformations.replacements) {
    try {
      const flags = rule.flags || 'g'
      result = result.replace(new RegExp(rule.pattern, flags), rule.replacement)
    } catch (err) {
      console.warn(`⚠ Invalid replacement pattern: ${rule.pattern}`)
    }
  }
  return result
}

/**
 * Format description by adding backticks around flags and code
 * @param {string} desc - Description text
 * @param {Object} [customTransformations] - Optional custom text transformations from overrides
 * @param {Object} [options] - Formatting options
 * @param {boolean} [options.skipTableConversion] - If true, skip automatic table conversion
 * @param {boolean} [options.skipListConversion] - If true, skip automatic list conversion
 * @returns {string} Formatted description
 */
function formatDescription(desc, customTransformations = null, options = {}) {
  if (!desc) return ''
  if (typeof desc !== 'string') return String(desc)

  let preProcessed = desc

  // === STEP 1: Apply merge patterns for broken inline code spans ===
  // These must run BEFORE protecting inline code, so they can fix patterns like:
  // `rpk command `-flag` rest` -> `rpk command -flag rest`
  if (customTransformations?.replacements) {
    const mergePatterns = customTransformations.replacements.filter(rule =>
      rule.description && rule.description.toLowerCase().includes('merge') &&
      rule.description.toLowerCase().includes('inline code')
    )

    for (const rule of mergePatterns) {
      try {
        const flags = rule.flags || 'g'
        const regex = new RegExp(rule.pattern, flags)
        preProcessed = preProcessed.replace(regex, rule.replacement)
      } catch (err) {
        console.warn(`⚠ Invalid merge pattern: ${rule.pattern}`)
        if (rule.description) console.warn(`  Description: ${rule.description}`)
        console.warn(`  Error: ${err.message}`)
      }
    }
  }

  // === STEP 1b: Detect and protect multi-line code/YAML blocks VERY EARLY ===
  // This must happen BEFORE single-line rpk conversion (STEP 1c) so multi-line
  // command examples are detected as blocks, not broken into pieces
  const earlyCodeBlocks = []
  preProcessed = convertIndentedCodeBlocksToAsciiDoc(preProcessed, earlyCodeBlocks)

  // === STEP 1c: Convert SINGLE-LINE indented commands to backticked inline code ===
  // Only applies to commands NOT already in code blocks (protected by STEP 1b)
  // This must happen BEFORE text transformations so paths inside commands don't get
  // individually backticked, creating nested placeholders that fail to restore.
  // Source often uses indentation for example commands:
  //     rpk cluster partitions balancer-status
  //     rpk cluster license set --path /home/file.license
  // Convert to:
  // `rpk cluster partitions balancer-status`
  // `rpk cluster license set --path /home/file.license`
  preProcessed = preProcessed.replace(/^[ \t]+(rpk\s+.+?)$/gm, (match, command) => {
    // Skip if this line is a placeholder (already converted to code block)
    if (command.startsWith('__EARLY_CODE_BLOCK_')) return match
    return `\`${command}\``
  })

  // Also convert indented non-rpk shell commands (starting with common commands)
  // These are shell snippets that should be code, not prose
  preProcessed = preProcessed.replace(/^[ \t]+((?:source|command|echo|export|brew|curl|wget|cat|mkdir|chmod|sudo)\s+.+?)$/gm, (match, command) => {
    // Skip if this line is a placeholder (already converted to code block)
    if (command.startsWith('__EARLY_CODE_BLOCK_')) return match
    return `\`${command}\``
  })

  // === STEP 2: Protect code blocks, xrefs, and inline code ===
  // Protect code blocks FIRST (before any transformations)
  const codeBlocks = []
  preProcessed = preProcessed.replace(/(\[,?[a-z]*\]\n)?----\n[\s\S]*?\n----/g, (match) => {
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`
    codeBlocks.push(match)
    return placeholder
  })

  // Protect xref paths BEFORE inline code (xrefs may contain backticked link text)
  // This ensures the entire xref including link text is protected as a unit
  const xrefs = []
  preProcessed = preProcessed.replace(/xref:[^\[]+\[[^\]]*\]/g, (match) => {
    const placeholder = `__XREF_${xrefs.length}__`
    xrefs.push(match)
    return placeholder
  })

  // Protect inline code (backticked content)
  // Escape {word} (no hyphens) inside backtick spans — these are CLI format specifiers or
  // path placeholders, not AsciiDoc attribute refs (which use hyphens like {full-version}).
  // AsciiDoc single-backtick spans still apply attribute substitution, so {hex}/{namespace}/etc.
  // would expand to empty string without this escaping.
  const inlineCode = []
  preProcessed = preProcessed.replace(/`[^`]+`/g, (match) => {
    const placeholder = `__INLINE_CODE_${inlineCode.length}__`
    // Skip `+...+` passthrough spans — they already prevent attribute substitution
    const escaped = (match.startsWith('`+') && match.endsWith('+`'))
      ? match
      : match.replace(/\{([a-z_][a-z0-9_]*)\}/g, '\\{$1}')
    inlineCode.push(escaped)
    return placeholder
  })

  // === STEP 3: Apply remaining text transformations ===
  // Apply text transformations from overrides (textTransformations.replacements)
  // These are applied AFTER protecting code blocks so they don't affect code content
  // Note: Merge patterns were already applied in STEP 1
  if (customTransformations?.replacements) {
    const nonMergePatterns = customTransformations.replacements.filter(rule =>
      !rule.description || !rule.description.toLowerCase().includes('merge') ||
      !rule.description.toLowerCase().includes('inline code')
    )

    for (const rule of nonMergePatterns) {
      try {
        const flags = rule.flags || 'g'
        const regex = new RegExp(rule.pattern, flags)
        preProcessed = preProcessed.replace(regex, rule.replacement)
      } catch (err) {
        console.warn(`⚠ Invalid replacement pattern: ${rule.pattern}`)
        if (rule.description) console.warn(`  Description: ${rule.description}`)
        console.warn(`  Error: ${err.message}`)
      }
    }
  }

  // Re-protect inline code after text transformations
  // Some transformations (like converting "rpk ..." to `rpk ...`) create new inline code
  // that needs protection before subsequent patterns run
  preProcessed = preProcessed.replace(/`[^`]+`/g, (match) => {
    const placeholder = `__INLINE_CODE_${inlineCode.length}__`
    inlineCode.push(match)
    return placeholder
  })

  // Convert numbered lists to AsciiDoc list format
  // This must be done BEFORE table conversion (lists are simpler patterns)
  preProcessed = convertNumberedListsToAsciiDoc(preProcessed, { skip: options.skipListConversion })

  // Convert indented bulleted definition lists to AsciiDoc-compliant format
  // Pattern: "  * Term: description" becomes "* `Term`: description"
  preProcessed = convertBulletedDefinitionListsToAsciiDoc(preProcessed, { skip: options.skipListConversion })

  // Convert indented columnar text to AsciiDoc tables
  preProcessed = convertIndentedTablesToAsciiDoc(preProcessed, { skip: options.skipTableConversion })

  let protectedDesc = preProcessed

  // Apply custom inline code patterns (from overrides textTransformations.inlineCode)
  // Applied AFTER protecting existing code blocks/inline code to avoid double-wrapping
  if (customTransformations?.inlineCode) {
    for (const rule of customTransformations.inlineCode) {
      try {
        // Handle both string and object format
        const pattern = typeof rule === 'string' ? rule : rule.pattern
        const replacement = rule.replacement || '`$&`' // $& = entire match
        const flags = (typeof rule === 'object' ? rule.flags : null) || 'g'
        const regex = new RegExp(pattern, flags)

        protectedDesc = protectedDesc.replace(regex, (match, ...args) => {
          // Skip if this is a placeholder (already protected content)
          if (match.startsWith('__INLINE_CODE_') || match.startsWith('__CODE_BLOCK_')) {
            return match
          }

          // Apply the transformation
          if (rule.replacement) {
            // Custom replacement with capture group support
            return rule.replacement
              .replace(/\$(\d+)/g, (_, n) => args[parseInt(n) - 1] || '')
              .replace(/\$&/g, match)
          } else {
            // Default: wrap in backticks
            return `\`${match}\``
          }
        })
      } catch (err) {
        const patternStr = typeof rule === 'string' ? rule : rule.pattern
        console.warn(`⚠ Invalid inline code pattern: ${patternStr}`)
        if (typeof rule === 'object' && rule.description) {
          console.warn(`  Description: ${rule.description}`)
        }
        console.warn(`  Error: ${err.message}`)
      }
    }
  }

  // Re-protect any new inline code created by inlineCode transformations
  // This ensures newly backticked content is preserved through subsequent transformations
  protectedDesc = protectedDesc.replace(/`[^`]+`/g, (match) => {
    const placeholder = `__INLINE_CODE_${inlineCode.length}__`
    inlineCode.push(match)
    return placeholder
  })

  // Known top-level rpk subcommands (for accurate command detection)
  const rpkSubcommands = new Set([
    'ai', 'check', 'cloud', 'cluster', 'connect', 'container', 'debug',
    'generate', 'group', 'help', 'iotune', 'oxla', 'plugin', 'profile',
    'redpanda', 'registry', 'security', 'shadow', 'topic', 'transform', 'version'
  ])

  // Common prose words that indicate "rpk X" is NOT a command
  const proseWords = new Set([
    'a', 'an', 'and', 'or', 'the', 'is', 'was', 'are', 'were', 'will',
    'can', 'could', 'may', 'might', 'should', 'would', 'has', 'have',
    'had', 'does', 'do', 'did', 'with', 'from', 'to', 'for', 'of', 'by',
    'that', 'this', 'these', 'those', 'it', 'its'
  ])

  let result = convertMarkdownLists(decodeHtmlEntities(protectedDesc))
    // === NORMALIZE SOURCE DATA ISSUES ===
    // Fix fragmented backticks like `rpk` `--version` → rpk --version
    .replace(/`rpk`\s*`(--?[a-z][-a-z0-9]*)`/gi, 'rpk $1')
    // Remove single quotes around flags: '--flag' → --flag (backticks added later)
    // Also handles '--flag/-f', '--flag help', and similar patterns
    .replace(/'(--[a-z][-a-z0-9]*(?:\/-[a-z])?(?:\s+\w+)?)'/gi, '$1')
    .replace(/'(-[a-z])'/gi, '$1')
    // === STYLE GUIDE COMPLIANCE ===
    .replace(/\be\.g\.\s*/gi, 'for example, ')
    .replace(/\bi\.e\.\s*/gi, 'that is, ')
    // === TYPO CORRECTIONS ===
    // Fix "an" before consonant sounds (common source typos)
    .replace(/\ban\s+(prod|dev|test|local|remote|new|cluster|config|file)\b/gi, 'a $1')
    // Note: File name backticking moved after file path processing
    // === CAPITALIZATION ===
    // Capitalize "redpanda" when clearly referring to the product (not YAML config sections or commands)
    // Match: "redpanda" followed by product-context words
    .replace(/(?<!rpk\s)(?<![`\w-])redpanda(?=\s+(?:requirements?|will|settings?|binar(?:y|ies)|process(?:es)?|nodes?|has|cluster|Console|data|is|installations?|starts?|reverts?|expects?|ID|deployment))/gi, 'Redpanda')
    // Special case: "redpanda config file" (but not "rpk redpanda config" which is a command)
    .replace(/(?<!rpk\s)(?<![`\w-])redpanda\s+config\s+file/gi, 'Redpanda config file')
    // Capitalize at start of sentence
    .replace(/(^|[.!?]\s+)redpanda\b(?!\.yaml|data\/|section|-)/gim, '$1Redpanda')
    // Fix product name: "Redpanda cloud" → "Redpanda Cloud" (product name)
    .replace(/Redpanda\s+cloud\b/g, 'Redpanda Cloud')

  // === RPK COMMAND FORMATTING (context-aware) ===
  // Process "rpk X" patterns based on what follows
  result = result.replace(/(?<![`\w])rpk(\s+)([a-z][-a-z0-9]*)(?:\s+|(?=[.,;:!?)'"}\]]|$))/gi, (match, space, word, offset, str) => {
    const lowerWord = word.toLowerCase()

    // Skip wrapping when "rpk profile" refers to config profile, not the command
    // e.g., "your rpk profile" or "an rpk profile"
    if (lowerWord === 'profile') {
      const before = str.slice(Math.max(0, offset - 10), offset)
      if (/\b(your|an|the)\s+$/i.test(before)) {
        return match // Don't wrap - it's referring to the config profile concept
      }
    }

    // If followed by a prose word, only wrap "rpk"
    if (proseWords.has(lowerWord)) {
      return '`rpk`' + space + word + (match.endsWith(word) ? '' : match.slice(match.lastIndexOf(word) + word.length))
    }

    // If it's a known rpk subcommand, check what follows to decide
    if (rpkSubcommands.has(lowerWord)) {
      // Look ahead to see if there's more text after this
      const remaining = str.slice(offset + match.length).trimStart()

      // If followed by a flag, wrap "rpk subcommand" together (will be handled by flag regex)
      if (/^--?[a-z]/i.test(remaining)) {
        return match // Let the rpk+flag regex handle it
      }

      // If followed by more words, check if they look like prose or commands
      const nextWordMatch = remaining.match(/^([a-z][-a-z0-9]*)/i)
      if (nextWordMatch) {
        const nextWord = nextWordMatch[1].toLowerCase()
        // Words ending in common noun suffixes are likely prose, not commands
        // e.g., "authentications", "clusters", "configurations", "settings"
        if (/(?:tions?|ments?|ings?|ers?|ors?|ies|s)$/i.test(nextWord) && !rpkSubcommands.has(nextWord)) {
          // It's prose like "rpk cloud authentications" - just wrap rpk
          return '`rpk`' + space + word + (match.endsWith(word) ? '' : match.slice(match.lastIndexOf(word) + word.length))
        }
      }

      // At end of phrase or followed by punctuation - wrap together
      if (!remaining || /^[.,;:!?)'"}\]]/.test(remaining)) {
        return '`rpk ' + word + '`' + (match.endsWith(word) ? '' : match.slice(match.lastIndexOf(word) + word.length))
      }

      // Default: just wrap rpk alone to be safe
      return '`rpk`' + space + word + (match.endsWith(word) ? '' : match.slice(match.lastIndexOf(word) + word.length))
    }

    // Unknown word - conservatively just wrap "rpk"
    return '`rpk`' + space + word + (match.endsWith(word) ? '' : match.slice(match.lastIndexOf(word) + word.length))
  })

  // Wrap rpk with flags: rpk --version, rpk -v
  result = result.replace(/(?<![`\w])rpk\s+(--?[a-z][-a-z0-9]*)/gi, '`rpk $1`')

  // Add backticks around standalone flags (with optional =value)
  // Don't wrap flags that are inside backticks OR immediately after "rpk "
  // Split by backticks to process only content outside of backticked sections
  const flagParts = result.split('`')
  result = flagParts.map((part, i) => {
    // Even indices are outside backticks, odd indices are inside
    if (i % 2 === 0) {
      // Outside backticks - apply flag wrapping
      // Include =value when present (e.g., --format=json, --var=KEY=VALUE)
      return part.replace(/(?<!rpk\s)(--[a-z][-a-z0-9]*(?:=[^\s,;.)\]]+)?)/gi, '`$1`')
    } else {
      // Inside backticks - don't modify
      return part
    }
  }).join('`')
  result = result.replace(/(?<!`|-)(-[a-zA-Z])(?![a-zA-Z-])/g, '`$1`')

  // Add backticks around environment variables
  result = result.replace(/(?<!`)(\$[A-Z_][A-Z0-9_]*)/g, '`$1`')

  // Merge backticked environment variables with adjacent paths
  // e.g., `$HOME`/.local/bin → `$HOME/.local/bin`
  result = result.replace(/`(\$[A-Z_][A-Z0-9_]*)`(\/[^\s`]+)/g, '`$1$2`')

  // Add backticks around file paths (but not if already backticked)
  // Must check both the slash and the path aren't already inside backticks
  result = result.replace(/(?<![`/])(\/(?:etc|var|usr|home|tmp)\/[^\s,)`]+)/g, '`$1`')
  result = result.replace(/(?<![`/])((?:etc|var|usr|home|tmp)\/[^\s,)`]+)/g, '`$1`')

  // Add backticks around home directory paths (~/.bashrc, ~/.zshrc, ~/.config/...)
  result = result.replace(/(?<![`\w])(~\/\.[^\s,;:)`]+)/g, '`$1`')

  // Add backticks around common package names
  result = result.replace(/(?<![`\w-])(bash-completion)(?![`\w-])/g, '`$1`')

  // Add backticks around standalone file names (not inside paths)
  result = result.replace(/(?<![`/])(redpanda\.yaml|rpk\.yaml)(?!`)/gi, '`$1`')

  // Add backticks around standalone "rpk" (at end of phrase, before punctuation)
  // Also exclude rpk inside paths (preceded by /)
  result = result.replace(/(?<![`\w/])rpk(?=[\s]*[.,;:!?)'"}\]]|[\s]*$)/g, '`rpk`')

  // Convert GitHub issue/PR references to clickable links
  // Pattern: #NNNN (4+ digits) when not inside backticks or code
  // e.g., "(see #2904)" → "(see https://github.com/redpanda-data/redpanda/issues/2904[#2904])"
  result = result.replace(/(?<![`\w])#(\d{4,})(?![`\w])/g, 'https://github.com/redpanda-data/redpanda/issues/$1[#$1]')

  // Restore early code blocks FIRST (from indented command/YAML detection)
  // This must happen before inline code restoration so that placeholders
  // inside the early code blocks (like __INLINE_CODE_X__) get resolved
  // Use function replacements to prevent $ special-pattern interpretation (e.g. `$` → before-match)
  earlyCodeBlocks.forEach((block, i) => {
    result = result.replace(`__EARLY_CODE_BLOCK_${i}__`, () => block)
  })

  // Restore inline code
  inlineCode.forEach((code, i) => {
    result = result.replace(`__INLINE_CODE_${i}__`, () => code)
  })

  // Restore xrefs
  xrefs.forEach((xref, i) => {
    result = result.replace(`__XREF_${i}__`, () => xref)
  })

  // Restore code blocks
  codeBlocks.forEach((block, i) => {
    result = result.replace(`__CODE_BLOCK_${i}__`, () => block)
  })

  // Clean up double backticks (moved AFTER restoration to catch nested backticks)
  result = result.replace(/``+/g, '`')

  // Final pass: escape {word} (no hyphens) inside any backtick spans that were created
  // dynamically during processing (after the initial inline-code protection step).
  // Skip `+...+` passthrough spans — they already prevent attribute substitution.
  // Use negative lookbehind (?<!\\) to avoid double-escaping already-escaped \{word}.
  result = result.replace(/`[^`]+`/g, match => {
    if (match.startsWith('`+') && match.endsWith('+`')) return match
    return match.replace(/(?<!\\)\{([a-z_][a-z0-9_]*)\}/g, '\\{$1}')
  })

  // Escape {word} (no hyphens) in AsciiDoc table cell lines that come from pre-formatted
  // AsciiDoc in CLI descriptions (e.g. format specifier tables with {hex}, {json}).
  // These never pass through backtick-span protection, so they need a separate pass.
  result = result.replace(/^\|(.*)$/gm, (match, cellContent) => {
    if (!/(?<!\\)\{[a-z_][a-z0-9_]*\}/.test(cellContent)) return match
    return '|' + cellContent.replace(/(?<!\\)\{([a-z_][a-z0-9_]*)\}/g, '\\{$1}')
  })

  // Remove trailing period after backticked commands on their own line
  // e.g., "`rpk cluster status`." → "`rpk cluster status`"
  // Only consume trailing spaces, not newlines (to preserve paragraph breaks)
  result = result.replace(/^(`[^`]+`)\.[ \t]*$/gm, '$1')

  return result
}

/**
 * Format usage string - convert [PLACEHOLDER] to <placeholder>
 * @param {string} usage - Usage string from rpk
 * @returns {string} Formatted usage string
 */
function formatUsage(usage) {
  if (!usage) return ''
  // Convert [UPPERCASE-PLACEHOLDER] to <lowercase-placeholder>
  // But keep [flags] as-is since that's the standard convention
  return usage.replace(/\[([A-Z][-A-Z0-9_]*(?:\.\.\.)?)\]/g, (match, placeholder) => {
    return '<' + placeholder.toLowerCase() + '>'
  })
}

/**
 * Format EXAMPLES section - convert indented commands and inline code to AsciiDoc code blocks.
 *
 * Handles the standard Go CLI example format where each group is separated by a blank line,
 * comment lines (# ...) describe the example, and command lines follow:
 *
 *   # Description of the example
 *   rpk some command --flag
 *
 *   # Another example
 *   rpk other command
 *   rpk other command --variant
 *
 * Comments become plain text descriptions; consecutive command lines share one code block.
 *
 * @param {string} text - Examples text with indented commands or inline code
 * @returns {string} Formatted examples with code blocks
 */
function formatExamples(text) {
  if (!text) return text

  const lines = text.split('\n')
  const result = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const isIndented = /^\s{2,}\S/.test(line)

    if (isIndented && line.trim().startsWith('#')) {
      // Comment line — render as a description paragraph outside the code block
      result.push(line.trim().replace(/^#\s*/, ''))
      i++
    } else if (isIndented) {
      // Command line — collect all consecutive command lines into one code block
      // (stops at a blank line or a comment line)
      result.push('[,bash]')
      result.push('----')
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !lines[i].trim().startsWith('#')) {
        result.push(lines[i].trim())
        i++
      }
      result.push('----')
    } else if (/^\s*`rpk .+`\s*$/.test(line)) {
      // Inline backticked command on its own line - convert to code block
      const command = line.trim().replace(/^`|`$/g, '')
      result.push('')
      result.push('[,bash]')
      result.push('----')
      result.push(command)
      result.push('----')
      i++
    } else if (i + 1 < lines.length && /^\s*`rpk .+`\s*$/.test(lines[i + 1])) {
      // Description followed by backticked command on next line
      // Remove trailing colon from description if present
      const description = line.replace(/:$/, '.')
      const command = lines[i + 1].trim().replace(/^`|`$/g, '')
      result.push(description)
      result.push('')
      result.push('[,bash]')
      result.push('----')
      result.push(command)
      result.push('----')
      i += 2
    } else {
      // Regular line (blank line, non-indented description text, etc.)
      result.push(line)
      i++
    }
  }

  return result.join('\n')
}

/**
 * Filter out specific examples from raw EXAMPLES section content
 * @param {string} text - Raw examples text (before formatting)
 * @param {string[]} excludePatterns - Array of regex patterns to exclude
 * @returns {string} Filtered examples text
 */
function filterExamples(text, excludePatterns) {
  if (!text || !excludePatterns || excludePatterns.length === 0) return text

  const patterns = excludePatterns.map(p => new RegExp(p, 'i'))
  const lines = text.split('\n')
  const filteredLines = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const nextLine = lines[i + 1] || ''

    // Check if next line is an indented command (2+ spaces)
    if (/^\s{2,}\S/.test(nextLine)) {
      // This is a description + command pair
      const shouldExclude = patterns.some(pattern =>
        pattern.test(line) || pattern.test(nextLine.trim())
      )
      if (!shouldExclude) {
        filteredLines.push(line)
        filteredLines.push(nextLine)
      }
      i += 2
    } else if (/^\s{2,}\S/.test(line)) {
      // Standalone indented command
      const shouldExclude = patterns.some(pattern => pattern.test(line.trim()))
      if (!shouldExclude) {
        filteredLines.push(line)
      }
      i++
    } else if (line.trim() === '') {
      // Blank line - keep it unless previous content was excluded
      filteredLines.push(line)
      i++
    } else {
      // Regular line (description without following command, etc.)
      const shouldExclude = patterns.some(pattern => pattern.test(line))
      if (!shouldExclude) {
        filteredLines.push(line)
      }
      i++
    }
  }

  // Clean up multiple consecutive blank lines
  return filteredLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Parse ALL CAPS sections from description
 * @param {string} desc - Description text
 * @returns {Object} { mainDescription, sections }
 */
function parseDescriptionSections(desc) {
  if (!desc) return { mainDescription: '', sections: {} }
  if (typeof desc !== 'string') {
    return { mainDescription: String(desc), sections: {} }
  }

  const lines = desc.split('\n')
  const sections = {}
  let currentSection = null
  let currentContent = []
  const mainLines = []

  for (const line of lines) {
    // Check for ALL CAPS header (at least 2 chars, possibly with spaces, hyphens, slashes, or ampersands)
    // Examples: "FIELDS", "BALANCER STATUS", "PRODUCER ID & EPOCH"
    const headerMatch = line.match(/^([A-Z][A-Z\s\-\/&]{0,}[A-Z])$/)
    if (headerMatch) {
      // Save previous section
      if (currentSection) {
        // Preserve indentation: only remove leading/trailing blank lines, not spaces
        sections[currentSection] = trimBlankLines(currentContent.join('\n'))
      }
      currentSection = headerMatch[1].trim()
      currentContent = []
    } else if (currentSection) {
      currentContent.push(line)
    } else {
      mainLines.push(line)
    }
  }

  // Save last section
  if (currentSection) {
    // Preserve indentation: only remove leading/trailing blank lines, not spaces
    sections[currentSection] = trimBlankLines(currentContent.join('\n'))
  }

  return {
    mainDescription: mainLines.join('\n').trim(),
    sections
  }
}

/**
 * Remove leading and trailing blank lines while preserving line indentation
 * @param {string} text - Input text
 * @returns {string} Text with blank lines removed from start/end
 */
function trimBlankLines(text) {
  if (!text) return ''
  // Split into lines
  const lines = text.split('\n')
  // Find first non-blank line
  let start = 0
  while (start < lines.length && /^\s*$/.test(lines[start])) {
    start++
  }
  // Find last non-blank line
  let end = lines.length - 1
  while (end >= start && /^\s*$/.test(lines[end])) {
    end--
  }
  // Return the slice, joined
  if (start > end) return ''
  return lines.slice(start, end + 1).join('\n')
}

/**
 * Ensure description ends with a period
 * @param {string} desc - Description text
 * @returns {string} Description ending with period
 */
function ensurePeriod(desc) {
  if (!desc) return ''
  const trimmed = desc.trim()
  if (!trimmed) return ''

  // Handle multi-paragraph descriptions - ensure each paragraph ends with punctuation
  // Split on double newlines (paragraph breaks)
  const paragraphs = trimmed.split(/\n\s*\n/)
  const fixedParagraphs = paragraphs.map(p => {
    const trimmedP = p.trim()
    if (!trimmedP) return ''
    // Don't modify code blocks or their delimiters
    if (trimmedP.startsWith('----') || trimmedP.endsWith('----') || trimmedP.startsWith('[,')) {
      return trimmedP
    }
    // Don't modify lines that are clearly code or formatting (start with special chars)
    // Also skip list items (bullets and numbered lists)
    if (/^[|=\[\]*\-0-9]/.test(trimmedP)) {
      return trimmedP
    }

    // Check if paragraph contains list items - if so, process line by line
    if (/\n\s*[-*]\s+/.test(trimmedP)) {
      const lines = trimmedP.split('\n')
      const fixedLines = lines.map(line => {
        const trimmedLine = line.trim()
        // Skip list items
        if (/^[-*]\s+/.test(trimmedLine)) {
          return line
        }
        // Skip empty lines
        if (!trimmedLine) {
          return line
        }
        // For non-list lines, add period if needed
        if (!/[.!?:;]$/.test(trimmedLine)) {
          return line + '.'
        }
        return line
      })
      return fixedLines.join('\n')
    }

    // Add period if paragraph doesn't end with sentence-ending punctuation
    // Note: Colons indicate lists/code follow, so don't add period after them
    // Semicolons in lists also shouldn't get periods
    if (!/[.!?:;]$/.test(trimmedP)) {
      // Special case: if the entire paragraph is just a backticked command (starts and ends with `),
      // don't add a period - it's a command reference, not a sentence
      if (/^`[^`]+`$/.test(trimmedP)) {
        return trimmedP
      }
      return trimmedP + '.'
    }
    return trimmedP
  }).filter(p => p)

  return fixedParagraphs.join('\n\n')
}

/**
 * Convert command path to dashified filename
 * @param {string} commandPath - Command path (e.g., "rpk topic create")
 * @returns {string} Dashified path (e.g., "rpk-topic-create")
 */
function dashify(commandPath) {
  return commandPath.replace(/\s+/g, '-')
}

/**
 * Cap description to first two sentences
 * @param {string} desc - Full description
 * @returns {string} Short description
 */
function capToTwoSentences(desc) {
  if (!desc) return ''
  if (typeof desc !== 'string') return String(desc)

  // Remove section headers and content after them (for overrides that include full content)
  // Pattern: matches == Section Header and everything after it
  let cleaned = desc.replace(/\s*==\s+.+$/s, '')

  // Remove indented content (tables, lists, etc.) after colons before sentence detection
  // Pattern: text ending with colon, optionally followed by blank line, then indented content
  // Examples:
  //   "Retrieve license information:\n\n    Org:    description\n    Type:   description" (with blank line)
  //   "Loggers are discovered by, in order:\n  1. First\n  2. Second" (no blank line)
  // Should both become: "Text ending with colon:"
  // The pattern matches: colon, optional whitespace/newlines, then indented content
  cleaned = cleaned.replace(/:\s*\n+[ \t]+.+$/s, ':')

  // Normalize newlines to spaces for inline use (like :description: attribute)
  const singleLine = cleaned.replace(/\s*\n+\s*/g, ' ').trim()

  // Protect backticked content first (prevents periods inside backticks from breaking sentences)
  const backticks = []
  let normalized = singleLine.replace(/`[^`]+`/g, match => {
    const ph = `__BACKTICK${backticks.length}__`
    backticks.push({ ph, original: match })
    return ph
  })

  // Protect common abbreviations
  const abbrevs = ['e.g.', 'i.e.', 'etc.', 'vs.', 'v.']
  const placeholders = []

  for (const abbrev of abbrevs) {
    const regex = new RegExp(abbrev.replace(/\./g, '\\.'), 'gi')
    normalized = normalized.replace(regex, match => {
      const ph = `__ABBREV${placeholders.length}__`
      placeholders.push({ ph, original: match })
      return ph
    })
  }

  // Match sentences
  const sentences = normalized.match(/[^.!?]+[.!?]+(?:\s|$)/g)
  if (!sentences || sentences.length === 0) {
    // Restore and return
    let result = normalized
    placeholders.forEach(({ ph, original }) => {
      result = result.replace(ph, original)
    })
    backticks.forEach(({ ph, original }) => {
      result = result.replace(ph, original)
    })
    return result
  }

  let result = sentences.slice(0, 2).join('')

  // Restore abbreviations
  placeholders.forEach(({ ph, original }) => {
    result = result.replace(ph, original)
  })

  // Restore backticked content
  backticks.forEach(({ ph, original }) => {
    result = result.replace(ph, original)
  })

  return result.trim()
}

/**
 * Flatten command tree into array of commands with full paths
 * @param {Object} node - Tree node
 * @param {string} parentPath - Parent command path
 * @returns {Array} Array of { path, command } objects
 */
function flattenCommands(node, parentPath = '') {
  const results = []

  const currentPath = parentPath ? `${parentPath} ${node.name}` : node.name

  results.push({
    path: currentPath,
    command: node
  })

  if (node.commands && Array.isArray(node.commands)) {
    for (const child of node.commands) {
      results.push(...flattenCommands(child, currentPath))
    }
  }

  return results
}

/**
 * Determine output path for a command based on directory structure rules:
 * - Top-level commands with subcommands go in subdirectories (e.g., rpk-topic/rpk-topic.adoc)
 * - Descendants of those commands go in the same subdirectory (e.g., rpk-topic/rpk-topic-create.adoc)
 * - Top-level commands without subcommands go at root (e.g., rpk-help.adoc)
 *
 * @param {string} commandPath - Full command path (e.g., "rpk topic create")
 * @param {Set<string>} topLevelWithSubcommands - Set of top-level command names that have subcommands
 * @returns {Object} { subdir: string|null, fileName: string }
 */
function getOutputPath(commandPath, topLevelWithSubcommands) {
  const parts = commandPath.split(' ')
  const fileName = `${dashify(commandPath)}.adoc`

  // Root command (rpk itself)
  if (parts.length === 1) {
    return { subdir: null, fileName }
  }

  // Get the top-level command name (first part after 'rpk')
  const topLevelName = parts[1]

  // If this top-level command has subcommands, use subdirectory
  if (topLevelWithSubcommands.has(topLevelName)) {
    const subdir = `rpk-${topLevelName}`
    return { subdir, fileName }
  }

  // Otherwise, file goes at root
  return { subdir: null, fileName }
}

/**
 * Identify top-level commands (direct children of rpk) that have subcommands
 * @param {Object} tree - The rpk command tree
 * @returns {Set<string>} Set of command names that have subcommands
 */
function findTopLevelWithSubcommands(tree) {
  const result = new Set()

  if (tree.commands && Array.isArray(tree.commands)) {
    for (const child of tree.commands) {
      if (child.commands && child.commands.length > 0) {
        result.add(child.name)
      }
    }
  }

  return result
}

/**
 * Generate AsciiDoc documentation for all rpk commands
 * @param {Object} options - Generation options
 * @returns {Object} Generation result
 */
async function generateRpkDocs(options = {}) {
  const {
    tree,
    overrides,
    outputDir,
    cloudSecretDir, // Directory for rpk cloud and rpk security secret commands
    rpkVersion,
    pluginVersions = {},
    draftMissing = false,
    flatOutput = false // If true, output all files flat (legacy behavior)
  } = options

  // Register partials
  const partialsDir = path.join(TEMPLATES_DIR)
  const partialFiles = fs.readdirSync(partialsDir).filter(f => f.endsWith('.hbs') && f !== 'command.hbs')
  for (const file of partialFiles) {
    const name = file.replace('.hbs', '')
    registerPartial(name, path.join(partialsDir, file))
  }

  // Load main template
  const templatePath = path.join(TEMPLATES_DIR, 'command.hbs')
  const template = loadTemplate(templatePath)

  // Resolve references in overrides
  const resolvedOverrides = overrides ? resolveReferences(overrides, overrides) : null

  // Extract text transformations from overrides (applied globally to all descriptions)
  const textTransformations = resolvedOverrides?.textTransformations || null
  if (textTransformations) {
    const replacementCount = textTransformations.replacements?.length || 0
    const inlineCodeCount = textTransformations.inlineCode?.length || 0
    if (replacementCount > 0 || inlineCodeCount > 0) {
      console.log(`Loaded text transformations: ${replacementCount} replacement(s), ${inlineCodeCount} inline code pattern(s)`)
    }
  }

  // Create output directory
  try {
    fs.mkdirSync(outputDir, { recursive: true })
  } catch (err) {
    throw new Error(`Failed to create output directory "${outputDir}": ${err.message}`)
  }

  // Flatten command tree
  const commands = flattenCommands(tree)

  // Find top-level commands with subcommands (for directory structure)
  const topLevelWithSubcommands = findTopLevelWithSubcommands(tree)

  // Track created subdirectories
  const createdSubdirs = new Set()

  let filesGenerated = 0
  let filesSkipped = 0
  let filesFailed = 0
  let filesDeleted = 0
  const writtenFiles = new Set()

  for (const { path: commandPath, command } of commands) {
    // Check if command should be excluded
    if (shouldExcludeCommand(resolvedOverrides, commandPath)) {
      filesSkipped++
      continue
    }

    // Merge overrides
    const mergedCommand = mergeCommandOverrides(command, resolvedOverrides, commandPath)

    // Get preserved content for this command
    const commandOverride = resolvedOverrides?.commands?.[commandPath] || {}
    // Parse description sections
    const { mainDescription, sections: rawSections } = parseDescriptionSections(mergedCommand.description || '')

    // Format description with backticks and ensure it ends with period
    const formattedDescription = ensurePeriod(formatDescription(mainDescription, textTransformations))

    // Format section content with same formatting rules
    // BUT: Handle EXAMPLES sections specially to convert indented commands to code blocks
    const sections = {}
    for (const [sectionName, sectionContent] of Object.entries(rawSections)) {
      if (sectionName === 'EXAMPLES') {
        // Apply excludeExamples filter BEFORE formatting
        let examplesContent = sectionContent
        if (mergedCommand.excludeExamples && mergedCommand.excludeExamples.length > 0) {
          examplesContent = filterExamples(sectionContent, mergedCommand.excludeExamples)
        }
        // Apply text transformations (e.g. rpai → rpk ai) then format
        examplesContent = applyTextTransformations(examplesContent, textTransformations)
        sections[sectionName] = formatExamples(examplesContent)
      } else {
        sections[sectionName] = formatDescription(sectionContent, textTransformations)
      }
    }

    // Add examples from rpk source if not already in sections
    // rpk --print-tree provides examples in a separate field
    if (command.examples && !sections.EXAMPLES) {
      // Strip surrounding blank lines only — preserve per-line indentation so formatExamples
      // can detect indented command lines vs plain description text
      let examplesContent = command.examples.replace(/^\n+/, '').replace(/\n+$/, '')
      // Apply excludeExamples filter BEFORE formatting
      if (mergedCommand.excludeExamples && mergedCommand.excludeExamples.length > 0) {
        examplesContent = filterExamples(examplesContent, mergedCommand.excludeExamples)
      }
      // Apply text transformations (e.g. rpai → rpk ai) then format
      examplesContent = applyTextTransformations(examplesContent, textTransformations)
      sections.EXAMPLES = formatExamples(examplesContent)
    }

    // Process unified content array from overrides
    const processedContent = processContentArray(mergedCommand.content, commandPath)

    // Process section overrides: exclude or replace content
    // Check content array for section items that modify source sections
    if (mergedCommand.content && Array.isArray(mergedCommand.content)) {
      for (const item of mergedCommand.content) {
        if (item.type === 'section' && item.id) {
          // Try both lowercase and uppercase versions of the ID
          // (section IDs in the description are ALL CAPS, but override IDs might be lowercase)
          const uppercaseId = item.id.toUpperCase()
          const lowercaseId = item.id.toLowerCase()
          const titleCaseId = item.id.charAt(0).toUpperCase() + item.id.slice(1).toLowerCase()

          // Find which key matches a source section
          const matchingKey = sections[uppercaseId] ? uppercaseId :
                              sections[lowercaseId] ? lowercaseId :
                              sections[titleCaseId] ? titleCaseId :
                              sections[item.id] ? item.id : null

          if (matchingKey) {
            if (item.exclude === true) {
              // Exclude: remove the section entirely
              delete sections[matchingKey]
            } else if (item.content !== undefined) {
              // Replace: use override content instead of source content
              sections[matchingKey] = item.content
            }
          }
        }
      }
    }

    // If there's a section with id='examples' OR type='examples'/'example' in content array, suppress sections.EXAMPLES
    // to avoid duplicate Examples sections in the output
    const hasExamplesSection = processedContent.sections &&
      Object.values(processedContent.sections).some(arr =>
        arr.some(s => s.id === 'examples' || s.type === 'examples' || s.type === 'example')
      )

    if (hasExamplesSection) {
      delete sections.EXAMPLES
    }

    // Compute unknown sections (sections not explicitly handled by template)
    // These will be rendered in a generic loop at the end
    const knownSections = new Set([
      'COMMON FILES', 'BARE-METAL', 'KUBERNETES', 'EXTRA REQUESTS FOR PARTITIONS',
      'FORMAT', 'COLORS', 'MODIFIERS', 'RAW MODE',
      'PRINCIPALS', 'ROLES', 'HOSTS', 'RESOURCES', 'OPERATIONS', 'PERMISSIONS', 'MANAGEMENT',
      'NUMBERS', 'TEXT', 'HEADERS', 'ATTRIBUTES', 'OFFSETS', 'VALUES',
      'SCHEMA-REGISTRY', 'TOMBSTONES', 'EXAMPLES', 'MISC', 'NOTES'
    ])
    const unknownSections = Object.entries(sections)
      .filter(([name]) => !knownSections.has(name))
      .map(([name, content]) => ({ name, content }))

    // Determine plugin info
    const pathParts = commandPath.split(' ')
    let pluginName = null
    let pluginVersion = null
    if (pathParts.length >= 2 && pluginVersions[pathParts[1]]) {
      pluginName = pathParts[1]
      pluginVersion = pluginVersions[pathParts[1]]
    }

    // Build subcommands with correct xref paths
    // Filter out excluded subcommands so they don't appear in the parent's list
    const subcommands = (command.commands || [])
      .filter(sub => {
        const subPath = `${commandPath} ${sub.name}`
        return !shouldExcludeCommand(resolvedOverrides, subPath)
      })
      .map(sub => {
        const subPath = `${commandPath} ${sub.name}`
        const dashifiedSubPath = dashify(subPath)

        // Determine xref path based on directory structure
        let xrefPath
        if (flatOutput) {
          xrefPath = `reference:rpk/${dashifiedSubPath}.adoc`
        } else {
          // For structured output, figure out the correct path
          const subParts = subPath.split(' ')
          const subTopLevel = subParts.length >= 2 ? subParts[1] : null
          if (subTopLevel && topLevelWithSubcommands.has(subTopLevel)) {
            xrefPath = `reference:rpk/rpk-${subTopLevel}/${dashifiedSubPath}.adoc`
          } else {
            xrefPath = `reference:rpk/${dashifiedSubPath}.adoc`
          }
        }

        // Use overridden description if available
        const subOverride = resolvedOverrides?.commands?.[subPath]
        const subDescription = subOverride?.description || sub.description || ''

        return {
          ...sub,
          fullPath: subPath,
          dashifiedPath: dashifiedSubPath,
          xrefPath,
          shortDesc: ensurePeriod(capToTwoSentences(formatDescription(subDescription, textTransformations, { skipTableConversion: true, skipListConversion: true })))
        }
      })

    // Determine platform-specific info
    // Only show platform info if the tree was actually merged from multiple platforms
    const platforms = command.platforms || []
    const platformsMerged = tree.platforms_merged || []
    const hasPlatformData = platformsMerged.length >= 2 // Only meaningful if we have data from 2+ platforms
    const isLinuxOnly = hasPlatformData && platforms.length === 1 && platforms.includes('linux')
    const isDarwinOnly = hasPlatformData && platforms.length === 1 && platforms.includes('darwin')
    const pagePlatforms = isLinuxOnly ? 'linux' : isDarwinOnly ? 'darwin' : null

    // Content is now processed via processedContent from the unified content array
    // customSectionsByPosition comes from processedContent.sections

    // Build template context
    const context = {
      commandPath,
      dashifiedPath: dashify(commandPath),
      name: command.name,
      description: formattedDescription,
      shortDesc: ensurePeriod(capToTwoSentences(formatDescription(mainDescription, textTransformations, { skipTableConversion: true, skipListConversion: true }))),
      usage: formatUsage(command.usage),
      aliases: (mergedCommand.aliases || command.aliases || [])
        .filter(alias => !commandOverride.excludeAliases?.includes(alias))
        .map(alias => {
          // Prepend parent command path to alias
          // e.g., "rpk cluster partitions list" with alias "ls" → "rpk cluster partitions ls"
          const parentPath = commandPath.split(' ').slice(0, -1).join(' ')
          return `${parentPath} ${alias}`
        }),
      aliasNotes: commandOverride.aliasNotes,
      flags: (mergedCommand.flags || []).map(flag => ({
        ...flag,
        name: flag.shorthand ? `-${flag.shorthand}, --${flag.name}` : `--${flag.name}`,
        type: flag.type || '-',
        description: ensurePeriod(formatDescription(flag.description || '', textTransformations)),
        deprecated: flag.deprecated,
        deprecatedMessage: flag.deprecatedMessage,
        cloudOnly: flag.cloudOnly,
        selfHostedOnly: flag.selfHostedOnly,
        validValues: flag.validValues,
        introducedInVersion: flag.introducedInVersion
      })),
      // Global flags come from root tree, not individual commands
      // Keep raw name/shorthand - template handles formatting
      globalFlags: (tree.global_flags || []).map(flag => ({
        ...flag,
        type: flag.type || '-',
        description: ensurePeriod(formatDescription(flag.description || '', textTransformations))
      })),
      subcommands,
      hasSubcommands: subcommands.length > 0,
      sections,
      rpkVersion,
      pluginName,
      pluginVersion,
      introducedInVersion: mergedCommand.introducedInVersion,
      platforms: mergedCommand.platforms || platforms,
      pagePlatforms: mergedCommand.platforms ? mergedCommand.platforms.join(',') : pagePlatforms,
      // Custom page attributes (e.g., page-topic-type, learning-objective-*)
      pageAttributes: commandOverride.pageAttributes || {},
      // Page aliases for backwards compatibility
      pageAliases: commandOverride.pageAliases,
      isLinuxOnly: mergedCommand.platforms
        ? mergedCommand.platforms.length === 1 && mergedCommand.platforms[0] === 'linux'
        : isLinuxOnly,
      isDarwinOnly: mergedCommand.platforms
        ? mergedCommand.platforms.length === 1 && mergedCommand.platforms[0] === 'darwin'
        : isDarwinOnly,
      // Deprecation info
      deprecated: mergedCommand.deprecated,
      deprecatedMessage: mergedCommand.deprecatedMessage,
      deprecatedInVersion: mergedCommand.deprecatedInVersion,
      removedInVersion: mergedCommand.removedInVersion,
      minVersion: mergedCommand.minVersion,
      // Cloud/self-hosted only
      cloudOnly: mergedCommand.cloudOnly,
      selfHostedOnly: mergedCommand.selfHostedOnly,
      // Description scope (for conditional description rendering)
      descriptionScope: mergedCommand.descriptionScope,
      // Prerequisites
      prerequisites: mergedCommand.prerequisites,
      hasPrerequisites: mergedCommand.prerequisites && mergedCommand.prerequisites.length > 0,
      // See also (additional links beyond subcommands) - pass through without transformations
      // (seeAlso items are already properly formatted by writers)
      seeAlso: mergedCommand.seeAlso,
      hasSeeAlso: mergedCommand.seeAlso && mergedCommand.seeAlso.length > 0,
      // Custom sections from unified content array
      customSectionsByPosition: processedContent.sections,
      // Admonitions from unified content array
      admonitions: {
        afterHeader: processedContent.admonitions.after_header,
        afterDescription: processedContent.admonitions.after_description,
        afterUsage: processedContent.admonitions.after_usage,
        afterAliases: processedContent.admonitions.after_aliases,
        afterFlags: processedContent.admonitions.after_flags,
        afterModifiers: processedContent.admonitions.after_modifiers,
        afterExamples: processedContent.admonitions.after_examples,
        beforeSeeAlso: processedContent.admonitions.before_see_also,
        end: processedContent.admonitions.end
      },
      // Cloud-only content from unified content array
      cloudContent: {
        afterHeader: processedContent.cloudContent.after_header,
        afterDescription: processedContent.cloudContent.after_description,
        afterUsage: processedContent.cloudContent.after_usage,
        afterAliases: processedContent.cloudContent.after_aliases,
        afterFlags: processedContent.cloudContent.after_flags,
        afterModifiers: processedContent.cloudContent.after_modifiers,
        afterExamples: processedContent.cloudContent.after_examples,
        beforeSeeAlso: processedContent.cloudContent.before_see_also,
        end: processedContent.cloudContent.end
      },
      // Self-hosted content from unified content array
      selfHostedContent: {
        afterHeader: processedContent.selfHostedContent.after_header,
        afterDescription: processedContent.selfHostedContent.after_description,
        afterUsage: processedContent.selfHostedContent.after_usage,
        afterAliases: processedContent.selfHostedContent.after_aliases,
        afterFlags: processedContent.selfHostedContent.after_flags,
        afterModifiers: processedContent.selfHostedContent.after_modifiers,
        afterExamples: processedContent.selfHostedContent.after_examples,
        beforeSeeAlso: processedContent.selfHostedContent.before_see_also,
        end: processedContent.selfHostedContent.end
      },
      // Includes from unified content array
      includes: {
        afterHeader: processedContent.includes.after_header,
        afterDescription: processedContent.includes.after_description,
        afterUsage: processedContent.includes.after_usage,
        afterAliases: processedContent.includes.after_aliases,
        afterFlags: processedContent.includes.after_flags,
        afterModifiers: processedContent.includes.after_modifiers,
        afterExamples: processedContent.includes.after_examples,
        beforeSeeAlso: processedContent.includes.before_see_also,
        end: processedContent.includes.end
      },
      // Unknown sections from rpk source not explicitly handled by template
      unknownSections,
      hasUnknownSections: unknownSections.length > 0
    }

    // Render template
    const content = template(context)

    // Determine output path
    // Check if this command should go to cloudSecretDir
    const isCloudCommand = commandPath.startsWith('rpk cloud')
    const isSecuritySecretCommand = commandPath.startsWith('rpk security secret')
    const useCloudSecretDir = cloudSecretDir && (isCloudCommand || isSecuritySecretCommand)
    const effectiveOutputDir = useCloudSecretDir ? cloudSecretDir : outputDir

    let filePath
    if (flatOutput) {
      // Legacy flat output: all files in one directory
      const fileName = `${dashify(commandPath)}.adoc`
      filePath = path.join(effectiveOutputDir, fileName)
    } else {
      // Structured output: subdirectories for commands with subcommands
      const { subdir, fileName } = getOutputPath(commandPath, topLevelWithSubcommands)

      if (subdir) {
        const subdirPath = path.join(effectiveOutputDir, subdir)
        // Track full path to handle multiple output directories
        if (!createdSubdirs.has(subdirPath)) {
          fs.mkdirSync(subdirPath, { recursive: true })
          createdSubdirs.add(subdirPath)
        }
        filePath = path.join(subdirPath, fileName)
      } else {
        filePath = path.join(effectiveOutputDir, fileName)
      }
    }

    try {
      fs.writeFileSync(filePath, content, 'utf8')
      writtenFiles.add(filePath)
      filesGenerated++

      if (filesGenerated % 50 === 0) {
        console.log(`  Generated ${filesGenerated} files...`)
      }
    } catch (err) {
      console.error(`ERROR: Failed to write "${filePath}": ${err.message}`)
      filesFailed++
    }
  }

  // Delete stale .adoc files — commands that are now excluded or removed from the CLI.
  // We only scan subdirectories that we actually wrote to; the root output dirs are
  // skipped because they may contain hand-written .adoc files alongside generated ones.
  const managedDirs = new Set()
  for (const f of writtenFiles) {
    const dir = path.dirname(f)
    if (dir !== outputDir && (!cloudSecretDir || dir !== cloudSecretDir)) {
      managedDirs.add(dir)
    }
  }
  for (const dir of managedDirs) {
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.adoc')) continue
      const full = path.join(dir, entry.name)
      if (!writtenFiles.has(full)) {
        try {
          fs.unlinkSync(full)
          filesDeleted++
        } catch (err) {
          console.warn(`Warning: Failed to delete stale file "${full}": ${err.message}`)
        }
      }
    }
  }

  return {
    commandCount: commands.length,
    filesGenerated,
    filesSkipped,
    filesFailed,
    filesDeleted,
    subdirectoriesCreated: createdSubdirs.size
  }
}

module.exports = {
  generateRpkDocs,
  mergeCommandOverrides,
  applyOverridesToTree,
  resolveReferences,
  deepMerge,
  formatDescription,
  convertNumberedListsToAsciiDoc,
  convertIndentedTablesToAsciiDoc,
  convertIndentedCodeBlocksToAsciiDoc,
  decodeHtmlEntities,
  parseDescriptionSections,
  ensurePeriod,
  dashify,
  capToTwoSentences,
  flattenCommands,
  getOutputPath,
  findTopLevelWithSubcommands,
  loadTemplate,
  registerPartial,
  shouldExcludeCommand,
  getCommandMetadata,
  processContentArray,
  // Exported for testing
  filterExamples,
  formatExamples
}
