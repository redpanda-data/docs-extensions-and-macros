/**
 * MCP Tools - Redpanda Connect Documentation Generation
 *
 * OPTIMIZATION: This tool calls CLI, doesn't use LLM directly.
 * - Caches connector metadata when possible
 * - Use --data-dir to avoid re-fetching
 * - Consider incremental generation for updates
 * - No model recommendation (CLI tool)
 */

const { execSync, spawnSync } = require('child_process');
const { findRepoRoot, MAX_EXEC_BUFFER_SIZE, DEFAULT_COMMAND_TIMEOUT } = require('./utils');
const { getAntoraStructure } = require('./antora');
const cache = require('./cache');
const fs = require('fs');
const path = require('path');

/**
 * Generate Redpanda Connect connector documentation
 * @param {Object} args - Arguments
 * @returns {Object} Generation results
 */
function generateRpConnectDocs(args = {}) {
  const repoRoot = findRepoRoot();
  const structure = getAntoraStructure(repoRoot);

  if (!structure.hasDocTools) {
    return {
      success: false,
      error: 'doc-tools not found in this repository',
      suggestion: 'Navigate to the docs-extensions-and-macros repository'
    };
  }

  try {
    // Build command arguments array (no shell interpolation)
    const cmdArgs = ['doc-tools', 'generate', 'rpcn-connector-docs'];

    // Add flags only when present, each as separate array entries
    if (args.fetch_connectors) cmdArgs.push('--fetch-connectors');
    if (args.draft_missing) cmdArgs.push('--draft-missing');
    if (args.update_whats_new) cmdArgs.push('--update-whats-new');
    if (args.include_bloblang) cmdArgs.push('--include-bloblang');
    if (args.skip_cloud_detection) cmdArgs.push('--skip-cloud-detection');
    if (args.skip_binary_analysis) cmdArgs.push('--skip-binary-analysis');
    if (args.skip_cloud_analysis) cmdArgs.push('--skip-cloud-analysis');
    if (args.skip_cgo_analysis) cmdArgs.push('--skip-cgo-analysis');
    if (args.data_dir) {
      cmdArgs.push('--data-dir');
      cmdArgs.push(args.data_dir);
    }
    if (args.old_data) {
      cmdArgs.push('--old-data');
      cmdArgs.push(args.old_data);
    }
    if (args.csv) {
      cmdArgs.push('--csv');
      cmdArgs.push(args.csv);
    }

    // Default to using overrides.json from docs-data if it exists
    let overridesPath = args.overrides;
    if (!overridesPath) {
      // Try to find docs-data/overrides.json in current directory
      const defaultOverrides = path.join(process.cwd(), 'docs-data', 'overrides.json');
      if (fs.existsSync(defaultOverrides)) {
        overridesPath = defaultOverrides;
      }
    }

    if (overridesPath) {
      cmdArgs.push('--overrides');
      cmdArgs.push(overridesPath);
    }
    if (args.cloud_version) {
      cmdArgs.push('--cloud-version');
      cmdArgs.push(args.cloud_version);
    }
    if (args.cgo_version) {
      cmdArgs.push('--cgo-version');
      cmdArgs.push(args.cgo_version);
    }

    const result = spawnSync('npx', cmdArgs, {
      cwd: repoRoot.root,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: MAX_EXEC_BUFFER_SIZE,
      timeout: DEFAULT_COMMAND_TIMEOUT
    });

    // Check for spawn errors
    if (result.error) {
      const err = new Error(`Failed to execute command: ${result.error.message}`);
      err.stdout = result.stdout || '';
      err.stderr = result.stderr || '';
      err.status = result.status;
      throw err;
    }

    // Check for non-zero exit codes
    if (result.status !== 0) {
      const errorMsg = result.stderr || `Command failed with exit code ${result.status}`;
      const err = new Error(errorMsg);
      err.stdout = result.stdout || '';
      err.stderr = result.stderr || '';
      err.status = result.status;
      throw err;
    }

    const output = result.stdout;

    const connectorsMatch = output.match(/(\d+) connectors/i);

    return {
      success: true,
      connectors_documented: connectorsMatch ? parseInt(connectorsMatch[1]) : null,
      files_generated: ['modules/reference/pages/redpanda-connect/components/'],
      output: output.trim(),
      summary: 'Generated Redpanda Connect connector documentation',
      // Cost optimization metadata
      _optimizationNotes: 'This tool calls CLI. To reduce costs: 1) Cache connector data with --data-dir, 2) Use incremental generation when possible, 3) Avoid --fetch-connectors unless needed'
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
      suggestion: 'Check that you have network access to fetch connector data if using --fetch-connectors'
    };
  }
}

module.exports = {
  generateRpConnectDocs
};
