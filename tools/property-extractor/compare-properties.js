#!/usr/bin/env node

/**
 * Property Comparison Tool
 *
 * Compares two property JSON files and generates a detailed report of:
 * - New properties added
 * - Properties with changed defaults
 * - Properties with changed descriptions
 * - Properties with changed types
 * - Deprecated properties
 * - Removed properties
 * - Properties with empty descriptions (excluding deprecated)
 */

const fs = require('fs');
const path = require('path');

/**
 * Recursively compares two values for structural deep equality.
 *
 * - Returns true if values are strictly equal (`===`).
 * - Returns false if types differ or either is `null`/`undefined` while the other is not.
 * - Arrays: ensures same length and recursively compares each element.
 * - Objects: compares own enumerable keys (order-insensitive) and recursively compares corresponding values.
 *
 * @param {*} a - First value to compare.
 * @param {*} b - Second value to compare.
 * @returns {boolean} True if the two values are deeply equal.
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }
  
  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(key => keysB.includes(key) && deepEqual(a[key], b[key]));
  }
  
  return false;
}

/**
 * Format a value for concise human-readable display in comparison reports.
 *
 * Converts various JavaScript values into short string representations used
 * in the report output:
 * - null/undefined → `'null'`
 * - Array:
 *   - empty → `'[]'`
 *   - single item → `[<formatted item>]` (recursively formatted)
 *   - multiple items → `'[<n> items]'`
 * - Object → JSON string via `JSON.stringify`
 * - String → quoted
 * - Other primitives → `String(value)`
 *
 * @param {*} value - The value to format for display.
 * @return {string} A concise string suitable for report output.
 */
function formatValue(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.length === 1) return `[${formatValue(value[0])}]`;
    return `[${value.length} items]`;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return `"${value}"`;
  }
  return String(value);
}

/**
 * Extracts a flat map of property definitions from a parsed JSON schema or similar object.
 *
 * If the input contains a top-level `properties` object, that object is returned directly.
 * Otherwise, the function scans the root keys (excluding `definitions`) and returns any
 * entries that look like property definitions (an object with at least one of `type`,
 * `description`, or `default`).
 *
 * @param {Object} data - Parsed JSON data to scan for property definitions.
 * @returns {Object} A map of property definitions (key → property object). Returns an empty object if none found.
 */
function extractProperties(data) {
  // Properties are nested under a 'properties' key in the JSON structure
  if (data.properties && typeof data.properties === 'object') {
    return data.properties;
  }
  
  // Fallback: look for properties at root level
  const properties = {};
  for (const [key, value] of Object.entries(data)) {
    if (key !== 'definitions' && typeof value === 'object' && value !== null) {
      // Check if this looks like a property definition
      if (value.hasOwnProperty('type') || value.hasOwnProperty('description') || value.hasOwnProperty('default')) {
        properties[key] = value;
      }
    }
  }

  return properties;
}

/**
 * Compare two property JSON structures and produce a detailed change report.
 *
 * Compares properties extracted from oldData and newData and classifies differences
 * into newProperties, changedDefaults, changedDescriptions, changedTypes,
 * deprecatedProperties (newly deprecated in newData), removedProperties, and
 * emptyDescriptions (non-deprecated properties missing descriptions in newData).
 * Default equality is determined by a deep structural comparison.
 *
 * @param {Object} oldData - Parsed JSON of the older property file.
 * @param {Object} newData - Parsed JSON of the newer property file.
 * @param {string} oldVersion - Version string corresponding to oldData.
 * @param {string} newVersion - Version string corresponding to newData.
 * @return {Object} Report object with arrays: newProperties, changedDefaults,
 *   changedDescriptions, changedTypes, deprecatedProperties, removedProperties, emptyDescriptions.
 */
