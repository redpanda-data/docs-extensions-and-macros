/**
 * MCP Configuration Validation
 *
 * Validates prompts, resources, and overall MCP server configuration.
 * Used at startup and by the validate-mcp CLI command.
 */

const fs = require('fs');
const path = require('path');
const { parsePromptFile } = require('./frontmatter');

/**
 * Validate that a prompt name is safe (no path traversal)
 * @param {string} name - Prompt name to validate
 * @throws {Error} If name is invalid
 */
function validatePromptName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Prompt name must be a non-empty string');
  }

  // Only allow alphanumeric, hyphens, and underscores
  if (!/^[a-z0-9_-]+$/i.test(name)) {
    throw new Error(
      `Invalid prompt name: ${name}. Use only letters, numbers, hyphens, and underscores.`
    );
  }

  return name;
}

/**
 * Validate that required arguments are provided
 * @param {string} promptName - Name of the prompt
 * @param {Object} providedArgs - Arguments provided by user
 * @param {Array} schema - Argument schema from prompt metadata
 * @throws {Error} If validation fails
 */
function validatePromptArguments(promptName, providedArgs, schema) {
  if (!schema || schema.length === 0) {
    return; // No validation needed
  }

  const errors = [];

  // Check required arguments
  schema
    .filter(arg => arg.required)
    .forEach(arg => {
      if (!providedArgs || !providedArgs[arg.name]) {
        errors.push(`Missing required argument: ${arg.name}`);
      }
    });

  if (errors.length > 0) {
    throw new Error(
      `Invalid arguments for prompt "${promptName}":\n${errors.join('\n')}`
    );
  }
}

/**
 * Validate all resources are accessible
 * @param {Array} resources - Resource definitions
 * @param {Object} resourceMap - Resource file mappings
 * @param {string} baseDir - Base directory for resources
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateResources(resources, resourceMap, baseDir) {
  const errors = [];
  const warnings = [];

  for (const resource of resources) {
    // Check mapping exists
    const mapping = resourceMap[resource.uri];
    if (!mapping) {
      errors.push(`Resource ${resource.uri} has no file mapping in resourceMap`);
      continue;
    }

    // Check file exists
    const filePath = path.join(baseDir, 'mcp', 'team-standards', mapping.file);
    if (!fs.existsSync(filePath)) {
      errors.push(`Resource file missing: ${mapping.file} for ${resource.uri}`);
      continue;
    }

    // Check file is readable
    try {
      fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      errors.push(`Resource file not readable: ${mapping.file} - ${err.message}`);
      continue;
    }

    // Validate resource metadata
    if (!resource.name || resource.name.length < 3) {
      warnings.push(`Resource ${resource.uri} has a very short name`);
    }

    if (!resource.description || resource.description.length < 10) {
      warnings.push(`Resource ${resource.uri} has a very short description`);
    }

    // Check for versioning
    if (!resource.version) {
      warnings.push(`Resource ${resource.uri} missing version metadata`);
    }

    if (!resource.lastUpdated) {
      warnings.push(`Resource ${resource.uri} missing lastUpdated metadata`);
    }
  }

  return { errors, warnings };
}

/**
 * Validate all prompts are loadable
 * @param {Array} prompts - Discovered prompts
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validatePrompts(prompts) {
  const errors = [];
  const warnings = [];

  for (const prompt of prompts) {
    // Check basic metadata
    if (!prompt.description || prompt.description.length < 10) {
      warnings.push(`Prompt "${prompt.name}" has a very short description`);
    }

    if (!prompt.content || prompt.content.trim().length < 100) {
      warnings.push(`Prompt "${prompt.name}" has very little content (< 100 chars)`);
    }

    // Check for version
    if (!prompt.version) {
      warnings.push(`Prompt "${prompt.name}" missing version metadata`);
    }

    // Validate argument format if specified
    if (prompt.argumentFormat) {
      const validFormats = ['content-append', 'structured'];
      if (!validFormats.includes(prompt.argumentFormat)) {
        errors.push(
          `Prompt "${prompt.name}" has invalid argumentFormat: ${prompt.argumentFormat}`
        );
      }
    }

    // Check for argument schema consistency
    if (prompt.arguments && prompt.arguments.length > 0) {
      if (!prompt.argumentFormat) {
        warnings.push(
          `Prompt "${prompt.name}" has arguments but no argumentFormat specified`
        );
      }

      // Check for duplicate argument names
      const argNames = new Set();
      for (const arg of prompt.arguments) {
        if (argNames.has(arg.name)) {
          errors.push(`Prompt "${prompt.name}" has duplicate argument: ${arg.name}`);
        }
        argNames.add(arg.name);
      }
    }
  }

  return { errors, warnings };
}

/**
 * Validate entire MCP configuration
 * @param {Object} config - Configuration object
 * @param {Array} config.resources - Resources
 * @param {Object} config.resourceMap - Resource mappings
 * @param {Array} config.prompts - Prompts
 * @param {string} config.baseDir - Base directory
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateMcpConfiguration(config) {
  const allErrors = [];
  const allWarnings = [];

  // Validate resources
  const resourceValidation = validateResources(
    config.resources,
    config.resourceMap,
    config.baseDir
  );
  allErrors.push(...resourceValidation.errors);
  allWarnings.push(...resourceValidation.warnings);

  // Validate prompts
  const promptValidation = validatePrompts(config.prompts);
  allErrors.push(...promptValidation.errors);
  allWarnings.push(...promptValidation.warnings);

  // Check for name collisions
  const promptNames = new Set();
  for (const prompt of config.prompts) {
    if (promptNames.has(prompt.name)) {
      allErrors.push(`Duplicate prompt name: ${prompt.name}`);
    }
    promptNames.add(prompt.name);
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
 * @returns {string} Formatted output
 */
function formatValidationResults(results, config) {
  const lines = [];

  lines.push('MCP Configuration Validation');
  lines.push('='.repeat(60));
  lines.push('');

  // Summary
  lines.push(`Prompts found: ${config.prompts.length}`);
  lines.push(`Resources found: ${config.resources.length}`);
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
  validatePromptName,
  validatePromptArguments,
  validateResources,
  validatePrompts,
  validateMcpConfiguration,
  formatValidationResults
};
