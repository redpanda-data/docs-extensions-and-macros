/**
 * MCP Tools - Metrics Documentation Generation
 */

const { spawnSync } = require('child_process');
const { findRepoRoot, getDocToolsCommand, MAX_EXEC_BUFFER_SIZE, DEFAULT_COMMAND_TIMEOUT } = require('./utils');
const { getAntoraStructure } = require('./antora');
const { createJob } = require('./job-queue');

/**
 * Generate Redpanda metrics documentation
 *
 * Use tags for released content (GA or beta), branches for in-progress content.
 * Defaults to branch "dev" if neither tag nor branch is provided.
 *
 * @param {Object} args - Arguments
 * @param {string} [args.tag] - Git tag for released content (e.g., "v25.3.1")
 * @param {string} [args.branch] - Branch name for in-progress content (e.g., "dev", "main")
 * @param {boolean} [args.background] - Run as background job
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

  // Validate version string to prevent command injection
  const versionRegex = /^[0-9A-Za-z._\/-]+$/;
  if (!versionRegex.test(version)) {
    return {
      success: false,
      error: 'Invalid version format',
      suggestion: 'Version must contain only alphanumeric characters, dots, underscores, slashes, and hyphens (e.g., "v25.3.1", "v25.3.1-rc1", "dev", "main")'
    };
  }

  // Get doc-tools command (handles both local and installed)
  const docTools = getDocToolsCommand(repoRoot);

  // Build command arguments
  const baseArgs = ['generate', 'metrics-docs'];

  if (args.tag) {
    baseArgs.push('--tag');
    baseArgs.push(version);
  } else {
    baseArgs.push('--branch');
    baseArgs.push(version);
  }

  // If background mode, create job and return immediately
  if (args.background) {
    const cmdArgs = [docTools.program, ...docTools.getArgs(baseArgs)];
    const jobId = createJob('generate_metrics_docs', cmdArgs, {
      cwd: repoRoot.root
    });

    return {
      success: true,
      background: true,
      job_id: jobId,
      message: `Metrics docs generation started in background. Use get_job_status with job_id: ${jobId} to check progress.`,
      [refType]: version
    };
  }

  // Otherwise run synchronously
  try {
    const result = spawnSync(docTools.program, docTools.getArgs(baseArgs), {
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
