'use strict'

const Ajv = require('ajv')
const fs = require('fs')
const path = require('path')

const SCHEMA = 'metric-overrides.schema.json'

/**
 * Check a metric overrides file against its schema: the copy next to the
 * file (a docs repo's docs-data/), else this package's docs-data/ copy.
 *
 * @param {string} file - Path to metric-overrides.json.
 * @returns {string[]} One line per problem; empty when the file is valid.
 */
function validateMetricOverrides (file) {
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return [`cannot read it: ${err.message}`]
  }
  const sibling = path.join(path.dirname(file), SCHEMA)
  const schemaFile = fs.existsSync(sibling) ? sibling : path.join(__dirname, '..', '..', 'docs-data', SCHEMA)
  const validate = new Ajv({ allErrors: true }).compile(JSON.parse(fs.readFileSync(schemaFile, 'utf8')))
  if (validate(data)) return []
  return validate.errors.map((error) => `${error.instancePath || '/'} ${error.message}`)
}

module.exports = { validateMetricOverrides }
