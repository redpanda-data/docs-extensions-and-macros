/**
 * MCP Tools - Metrics Documentation Generation
 */

const { execSync, spawnSync } = require('child_process');
const { findRepoRoot, MAX_EXEC_BUFFER_SIZE, DEFAULT_COMMAND_TIMEOUT } = require('./utils');
const { getAntoraStructure } = require('./antora');

/**
 * Generate Redpanda metrics documentation
 *
 * Use tags for released content (GA or beta), branches for in-progress content.
 * Defaults to branch "dev" if neither tag nor branch is provided.
 *
 * @param {Object} args - Arguments
 * @param {string} [args.tag] - Git tag for released content (e.g., "v25.3.1")
 * @param {string} [args.branch] - Branch name for in-progress content (e.g., "dev", "main")
 * @returns {Object} Generation results
 */
function generateMetricsDocs(args) {
  const repoRoot = findRepoRoot();
  const structure = getAntoraStructure(repoRoot);

  if (!structure.hasDocTools) {
    return {
      success: false,
      error: 'doc-tools not found in this repository',
      suggestion: 'Navigate to the docs-extensions-and-macros repository'
    };
  }

  // Validate that tag and branch are mutually exclusive
  if (args.tag && args.branch) {
    return {
      success: false,
      error: 'Cannot specify both tag and branch',
      suggestion: 'Use either --tag or --branch, not both'
    };
  }

  // Default to 'dev' branch if neither provided
  const gitRef = args.tag || args.branch || 'dev';
  const refType = args.tag ? 'tag' : 'branch';

  // Normalize version (add 'v' prefix if tag and not present)
  let version = gitRef;
  if (args.tag && !version.startsWith('v')) {
    version = `v${version}`;
  }

  try {
    // Validate version string to prevent command injection
    const versionRegex = /^[0-9A-Za-z._\/-]+$/;
    if (!versionRegex.test(version)) {
      return {
        success: false,
        error: 'Invalid version format',
        suggestion: 'Version must contain only alphanumeric characters, dots, underscores, slashes, and hyphens (e.g., "v25.3.1", "v25.3.1-rc1", "dev", "main")'
      };
    }

    // Build command arguments
    const cmdArgs = ['doc-tools', 'generate', 'metrics-docs'];

    if (args.tag) {
      cmdArgs.push('--tag');
      cmdArgs.push(version);
    } else {
      cmdArgs.push('--branch');
      cmdArgs.push(version);
    }

    // Use safe command execution with argument array
    const result = spawnSync('npx', cmdArgs, {
      cwd: repoRoot.root,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: MAX_EXEC_BUFFER_SIZE,
      timeout: DEFAULT_COMMAND_TIMEOUT
    });

    // Check for spawn errors
    if (result.error) {
      throw new Error(`Failed to execute command: ${result.error.message}`);
    }

    // Check for non-zero exit codes
    if (result.status !== 0) {
      const errorMsg = result.stderr || `Command failed with exit code ${result.status}`;
      throw new Error(errorMsg);
    }

    const output = result.stdout;

    const metricsCountMatch = output.match(/(\d+) metrics/i);

    return {
      success: true,
      [refType]: version,
      files_generated: [
        'modules/reference/pages/public-metrics-reference.adoc'
      ],
      metrics_count: metricsCountMatch ? parseInt(metricsCountMatch[1]) : null,
      output: output.trim(),
      summary: `Generated metrics documentation for Redpanda ${refType} ${version}`
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
      suggestion: 'Check that the version exists in the Redpanda repository'
    };
  }
}

module.exports = {
  generateMetricsDocs
};
