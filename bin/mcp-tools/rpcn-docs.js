/**
 * MCP Tools - Redpanda Connect Documentation Generation
 */

const { execSync } = require('child_process');
const { findRepoRoot, MAX_EXEC_BUFFER_SIZE, DEFAULT_COMMAND_TIMEOUT } = require('./utils');
const { getAntoraStructure } = require('./antora');

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
    // Build command with optional flags
    const flags = [];
    if (args.fetch_connectors) flags.push('--fetch-connectors');
    if (args.draft_missing) flags.push('--draft-missing');
    if (args.update_whats_new) flags.push('--update-whats-new');
    if (args.include_bloblang) flags.push('--include-bloblang');
    if (args.data_dir) flags.push(`--data-dir "${args.data_dir}"`);
    if (args.old_data) flags.push(`--old-data "${args.old_data}"`);
    if (args.csv) flags.push(`--csv "${args.csv}"`);
    if (args.overrides) flags.push(`--overrides "${args.overrides}"`);

    const cmd = `npx doc-tools generate rpcn-connector-docs ${flags.join(' ')}`;

    const output = execSync(cmd, {
      cwd: repoRoot.root,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: MAX_EXEC_BUFFER_SIZE,
      timeout: DEFAULT_COMMAND_TIMEOUT
    });

    const connectorsMatch = output.match(/(\d+) connectors/i);

    return {
      success: true,
      connectors_documented: connectorsMatch ? parseInt(connectorsMatch[1]) : null,
      files_generated: ['modules/reference/pages/redpanda-connect/components/'],
      output: output.trim(),
      summary: 'Generated Redpanda Connect connector documentation'
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
