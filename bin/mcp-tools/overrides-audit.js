/**
 * MCP Tools - Overrides Audit
 */

const { spawnSync } = require('child_process');
const { findRepoRoot, getDocToolsCommand, MAX_EXEC_BUFFER_SIZE, DEFAULT_COMMAND_TIMEOUT } = require('./utils');

/**
 * Audit docs-side override entries against extracted source strings
 * @param {Object} args - Arguments
 * @param {string} args.overrides - Path to the overrides JSON file (for example "docs-data/property-overrides.json")
 * @param {string} [args.extracted] - Path to the extracted source JSON (property extractor raw output; required for the properties surface)
 * @param {string} [args.repo] - Redpanda checkout to extract raw source strings from (alternative to args.extracted, properties surface only)
 * @param {string} [args.surface] - Override surface: 'properties', 'rpk', or 'connect'
 * @param {string} [args.output] - Also write the JSON result to this file (relative to repo root)
 * @returns {Object} Audit results with manifest and per-class summary
 */
function auditOverrides(args = {}) {
  const repoRoot = findRepoRoot();

  if (!args.overrides) {
    return {
      success: false,
      error: 'Missing required argument: overrides',
      suggestion: 'Pass the path to the overrides JSON file (for example "docs-data/property-overrides.json")'
    };
  }

  try {
    // Get doc-tools command (handles both local and installed)
    const docTools = getDocToolsCommand(repoRoot);

    // Build command arguments array (JSON output so the result is parseable)
    const baseArgs = ['overrides', 'audit', '--overrides', args.overrides, '--format', 'json'];

    if (args.extracted) {
      baseArgs.push('--extracted');
      baseArgs.push(args.extracted);
    }

    if (args.repo) {
      baseArgs.push('--repo');
      baseArgs.push(args.repo);
    }

    if (args.surface) {
      baseArgs.push('--surface');
      baseArgs.push(args.surface);
    }

    if (args.output) {
      baseArgs.push('--output');
      baseArgs.push(args.output);
    }

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

    const audit = JSON.parse(result.stdout);

    return {
      success: true,
      surface: audit.surface,
      summary: audit.summary,
      cross_check: audit.cross_check || null,
      manifest: audit.manifest,
      files_generated: args.output ? [args.output] : [],
      summary_text: `Classified ${audit.summary.total} override field(s) on the ${audit.surface} surface`
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
      suggestion: 'Check that the overrides file exists and that --extracted points to the property extractor\'s raw JSON output (without overrides applied)'
    };
  }
}

module.exports = {
  auditOverrides
};