function compareProperties(oldData, newData, oldVersion, newVersion) {
  const oldProps = extractProperties(oldData);
  const newProps = extractProperties(newData);

  const report = {
    newProperties: [],
    changedDefaults: [],
    changedDescriptions: [],
    changedTypes: [],
    deprecatedProperties: [],
    removedProperties: [],
    emptyDescriptions: []
  };
  
  // Find new properties
  for (const [name, prop] of Object.entries(newProps)) {
    if (!oldProps.hasOwnProperty(name)) {
      report.newProperties.push({
        name,
        type: prop.type,
        default: prop.default,
        description: prop.description || 'No description'
      });
    }
  }
  
  // Find changed properties
  for (const [name, oldProp] of Object.entries(oldProps)) {
    if (newProps.hasOwnProperty(name)) {
      const newProp = newProps[name];
      
      // Check for deprecation first (using is_deprecated field only)
      const isNewlyDeprecated = newProp.is_deprecated === true && 
        oldProp.is_deprecated !== true;
      
      if (isNewlyDeprecated) {
        report.deprecatedProperties.push({
          name,
          reason: newProp.deprecatedReason || 'Property marked as deprecated'
        });
        // Skip other change detection for deprecated properties
        continue;
      }
      
      // Only check other changes if property is not newly deprecated
      // Check for default value changes
      if (!deepEqual(oldProp.default, newProp.default)) {
        report.changedDefaults.push({
          name,
          oldDefault: oldProp.default,
          newDefault: newProp.default
        });
      }
      
      // Check for description changes
      if (oldProp.description !== newProp.description) {
        report.changedDescriptions.push({
          name,
          oldDescription: oldProp.description || 'No description',
          newDescription: newProp.description || 'No description'
        });
      }
      
      // Check for type changes
      if (oldProp.type !== newProp.type) {
        report.changedTypes.push({
          name,
          oldType: oldProp.type,
          newType: newProp.type
        });
      }
    } else {
      // Property was removed - skip experimental properties
      // Check both the is_experimental_property field and development_ prefix
      const isExperimental = oldProp.is_experimental_property || name.startsWith('development_');
      if (!isExperimental) {
        report.removedProperties.push({
          name,
          type: oldProp.type,
          description: oldProp.description || 'No description'
        });
      }
    }
  }

  // Find properties with empty descriptions in the new version (excluding deprecated)
  for (const [name, prop] of Object.entries(newProps)) {
    const hasEmptyDescription = !prop.description ||
      (typeof prop.description === 'string' && prop.description.trim().length === 0) ||
      prop.description === 'No description';

    if (hasEmptyDescription && !prop.is_deprecated) {
      report.emptyDescriptions.push({
        name,
        type: prop.type
      });
    }
  }

  return report;
}

/**
 * Print a human-readable console report summarizing property differences between two versions.
 *
 * The report includes sections for new properties, properties with changed defaults,
 * changed types, updated descriptions, newly deprecated properties (with reason), and removed properties.
 *
 * @param {Object} report - Comparison report object returned by compareProperties().
 * @param {string} oldVersion - Label for the old version (displayed as the "from" version).
 * @param {string} newVersion - Label for the new version (displayed as the "to" version).
 */
function generateConsoleReport(report, oldVersion, newVersion) {
  console.log('\n' + '='.repeat(60));
  console.log(`📋 Property Changes Report (${oldVersion} → ${newVersion})`);
  console.log('='.repeat(60));
  
  if (report.newProperties.length > 0) {
    console.log(`\n➤ New properties (${report.newProperties.length}):`);
    report.newProperties.forEach(prop => {
      console.log(`   • ${prop.name} (${prop.type}) — default: ${formatValue(prop.default)}`);
    });
  } else {
    console.log('\n➤ No new properties.');
  }
  
  if (report.changedDefaults.length > 0) {
    console.log(`\n➤ Properties with changed defaults (${report.changedDefaults.length}):`);
    report.changedDefaults.forEach(prop => {
      console.log(`   • ${prop.name}:`);
      console.log(`     - Old: ${formatValue(prop.oldDefault)}`);
      console.log(`     - New: ${formatValue(prop.newDefault)}`);
    });
  } else {
    console.log('\n➤ No default value changes.');
  }
  
  if (report.changedTypes.length > 0) {
    console.log(`\n➤ Properties with changed types (${report.changedTypes.length}):`);
    report.changedTypes.forEach(prop => {
      console.log(`   • ${prop.name}: ${prop.oldType} → ${prop.newType}`);
    });
  }
  
  if (report.changedDescriptions.length > 0) {
    console.log(`\n➤ Properties with updated descriptions (${report.changedDescriptions.length}):`);
    report.changedDescriptions.forEach(prop => {
      console.log(`   • ${prop.name} — description updated`);
    });
  }
  
  if (report.deprecatedProperties.length > 0) {
    console.log(`\n➤ Newly deprecated properties (${report.deprecatedProperties.length}):`);
    report.deprecatedProperties.forEach(prop => {
      console.log(`   • ${prop.name} — ${prop.reason}`);
    });
  }
  
  if (report.removedProperties.length > 0) {
    console.log(`\n➤ Removed properties (${report.removedProperties.length}):`);
    report.removedProperties.forEach(prop => {
      console.log(`   • ${prop.name} (${prop.type})`);
    });
  }

  if (report.emptyDescriptions.length > 0) {
    console.log(`\nWarning: Properties with empty descriptions (${report.emptyDescriptions.length}):`);
    report.emptyDescriptions.forEach(prop => {
      console.log(`   • ${prop.name} (${prop.type})`);
    });
  }

  console.log('\n' + '='.repeat(60));
}

