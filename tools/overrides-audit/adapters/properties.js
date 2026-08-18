/**
 * Overrides Audit - Properties Adapter
 *
 * Reads docs-data/property-overrides.json and an extracted-properties JSON
 * (the property extractor's raw --output, WITHOUT overrides applied) and
 * classifies every override field. This is the complete reference adapter;
 * rpk and connect adapters follow the same shape.
 */

'use strict'

const fs = require('fs')
const classify = require('../classify')
const { compareProperties } = require('../../property-extractor/compare-properties')

/**
 * Load and parse a JSON file with a helpful error message.
 *
 * @param {string} filePath - Path to the JSON file.
 * @param {string} label - Human label for error messages.
 * @returns {Object} Parsed JSON.
 */
function loadJson (filePath, label) {
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    throw new Error(`Cannot read ${label} file at ${filePath}: ${err.message}`)
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid JSON in ${label} file ${filePath}: ${err.message}`)
  }
}

/**
 * Cross-check the audit with compare-properties.js: overlay the override
 * descriptions onto a copy of the extracted properties and diff the two.
 * Every description the raw diff reports as unchanged must have classified
 * REDUNDANT (the audit's normalization only widens equality, never narrows
 * it), so a violation indicates a classifier bug.
 *
 * @param {Object} extractedDoc - Extracted properties document.
 * @param {Object} overrides - Override entries map.
 * @param {Object[]} manifest - Classified manifest rows.
 * @returns {Object} { changedDescriptions, emptyDescriptions, violations }.
 */
function crossCheckWithCompare (extractedDoc, overrides, manifest) {
  const extractedProps = (extractedDoc && extractedDoc.properties) || {}
  const overlaidProps = {}
  for (const [name, prop] of Object.entries(extractedProps)) {
    const override = overrides[name]
    overlaidProps[name] = override && typeof override.description === 'string'
      ? { ...prop, description: override.description }
      : prop
  }

  const report = compareProperties(
    { properties: extractedProps },
    { properties: overlaidProps },
    'source',
    'source+overrides'
  )

  // Normalization-only differences legitimately appear "changed" in the raw
  // diff while classifying REDUNDANT. The inverse can never happen: a
  // raw-equal description that did not classify REDUNDANT is a classifier bug.
  const changedNames = new Set(report.changedDescriptions.map((entry) => entry.name))
  const violations = manifest.filter(
    (row) =>
      row.field === 'description' &&
      row.class !== classify.CLASSES.REDUNDANT &&
      overrides[row.name] &&
      typeof overrides[row.name].description === 'string' &&
      extractedProps[row.name] &&
      !changedNames.has(row.name)
  )

  return {
    changedDescriptions: report.changedDescriptions.length,
    emptyDescriptions: report.emptyDescriptions.length,
    violations: violations.map((row) => row.name)
  }
}

/**
 * Run the audit for the properties surface.
 *
 * @param {Object} args - { overridesPath, extractedPath, attrAllowlist }.
 * @returns {Object} { surface, manifest, summary, cross_check }.
 */
function audit ({ overridesPath, extractedPath, attrAllowlist }) {
  const overridesDoc = loadJson(overridesPath, 'overrides')
  const extractedDoc = loadJson(extractedPath, 'extracted properties')

  if (!overridesDoc.properties || typeof overridesDoc.properties !== 'object') {
    throw new Error(`Overrides file ${overridesPath} has no top-level "properties" object`)
  }
  if (!extractedDoc.properties || typeof extractedDoc.properties !== 'object') {
    throw new Error(`Extracted file ${extractedPath} has no top-level "properties" object; pass the property extractor's JSON output`)
  }

  const { manifest, summary } = classify.classifyProperties(overridesDoc, extractedDoc, { attrAllowlist })
  const crossCheck = crossCheckWithCompare(extractedDoc, overridesDoc.properties, manifest)

  return {
    surface: 'properties',
    overrides_file: overridesPath,
    extracted_file: extractedPath,
    manifest,
    summary,
    cross_check: crossCheck
  }
}

module.exports = { audit, loadJson }
