'use strict'

const Ajv2020 = require('ajv/dist/2020')
const fs = require('fs')
const path = require('path')

/**
 * Valid admonition locations for notes, warnings, tips, cautions, importants
 */
const VALID_ADMONITION_LOCATIONS = [
  'after_header',
  'after_description',
  'after_usage',
  'after_aliases',
  'after_flags',
  'after_examples',
  'before_see_also',
  'end'
]

/**
 * Valid platforms
 */
const VALID_PLATFORMS = ['linux', 'darwin', 'windows']

/**
 * Valid include/preservation locations
 */
const VALID_INCLUDE_LOCATIONS = [
  'after_header',
  'after_description',
  'after_usage',
  'after_aliases',
  'after_flags',
  'after_modifiers',
  'after_examples',
  'before_see_also',
  'end'
]

/**
 * Valid custom section positions
 */
const VALID_SECTION_POSITIONS = [
  'after_description',
  'after_usage',
  'after_flags',
  'after_examples',
  'before_see_also',
  'end'
]

/**
 * Validation result object
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

/**
 * Normalize a command path (trim whitespace, collapse multiple spaces)
 * @param {string} cmdPath - Command path to normalize
 * @returns {string} Normalized command path
 */
function normalizeCommandPath(cmdPath) {
  if (!cmdPath || typeof cmdPath !== 'string') return ''
  return cmdPath.trim().replace(/\s+/g, ' ')
}

/**
 * Load and compile the JSON Schema for validation
 * @returns {Function} Compiled schema validator
 */
