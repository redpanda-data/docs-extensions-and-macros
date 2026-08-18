/**
 * MCP Tools - Lint embedded doc strings in engineering source
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { MAX_EXEC_BUFFER_SIZE, DEFAULT_COMMAND_TIMEOUT } = require('./utils');

// The CLI ships in this same package, so invoke it directly: this tool is
// designed to run inside ENGINEERING repos (redpanda, redpanda-operator,
// connect), where the docs-repo detection behind getDocToolsCommand does
// not apply.
const DOC_TOOLS_BIN = path.resolve(__dirname, '..', 'doc-tools.js');

/**
 * Lint user-facing doc strings embedded in engineering source code
 * @param {Object} args - Arguments
 * @param {string} args.repo - Path to the engineering checkout (required)
 * @param {string} [args.surface] - Comma-separated surfaces (properties, metrics, rpk, helm, crd, connect)
 * @param {string} [args.diff] - Base ref for declaration-anchored diff mode
 * @param {string} [args.skip_rules] - Comma-separated rule ids to skip
 * @param {string} [args.only_rules] - Comma-separated rule ids to run exclusively
 * @returns {Object} Lint results (findings + summary, JSON)
 */
function lintDocStrings(args = {}) {
  if (!args.repo) {
    return {
      success: false,
      error: 'repo is required',
      suggestion: 'Pass the absolute path of the engineering checkout to lint (for example, a local redpanda clone)'
    };
  }

  const cliArgs = [DOC_TOOLS_BIN, 'lint-strings', '--repo', args.repo, '--format', 'json'];
  if (args.surface) cliArgs.push('--surface', args.surface);
  if (args.diff) cliArgs.push('--diff', args.diff);
  if (args.skip_rules) cliArgs.push('--skip-rules', args.skip_rules);
  if (args.only_rules) cliArgs.push('--only-rules', args.only_rules);

  try {
    const result = spawnSync(process.execPath, cliArgs, {
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: MAX_EXEC_BUFFER_SIZE,
      timeout: DEFAULT_COMMAND_TIMEOUT
    });

    if (result.error) {
      throw new Error(`Failed to execute command: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(result.stderr || `Command failed with exit code ${result.status}`);
    }

    const parsed = JSON.parse(result.stdout);
    return {
      success: true,
      summary: parsed.summary,
      findings: parsed.findings,
      unsupported_surfaces: parsed.unsupported_surfaces || []
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      suggestion: 'Check that the repo path exists. The properties surface additionally needs python3 and network access on first run (venv + tree-sitter grammar); lint a specific --surface to skip it.'
    };
  }
}

module.exports = {
  lintDocStrings
};
