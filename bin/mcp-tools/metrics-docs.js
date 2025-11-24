/**
 * MCP Tools - Metrics Documentation Generation
 */

const { execSync } = require('child_process');
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

    const cmd = `npx doc-tools generate metrics-docs --tag ${version}`;

    const output = execSync(cmd, {
      cwd: repoRoot.root,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: MAX_EXEC_BUFFER_SIZE,
      timeout: DEFAULT_COMMAND_TIMEOUT
    });

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