function loadSchemaValidator() {
  const schemaPath = path.resolve(__dirname, '../../docs-data/rpk-overrides.schema.json')

  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema file not found: ${schemaPath}`)
  }

  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
  const ajv = new Ajv2020({ allErrors: true, verbose: true })
  return ajv.compile(schema)
}

/**
 * Validate overrides against JSON Schema
 * @param {Object} overrides - Overrides object to validate
 * @returns {ValidationResult}
 */
function validateSchema(overrides) {
  const result = new ValidationResult()

  try {
    const validate = loadSchemaValidator()
    const valid = validate(overrides)

    if (!valid) {
      for (const error of validate.errors || []) {
        const path = error.instancePath || '/'
        const message = `${error.message}`
        result.addError(message, path)
      }
    }
  } catch (err) {
    result.addError(`Schema validation failed: ${err.message}`)
  }

  return result
}

/**
 * Validate command paths in overrides against actual command tree
 * @param {Object} overrides - Overrides object (resolved)
 * @param {Object} commandTree - rpk command tree
 * @returns {ValidationResult}
 */
function validateCommandPaths(overrides, commandTree) {
  const result = new ValidationResult()

  if (!overrides || !overrides.commands) return result
  if (!commandTree) {
    result.addWarning('No command tree provided, skipping command path validation')
    return result
  }

  // Flatten command tree to get all valid paths
  const validPaths = new Set()
  const flattenTree = (node, parentPath = '') => {
    const currentPath = parentPath ? `${parentPath} ${node.name}` : node.name
    validPaths.add(currentPath)
    if (node.commands && Array.isArray(node.commands)) {
      for (const child of node.commands) {
        flattenTree(child, currentPath)
      }
    }
  }
  flattenTree(commandTree)

  // Check each override command path
  for (const cmdPath of Object.keys(overrides.commands)) {
    const normalized = normalizeCommandPath(cmdPath)

    // Check for normalization issues
    if (normalized !== cmdPath) {
      result.addWarning(
        `Command path has irregular whitespace: "${cmdPath}"`,
        `commands["${cmdPath}"]`
      )
    }

    // Check if path exists in tree
    if (!validPaths.has(normalized)) {
      // Find similar paths for suggestion
      const similar = [...validPaths]
        .filter(p => {
          const parts = normalized.split(' ')
          const pParts = p.split(' ')
          return parts.some(part => pParts.includes(part))
        })
        .slice(0, 3)

      let message = `Unknown command path: "${cmdPath}"`
      if (similar.length > 0) {
        message += `\n    Did you mean one of: ${similar.join(', ')}?`
      }
      result.addError(message, `commands["${cmdPath}"]`)
    }
  }

  return result
}

/**
 * Unescape RFC 6901 JSON Pointer encoding
 * @param {string} segment - Path segment to unescape
 * @returns {string} Unescaped segment
 */
function unescapeRfc6901(segment) {
  // RFC 6901: ~1 → /, ~0 → ~ (order matters: ~1 first)
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}

/**
 * Validate $ref and $refs references in overrides
 * @param {Object} overrides - Raw overrides object (before resolution)
 * @returns {ValidationResult}
 */
function validateReferences(overrides) {
  const result = new ValidationResult()

  if (!overrides) return result

  // Track visited refs for cycle detection
  const checkRef = (ref, context, visited = new Set()) => {
    if (!ref || typeof ref !== 'string') {
      result.addError(`Invalid $ref value: ${ref}`, context)
      return
    }

    // Validate ref format
    if (!ref.startsWith('#/')) {
      result.addError(
        `Invalid $ref format: "${ref}" (must start with #/)`,
        context
      )
      return
    }

    // Check for cycles
    if (visited.has(ref)) {
      result.addError(
        `Circular reference detected: "${ref}"`,
        context
      )
      return
    }

    // Resolve the reference with RFC 6901 unescaping
    const refPath = ref.replace(/^#\//, '').split('/').map(unescapeRfc6901)
    let resolved = overrides
    for (const part of refPath) {
      if (resolved && typeof resolved === 'object') {
        resolved = resolved[part]
      } else {
        resolved = undefined
        break
      }
    }

    if (resolved === undefined) {
      result.addError(
        `Cannot resolve $ref: "${ref}" - path does not exist`,
        context
      )
      return
    }

    // Check for nested references (cycle detection)
    const newVisited = new Set(visited)
    newVisited.add(ref)
    checkObjectForRefs(resolved, `${context} -> ${ref}`, newVisited)
  }

  const checkRefs = (refs, context, visited = new Set()) => {
    if (!Array.isArray(refs)) {
      result.addError(`$refs must be an array`, context)
      return
    }
    for (let i = 0; i < refs.length; i++) {
      // Each array item gets a fresh copy of the visited set
      // This allows the same definition to be referenced multiple times
      // without being incorrectly flagged as a cycle
      checkRef(refs[i], `${context}.$refs[${i}]`, new Set(visited))
    }
  }

  // Check object for $ref/$refs with cycle tracking
  const checkObjectForRefs = (obj, context = '', visited = new Set()) => {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => checkObjectForRefs(item, `${context}[${i}]`, visited))
      return
    }

    if (obj.$ref) {
      checkRef(obj.$ref, context, visited)
    }
    if (obj.$refs) {
      checkRefs(obj.$refs, context, visited)
    }

    for (const [key, value] of Object.entries(obj)) {
      if (key !== '$ref' && key !== '$refs') {
        checkObjectForRefs(value, context ? `${context}.${key}` : key, visited)
      }
    }
  }

  checkObjectForRefs(overrides)
  return result
}

/**
 * Validate admonition locations
 * @param {Object} commandOverride - Single command override object
 * @param {string} context - Context for error messages
 * @returns {ValidationResult}
 */
function validateAdmonitionLocations(commandOverride, context) {
  const result = new ValidationResult()

  const admonitionTypes = ['notes', 'warnings', 'tips', 'cautions', 'importants']

  for (const type of admonitionTypes) {
    if (commandOverride[type]) {
      for (const location of Object.keys(commandOverride[type])) {
        if (!VALID_ADMONITION_LOCATIONS.includes(location)) {
          result.addError(
            `Invalid ${type} location: "${location}"`,
            `${context}.${type}.${location}`
          )
          result.addWarning(
            `Valid locations are: ${VALID_ADMONITION_LOCATIONS.join(', ')}`
          )
        }
      }
    }
  }

  return result
}

