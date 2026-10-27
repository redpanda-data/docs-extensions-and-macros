'use strict'

const Ajv2020 = require('ajv/dist/2020')
const fs = require('fs')
const path = require('path')
const { ValidationResult } = require('../../cli-utils/validation-result')

/**
 * Load and compile the JSON Schema for validation
 * @param {string} [overridesPath] - Path to the overrides file; the schema is
 *   looked up as a sibling (same directory) before falling back to the
 *   package-relative path.
 * @returns {Function} Compiled schema validator
 */
function loadSchemaValidator(overridesPath) {
  // Primary: look for the schema next to the overrides file (docs repo's docs-data/).
  if (overridesPath) {
    const siblingPath = path.join(path.dirname(path.resolve(overridesPath)), 'property-overrides.schema.json')
    if (fs.existsSync(siblingPath)) {
      const schema = JSON.parse(fs.readFileSync(siblingPath, 'utf8'))
      const ajv = new Ajv2020({ allErrors: true, verbose: true })
      return ajv.compile(schema)
    }
  }

  // Fallback: package-relative path (legacy / monorepo usage).
  const schemaPath = path.resolve(__dirname, '../../docs-data/property-overrides.schema.json')

  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema file not found: ${schemaPath}`)
  }

  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
  const ajv = new Ajv2020({ allErrors: true, verbose: true })
  return ajv.compile(schema)
}

/**
 * Validate overrides against the JSON Schema
 * @param {Object} overrides - Overrides object to validate
 * @param {string} [overridesPath] - Path to the overrides file (used to locate the schema)
 * @returns {ValidationResult}
 */
function validateSchema(overrides, overridesPath) {
  const result = new ValidationResult()

  try {
    const validate = loadSchemaValidator(overridesPath)
    const valid = validate(overrides)

    if (!valid) {
      for (const error of validate.errors || []) {
        const instancePath = error.instancePath || '/'
        result.addError(error.message, instancePath)
      }
    }
  } catch (err) {
    result.addError(`Schema validation failed: ${err.message}`)
  }

  return result
}

/**
 * Run all validations on a property-overrides object.
 * @param {Object} overrides - Overrides object to validate
 * @param {string} [overridesPath] - Path to the overrides file (used to locate the schema)
 * @returns {ValidationResult}
 */
function validateOverrides(overrides, overridesPath = null) {
  const result = new ValidationResult()

  if (!overrides || typeof overrides !== 'object') {
    result.addError('Overrides must be a non-null object')
    return result
  }

  result.merge(validateSchema(overrides, overridesPath))

  return result
}

/**
 * Load and validate a property-overrides.json file.
 * @param {string} overridesPath - Path to overrides JSON file
 * @returns {{ overrides: Object|null, validation: ValidationResult }}
 */
function loadAndValidateOverrides(overridesPath) {
  const validation = new ValidationResult()

  if (!overridesPath) {
    return { overrides: null, validation }
  }

  if (!fs.existsSync(overridesPath)) {
    validation.addWarning(`Overrides file not found: ${overridesPath}`)
    return { overrides: null, validation }
  }

  let overrides
  try {
    const content = fs.readFileSync(overridesPath, 'utf8')
    overrides = JSON.parse(content)
  } catch (err) {
    validation.addError(`Failed to parse overrides JSON: ${err.message}`, overridesPath)
    return { overrides: null, validation }
  }

  validation.merge(validateOverrides(overrides, overridesPath))

  return { overrides, validation }
}

module.exports = {
  ValidationResult,
  loadSchemaValidator,
  validateSchema,
  validateOverrides,
  loadAndValidateOverrides,
}
