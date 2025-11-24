/**
 * MCP Tools - Main Exports
 *
 * This module exports all MCP tools in a modular structure.
 */

// Utilities
const { findRepoRoot, executeCommand, normalizeVersion, formatDate } = require('./utils');

// Antora
const { getAntoraStructure } = require('./antora');

// Versions
const { getRedpandaVersion, getConsoleVersion } = require('./versions');

// Documentation generation tools
const { generatePropertyDocs } = require('./property-docs');
const { generateMetricsDocs } = require('./metrics-docs');
const { generateRpkDocs } = require('./rpk-docs');
const { generateRpConnectDocs } = require('./rpcn-docs');
const { generateHelmDocs } = require('./helm-docs');
const { generateCloudRegions } = require('./cloud-regions');
const { generateCrdDocs } = require('./crd-docs');
const { generateBundleOpenApi } = require('./openapi');

// Review tools
const { reviewGeneratedDocs, generateReviewReport } = require('./review');

// Job queue
const { initializeJobQueue, createJob, getJob, listJobs, cleanupOldJobs } = require('./job-queue');

/**
 * Execute a tool and return results
 * @param {string} toolName - Name of the tool to execute
 * @param {Object} args - Arguments for the tool
 * @returns {Object} Tool execution results
 */
function executeTool(toolName, args = {}) {
  const repoRoot = findRepoRoot();

  try {
    switch (toolName) {
      case 'get_antora_structure':
        return getAntoraStructure(repoRoot);

      case 'get_redpanda_version':
        return getRedpandaVersion(args);

      case 'get_console_version':
        return getConsoleVersion();

      case 'generate_property_docs':
        return generatePropertyDocs(args);

      case 'generate_metrics_docs':
        return generateMetricsDocs(args);

      case 'generate_rpk_docs':
        return generateRpkDocs(args);

      case 'generate_rpcn_connector_docs':
        return generateRpConnectDocs(args);

      case 'generate_helm_docs':
        return generateHelmDocs(args);

      case 'generate_cloud_regions':
        return generateCloudRegions(args);

      case 'generate_crd_docs':
        return generateCrdDocs(args);

      case 'generate_bundle_openapi':
        return generateBundleOpenApi(args);

      case 'review_generated_docs':
        return reviewGeneratedDocs(args);

      case 'run_doc_tools_command': {
        // Validate and execute raw doc-tools command
        const validation = validateDocToolsCommand(args.command);
        if (!validation.valid) {
          return {
            success: false,
            error: validation.error
          };
        }

        try {
          const output = executeCommand(`npx doc-tools ${args.command}`, {
            cwd: repoRoot.root
          });

          return {
            success: true,
            output: output.trim(),
            command: `npx doc-tools ${args.command}`
          };
        } catch (err) {
          return {
            success: false,
            error: err.message,
            stdout: err.stdout || '',
            stderr: err.stderr || ''
          };
        }
      }

      default:
        return {
          success: false,
          error: `Unknown tool: ${toolName}`,
          suggestion: 'Check the tool name and try again'
        };
    }
  } catch (err) {
    return {
      success: false,
      error: err.message,
      suggestion: 'An unexpected error occurred while executing the tool'
    };
  }
}

/**
 * Validate doc-tools command to prevent command injection
 * @param {string} command - The command string to validate
 * @returns {{ valid: boolean, error?: string }} Validation result
 */
function validateDocToolsCommand(command) {
  if (!command || typeof command !== 'string') {
    return { valid: false, error: 'Command must be a non-empty string' };
  }

  const dangerousChars = /[;|&$`<>(){}[\]!*?~]/;
  if (dangerousChars.test(command)) {
    return {
      valid: false,
      error: 'Invalid command: shell metacharacters not allowed. Use simple doc-tools commands only.'
    };
  }

  if (command.includes('..') || command.includes('~')) {
    return {
      valid: false,
      error: 'Invalid command: path traversal sequences not allowed'
    };
  }

  return { valid: true };
}

module.exports = {
  // Core functions
  findRepoRoot,
  executeTool,

  // Individual tool exports (for testing or direct use)
  getAntoraStructure,
  getRedpandaVersion,
  getConsoleVersion,
  generatePropertyDocs,
  generateMetricsDocs,
  generateRpkDocs,
  generateRpConnectDocs,
  generateHelmDocs,
  generateCloudRegions,
  generateCrdDocs,
  generateBundleOpenApi,
  reviewGeneratedDocs,
  generateReviewReport,

  // Job queue
  initializeJobQueue,
  createJob,
  getJob,
  listJobs,
  cleanupOldJobs
};