/**
 * Validate include locations
 * @param {Object} commandOverride - Single command override object
 * @param {string} context - Context for error messages
 * @returns {ValidationResult}
 */
function validateIncludeLocations(commandOverride, context) {
  const result = new ValidationResult()

  if (commandOverride.includes) {
    for (const location of Object.keys(commandOverride.includes)) {
      if (!VALID_INCLUDE_LOCATIONS.includes(location)) {
        result.addError(
          `Invalid include location: "${location}"`,
          `${context}.includes.${location}`
        )
        result.addWarning(
          `Valid locations are: ${VALID_INCLUDE_LOCATIONS.join(', ')}`
        )
      }
    }
  }

  // Check cloudContent and selfHostedContent
  for (const contentType of ['cloudContent', 'selfHostedContent']) {
    if (commandOverride[contentType]) {
      for (const location of Object.keys(commandOverride[contentType])) {
        if (!VALID_INCLUDE_LOCATIONS.includes(location)) {
          result.addError(
            `Invalid ${contentType} location: "${location}"`,
            `${context}.${contentType}.${location}`
          )
        }
      }
    }
  }

  return result
}

/**
 * Validate custom section positions
 * @param {Object} commandOverride - Single command override object
 * @param {string} context - Context for error messages
 * @returns {ValidationResult}
 */
function validateCustomSectionPositions(commandOverride, context) {
  const result = new ValidationResult()

  if (commandOverride.customSections) {
    for (const [name, section] of Object.entries(commandOverride.customSections)) {
      if (section.position && !VALID_SECTION_POSITIONS.includes(section.position)) {
        result.addError(
          `Invalid custom section position: "${section.position}"`,
          `${context}.customSections.${name}.position`
        )
        result.addWarning(
          `Valid positions are: ${VALID_SECTION_POSITIONS.join(', ')}`
        )
      }
    }
  }

  return result
}

/**
 * Validate platform values
 * @param {Object} commandOverride - Single command override object
 * @param {string} context - Context for error messages
 * @returns {ValidationResult}
 */
function validatePlatforms(commandOverride, context) {
  const result = new ValidationResult()

  if (commandOverride.platforms) {
    for (const platform of commandOverride.platforms) {
      if (!VALID_PLATFORMS.includes(platform)) {
        result.addError(
          `Invalid platform: "${platform}"`,
          `${context}.platforms`
        )
        result.addWarning(
          `Valid platforms are: ${VALID_PLATFORMS.join(', ')}`
        )
      }
    }
  }

  return result
}

/**
 * Validate flag overrides
 * @param {Object} commandOverride - Single command override object
 * @param {string} context - Context for error messages
 * @returns {ValidationResult}
 */
function validateFlags(commandOverride, context) {
  const result = new ValidationResult()

  if (commandOverride.flags) {
    for (const [flagName, flagOverride] of Object.entries(commandOverride.flags)) {
      // Validate flag name format
      if (!flagName.match(/^[a-zA-Z][-a-zA-Z0-9]*$/)) {
        result.addWarning(
          `Unusual flag name format: "${flagName}"`,
          `${context}.flags.${flagName}`
        )
      }

      // Validate type if specified
      if (flagOverride.type) {
        const validTypes = ['bool', 'string', 'int', 'int32', 'int64', 'uint', 'uint32',
                           'uint64', 'float', 'float32', 'float64', 'duration',
                           'stringSlice', 'stringArray', 'intSlice', '-']
        if (!validTypes.includes(flagOverride.type)) {
          result.addWarning(
            `Unusual flag type: "${flagOverride.type}" for flag "${flagName}"`,
            `${context}.flags.${flagName}.type`
          )
        }
      }
    }
  }

  return result
}

/**
 * Validate description content (check for common issues)
 * @param {Object} commandOverride - Single command override object
 * @param {string} context - Context for error messages
 * @returns {ValidationResult}
 */
