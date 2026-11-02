/**
 * MCP Tools - Preview one embedded doc string as it will publish
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
 * Render one doc-string declaration to its published snippet
 * @param {Object} args - Arguments
 * @param {string} args.repo - Path to the engineering checkout (required)
 * @param {string} args.surface - properties|rpk|metrics|helm|crd|connect (required)
 * @param {string} args.name - Declaration name (required)
 * @param {string} [args.overrides] - Overrides JSON path (properties only)
 * @returns {Object} Preview text
 */
function previewDocString(args = {}) {
  for (const required of ['repo', 'surface', 'name']) {
    if (!args[required]) {
      return {
        success: false,
        error: `${required} is required`,
        suggestion: 'Pass repo (engineering checkout path), surface (properties|rpk|metrics|helm|crd|connect), and name (the declaration to preview)'
      };
    }
  }

  const cliArgs = [DOC_TOOLS_BIN, 'preview-string', '--repo', args.repo, '--surface', args.surface, '--name', args.name];
  if (args.overrides) cliArgs.push('--overrides', args.overrides);

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

    return {
      success: true,
      preview: result.stdout,
      masked_by_override: result.stdout.includes('MASKED-BY-OVERRIDE')
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      suggestion: 'Check the repo path and declaration name. For rpk flags, prefix the name with -- (for example --format).'
    };
  }
}

module.exports = {
  previewDocString
};
