/**
 * MCP Tools - Metrics Documentation Generation
 */

const { execSync, spawnSync } = require('child_process');
const { findRepoRoot, MAX_EXEC_BUFFER_SIZE, DEFAULT_COMMAND_TIMEOUT } = require('./utils');
const { getAntoraStructure } = require('./antora');

/**
 * Generate Redpanda metrics documentation
 * @param {Object} args - Arguments
 * @param {string} args.version - Redpanda version/tag (e.g., "v25.3.1" or "25.3.1")
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

  if (!args.version) {
    return {
      success: false,
      error: 'Version is required',
      suggestion: 'Provide a version like "25.3.1" or "v25.3.1"'
    };
  }

  try {
    // Normalize version
    let version = args.version;
    if (!version.startsWith('v')) {
      version = `v${version}`;
    }

    // Validate version string to prevent command injection
    const versionRegex = /^v[0-9A-Za-z._-]+$/;
    if (!versionRegex.test(version)) {
      return {
        success: false,
        error: 'Invalid version format',
        suggestion: 'Version must contain only alphanumeric characters, dots, underscores, and hyphens after the "v" prefix (e.g., "v25.3.1", "v25.3.1-rc1")'
      };
    }

    // Use safe command execution with argument array
    const result = spawnSync('npx', ['doc-tools', 'generate', 'metrics-docs', '--tag', version], {
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
      version,
      files_generated: [
        'modules/reference/pages/public-metrics-reference.adoc'
      ],
      metrics_count: metricsCountMatch ? parseInt(metricsCountMatch[1]) : null,
      output: output.trim(),
      summary: `Generated metrics documentation for Redpanda ${version}`
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