function validateDescriptions(commandOverride, context) {
  const result = new ValidationResult()

  const checkDescription = (desc, descContext) => {
    if (!desc || typeof desc !== 'string') return

    // Check for HTML entities that should have been decoded
    if (desc.match(/&#x[0-9a-fA-F]+;|&#\d+;|&[a-z]+;/)) {
      result.addWarning(
        `Description may contain unescaped HTML entities`,
        descContext
      )
    }

    // Check for common AsciiDoc syntax issues
    if (desc.includes('[') && !desc.includes(']')) {
      result.addWarning(
        `Possible unclosed bracket in description`,
        descContext
      )
    }

    // Check for very long single-line descriptions (might need wrapping)
    if (desc.length > 500 && !desc.includes('\n')) {
      result.addWarning(
        `Very long description (${desc.length} chars) without line breaks`,
        descContext
      )
    }
  }

  if (commandOverride.description) {
    checkDescription(commandOverride.description, `${context}.description`)
  }
  if (commandOverride.appendToDescription) {
    checkDescription(commandOverride.appendToDescription, `${context}.appendToDescription`)
  }

  return result
}

/**
 * Run all validations on an overrides object
 * @param {Object} overrides - Overrides object to validate
 * @param {Object} [commandTree] - Optional command tree for path validation
 * @returns {ValidationResult}
 */
function validateOverrides(overrides, commandTree = null) {
  const result = new ValidationResult()

  if (!overrides || typeof overrides !== 'object') {
    result.addError('Overrides must be a non-null object')
    return result
  }

  // 1. Schema validation
  result.merge(validateSchema(overrides))

  // 2. Reference validation
  result.merge(validateReferences(overrides))

  // 3. Command path validation (if tree provided)
  if (commandTree) {
    result.merge(validateCommandPaths(overrides, commandTree))
  }

  // 4. Per-command validations
  if (overrides.commands) {
    for (const [cmdPath, cmdOverride] of Object.entries(overrides.commands)) {
      const context = `commands["${cmdPath}"]`

      result.merge(validateAdmonitionLocations(cmdOverride, context))
      result.merge(validateIncludeLocations(cmdOverride, context))
      result.merge(validateCustomSectionPositions(cmdOverride, context))
      result.merge(validatePlatforms(cmdOverride, context))
      result.merge(validateFlags(cmdOverride, context))
      result.merge(validateDescriptions(cmdOverride, context))
    }
  }

  return result
}

/**
 * Load and validate overrides file
 * @param {string} overridesPath - Path to overrides JSON file
 * @param {Object} [commandTree] - Optional command tree for path validation
 * @returns {{ overrides: Object|null, validation: ValidationResult }}
 */
function loadAndValidateOverrides(overridesPath, commandTree = null) {
  const validation = new ValidationResult()

  if (!overridesPath) {
    return { overrides: null, validation }
  }

  if (!fs.existsSync(overridesPath)) {
    validation.addWarning(`Overrides file not found: ${overridesPath}`)
    return { overrides: null, validation }
  }

  // Parse JSON
  let overrides
  try {
    const content = fs.readFileSync(overridesPath, 'utf8')
    overrides = JSON.parse(content)
  } catch (err) {
    validation.addError(`Failed to parse overrides JSON: ${err.message}`, overridesPath)
    return { overrides: null, validation }
  }

  // Run validations
  validation.merge(validateOverrides(overrides, commandTree))

  return { overrides, validation }
}

module.exports = {
  ValidationResult,
  normalizeCommandPath,
  loadSchemaValidator,
  validateSchema,
  validateCommandPaths,
  validateReferences,
  validateAdmonitionLocations,
  validateIncludeLocations,
  validateCustomSectionPositions,
  validatePlatforms,
  validateFlags,
  validateDescriptions,
  validateOverrides,
  loadAndValidateOverrides,
  unescapeRfc6901,
  VALID_ADMONITION_LOCATIONS,
  VALID_PLATFORMS,
  VALID_INCLUDE_LOCATIONS,
  VALID_SECTION_POSITIONS
}
