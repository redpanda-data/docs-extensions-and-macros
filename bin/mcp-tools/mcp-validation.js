/**
 * MCP Configuration Validation
 *
 * Validates MCP server configuration.
 * Note: Prompts and most resources have been migrated to docs-team-standards plugin.
 * This now only validates the personas resource and tools configuration.
 */

const fs = require('fs');
const path = require('path');

/**
 * Resources that are loaded dynamically (from current working directory)
 */
const DYNAMIC_RESOURCES = ['redpanda://personas'];

/**
 * Validate resources configuration
 * @param {Array} resources - Resource definitions
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateResources(resources) {
  const errors = [];
  const warnings = [];

  for (const resource of resources) {
    // All remaining resources should be dynamic (loaded from cwd)
    if (!DYNAMIC_RESOURCES.includes(resource.uri)) {
      warnings.push(`Unexpected resource: ${resource.uri} - static resources should be in docs-team-standards plugin`);
      continue;
    }

    // Validate metadata for dynamic resources
    if (!resource.name || resource.name.length < 3) {
      warnings.push(`Resource ${resource.uri} has a very short name`);
    }
    if (!resource.description || resource.description.length < 10) {
      warnings.push(`Resource ${resource.uri} has a very short description`);
    }
  }

  return { errors, warnings };
}

/**
 * Validate tools configuration
 * @param {Array} tools - Tool definitions
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateTools(tools) {
  const errors = [];
  const warnings = [];

  for (const tool of tools) {
    if (!tool.name) {
      errors.push('Tool missing name');
      continue;
    }

    if (!tool.description || tool.description.length < 10) {
      warnings.push(`Tool "${tool.name}" has a very short description`);
    }

    if (!tool.inputSchema) {
      warnings.push(`Tool "${tool.name}" missing inputSchema`);
    }
  }

  // Check for duplicate names
  const toolNames = new Set();
  for (const tool of tools) {
    if (tool.name && toolNames.has(tool.name)) {
      errors.push(`Duplicate tool name: ${tool.name}`);
    }
    toolNames.add(tool.name);
  }

  return { errors, warnings };
}

/**
 * Validate entire MCP configuration
 * @param {Object} config - Configuration object
 * @param {Array} config.resources - Resources
 * @param {Array} config.tools - Tools
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateMcpConfiguration(config) {
  const allErrors = [];
  const allWarnings = [];

  // Validate resources
  if (config.resources) {
    const resourceValidation = validateResources(config.resources);
    allErrors.push(...resourceValidation.errors);
    allWarnings.push(...resourceValidation.warnings);
  }

  // Validate tools
  if (config.tools) {
    const toolValidation = validateTools(config.tools);
    allErrors.push(...toolValidation.errors);
    allWarnings.push(...toolValidation.warnings);
  }

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings
  };
}

/**
 * Format validation results for display
 * @param {{ valid: boolean, errors: string[], warnings: string[] }} results
 * @param {Object} config - Configuration object
 * @returns {string} Formatted output
 */
function formatValidationResults(results, config) {
  const lines = [];

  lines.push('MCP Configuration Validation');
  lines.push('='.repeat(60));
  lines.push('');

  // Summary
  lines.push(`Tools found: ${config.tools?.length || 0}`);
  lines.push(`Resources found: ${config.resources?.length || 0}`);
  lines.push('');

  // Warnings
  if (results.warnings.length > 0) {
    lines.push('Warnings:');
    results.warnings.forEach(w => lines.push(`  ⚠ ${w}`));
    lines.push('');
  }

  // Errors
  if (results.errors.length > 0) {
    lines.push('Errors:');
    results.errors.forEach(e => lines.push(`  ✗ ${e}`));
    lines.push('');
  }

  // Result
  if (results.valid) {
    lines.push('✓ Validation passed');
  } else {
    lines.push('✗ Validation failed');
    lines.push(`  ${results.errors.length} errors must be fixed`);
  }

  return lines.join('\n');
}

module.exports = {
  validateResources,
  validateTools,
  validateMcpConfiguration,
  formatValidationResults
};
