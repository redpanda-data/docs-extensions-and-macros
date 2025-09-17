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
 */

const fs = require('fs');
const path = require('path');

/**
 * Deep comparison of two values, handling arrays and objects
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
 * Format a value for display in the comparison report
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
    return value.length > 50 ? `"${value.substring(0, 50)}..."` : `"${value}"`;
  }
  return String(value);
}

/**
 * Extract all properties from a JSON structure, handling the actual structure
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
 * Compare two property sets and generate a detailed report
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
    removedProperties: []
  };
  
  // Find new properties
  for (const [name, prop] of Object.entries(newProps)) {
    if (!oldProps.hasOwnProperty(name)) {
      report.newProperties.push({
        name,
        type: prop.type,
        default: prop.default,
        description: prop.description ? prop.description.substring(0, 100) + '...' : 'No description'
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
          oldDescription: oldProp.description ? oldProp.description.substring(0, 50) + '...' : 'No description',
          newDescription: newProp.description ? newProp.description.substring(0, 50) + '...' : 'No description'
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
      // Property was removed
      report.removedProperties.push({
        name,
        type: oldProp.type,
        description: oldProp.description ? oldProp.description.substring(0, 100) + '...' : 'No description'
      });
    }
  }
  
  return report;
}

/**
 * Generate a formatted report for console output
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
  
  console.log('\n' + '='.repeat(60));
}

/**
 * Generate a JSON report for programmatic use
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
      removedProperties: report.removedProperties.length
    },
    details: report
  };
  
  fs.writeFileSync(outputPath, JSON.stringify(jsonReport, null, 2));
  console.log(`📄 Detailed JSON report saved to: ${outputPath}`);
}

/**
 * Main comparison function
 */
function comparePropertyFiles(oldFilePath, newFilePath, oldVersion, newVersion, outputDir, filename = 'property-changes.json') {
  try {
    console.log(`📊 Comparing property files:`);
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
    console.error(`❌ Error comparing properties: ${error.message}`);
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
