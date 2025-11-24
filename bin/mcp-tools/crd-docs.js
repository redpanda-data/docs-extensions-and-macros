/**
 * MCP Tools - Kubernetes CRD Documentation Generation
 */

const { spawnSync } = require('child_process');
const { findRepoRoot, MAX_EXEC_BUFFER_SIZE, normalizeVersion, DEFAULT_COMMAND_TIMEOUT } = require('./utils');
const { getAntoraStructure } = require('./antora');

/**
 * Generate Kubernetes CRD documentation
 * @param {Object} args - Arguments
 * @param {string} args.tag - Operator release tag or branch (e.g., "operator/v25.1.2")
 * @param {string} [args.source_path] - CRD Go types dir or GitHub URL
 * @param {number} [args.depth] - How many levels deep to generate
 * @param {string} [args.templates_dir] - Asciidoctor templates directory
 * @param {string} [args.output] - Where to write the generated AsciiDoc file
 * @returns {Object} Generation results
 */
function generateCrdDocs(args) {
  const repoRoot = findRepoRoot();
  const structure = getAntoraStructure(repoRoot);

  if (!structure.hasDocTools) {
    return {
      success: false,
      error: 'doc-tools not found in this repository',
      suggestion: 'Navigate to the docs-extensions-and-macros repository'
    };
  }

  if (!args.tag) {
    return {
      success: false,
      error: 'Tag is required',
      suggestion: 'Provide an operator tag like "operator/v25.1.2"'
    };
  }

  try {
    // Build command arguments array (no shell interpolation)
    const cmdArgs = ['doc-tools', 'generate', 'crd-spec'];

    // Add flags only when present, each as separate array entries
    cmdArgs.push('--tag');
    cmdArgs.push(args.tag);

    if (args.source_path) {
      cmdArgs.push('--source-path');
      cmdArgs.push(args.source_path);
    }

    if (args.depth) {
      cmdArgs.push('--depth');
      cmdArgs.push(String(args.depth));
    }

    if (args.templates_dir) {
      cmdArgs.push('--templates-dir');
      cmdArgs.push(args.templates_dir);
    }

    if (args.output) {
      cmdArgs.push('--output');
      cmdArgs.push(args.output);
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

    return {
      success: true,
      tag: args.tag,
      files_generated: [args.output || 'modules/reference/pages/k-crd.adoc'],
      output: output.trim(),
      summary: `Generated CRD documentation for operator ${args.tag}`
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
      suggestion: 'Check that the operator tag exists in the repository'
    };
  }
}

module.exports = {
  generateCrdDocs
};
