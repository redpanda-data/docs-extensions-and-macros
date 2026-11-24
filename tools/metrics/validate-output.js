'use strict'

/**
 * Check what `doc-tools generate metrics-docs` wrote against its schemas.
 *
 * The generator is a Python script with no dependencies, so it cannot run a
 * JSON Schema validator. doc-tools runs this after the script finishes: the
 * dataset against docs-data/redpanda-metrics.schema.json and the gaps file
 * against docs-data/metrics-gaps.schema.json. A file that does not match is
 * deleted, so a release run can never commit a dataset the macros and the
 * docs MCP server would misread.
 */

const fs = require('fs')
const path = require('path')
const Ajv = require('ajv')

const SCHEMA_DIR = path.join(__dirname, '..', '..', 'docs-data')
const SCHEMAS = {
  dataset: path.join(SCHEMA_DIR, 'redpanda-metrics.schema.json'),
  gaps: path.join(SCHEMA_DIR, 'metrics-gaps.schema.json')
}
// Enough to see what is wrong without printing one line per metric.
const MAX_ERRORS = 10

/**
 * Validate one JSON file against one schema.
 *
 * @param {string} file - Path to the JSON file.
 * @param {string} schemaFile - Path to its schema.
 * @returns {string[]} Problems, empty when the file matches.
 */
function validateFile (file, schemaFile) {
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return [`cannot be read as JSON: ${err.message}`]
  }
  const validate = new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(fs.readFileSync(schemaFile, 'utf8')))
  if (validate(data)) return []
  const problems = validate.errors.map((error) => `${error.instancePath || '(top level)'} ${error.message}${error.params && error.params.additionalProperty ? ` (${error.params.additionalProperty})` : ''}`)
  const shown = problems.slice(0, MAX_ERRORS)
  if (problems.length > MAX_ERRORS) shown.push(`and ${problems.length - MAX_ERRORS} more`)
  return shown
}

/**
 * Validate the dataset and the gaps file of one run.
 *
 * @param {Object} options
 * @param {string} options.tag - The version the run was for.
 * @param {string} options.outputDir - Where the run wrote its output.
 * @param {string} [options.datasetDir] - Where the dataset went, when not the output directory.
 * @param {boolean} [options.remove=true] - Delete a file that does not match.
 * @returns {{ checked: string[], failures: Array<{ file: string, problems: string[] }> }}
 */
function validateMetricsOutput ({ tag, outputDir, datasetDir, remove = true }) {
  const name = `redpanda-metrics-${tag}.json`
  const targets = [
    // The dataset is in the dataset directory for a release tag and in the output directory otherwise.
    ...[datasetDir, outputDir].filter(Boolean).map((dir) => ({ file: path.join(dir, name), schema: SCHEMAS.dataset })),
    { file: path.join(outputDir, 'metrics-gaps.json'), schema: SCHEMAS.gaps }
  ]
  const checked = []
  const failures = []
  for (const { file, schema } of targets) {
    if (!fs.existsSync(file) || checked.includes(file)) continue
    checked.push(file)
    const problems = validateFile(file, schema)
    if (!problems.length) continue
    failures.push({ file, problems })
    if (remove) fs.rmSync(file, { force: true })
  }
  return { checked, failures }
}

module.exports = { validateFile, validateMetricsOutput, SCHEMAS }