/**
 * Write a structured JSON comparison report to disk.
 *
 * Produces a JSON file containing a comparison header (old/new versions and timestamp),
 * a summary with counts for each change category, and the full details object passed as `report`.
 *
 * @param {Object} report - Comparison details object produced by compareProperties; expected to contain arrays: `newProperties`, `changedDefaults`, `changedDescriptions`, `changedTypes`, `deprecatedProperties`, `removedProperties`, and `emptyDescriptions`.
 * @param {string} oldVersion - The previous version identifier included in the comparison header.
 * @param {string} newVersion - The new version identifier included in the comparison header.
 * @param {string} outputPath - Filesystem path where the JSON report will be written.
 */
function generateJsonReport(report, oldVersion, newVersion, outputPath) {
  const jsonReport = {
    comparison: {
      oldVersion,
      newVersion,
      timestamp: new Date().toISOString()
    },
    summary: {
      newProperties: report.newProperties.length,
      changedDefaults: report.changedDefaults.length,
      changedDescriptions: report.changedDescriptions.length,
      changedTypes: report.changedTypes.length,
      deprecatedProperties: report.deprecatedProperties.length,
      removedProperties: report.removedProperties.length,
      emptyDescriptions: report.emptyDescriptions.length
    },
    details: report
  };
  
  fs.writeFileSync(outputPath, JSON.stringify(jsonReport, null, 2));
  console.log(`📄 Detailed JSON report saved to: ${outputPath}`);
}

/**
 * Compare two property JSON files and produce a change report.
 *
 * Reads and parses the two JSON files at oldFilePath and newFilePath, compares their properties
 * using compareProperties, prints a human-readable console report, and optionally writes a
 * structured JSON report to outputDir/filename.
 *
 * Side effects:
 * - Synchronously reads the two input files.
 * - Writes a JSON report file when outputDir is provided (creates the directory if needed).
 * - Logs progress and results to the console.
 * - On error, logs the error and exits the process with code 1.
 *
 * @param {string} oldFilePath - Path to the old property JSON file.
 * @param {string} newFilePath - Path to the new property JSON file.
 * @param {string} oldVersion - Version label for the old file (used in reports).
 * @param {string} newVersion - Version label for the new file (used in reports).
 * @param {string|undefined} outputDir - Optional directory to write the JSON report; if falsy, no file is written.
 * @param {string} [filename='property-changes.json'] - Name of the JSON report file to write inside outputDir.
 * @returns {Object} The comparison report object produced by compareProperties.
 */
function comparePropertyFiles(oldFilePath, newFilePath, oldVersion, newVersion, outputDir, filename = 'property-changes.json') {
  try {
    console.log(`Comparing property files:`);
    console.log(`   Old: ${oldFilePath}`);
    console.log(`   New: ${newFilePath}`);
    
    const oldData = JSON.parse(fs.readFileSync(oldFilePath, 'utf8'));
    const newData = JSON.parse(fs.readFileSync(newFilePath, 'utf8'));
    
    const report = compareProperties(oldData, newData, oldVersion, newVersion);
    
    // Generate console report
    generateConsoleReport(report, oldVersion, newVersion);
    
    // Generate JSON report if output directory provided
    if (outputDir) {
      fs.mkdirSync(outputDir, { recursive: true });
      const jsonReportPath = path.join(outputDir, filename);
      generateJsonReport(report, oldVersion, newVersion, jsonReportPath);
    }
    
    return report;
  } catch (error) {
    console.error(`Error: Error comparing properties: ${error.message}`);
    process.exit(1);
  }
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length < 4) {
    console.log('Usage: node compare-properties.js <old-file> <new-file> <old-version> <new-version> [output-dir] [filename]');
    console.log('');
    console.log('Example:');
    console.log('  node compare-properties.js gen/v25.1.1-properties.json gen/v25.2.2-properties.json v25.1.1 v25.2.2 modules/reference property-changes-v25.1.1-to-v25.2.2.json');
    process.exit(1);
  }
  
  const [oldFile, newFile, oldVersion, newVersion, outputDir, filename] = args;
  comparePropertyFiles(oldFile, newFile, oldVersion, newVersion, outputDir, filename);
}

module.exports = { comparePropertyFiles, compareProperties };
