/**
 * MCP Tools - Kubernetes CRD Documentation Generation
 */

const { execSync } = require('child_process');
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
    // Build command
    const flags = [];
    flags.push(`--tag ${args.tag}`);

    if (args.source_path) {
      flags.push(`--source-path "${args.source_path}"`);
    }

    if (args.depth) {
      flags.push(`--depth ${args.depth}`);
    }

    if (args.templates_dir) {
      flags.push(`--templates-dir "${args.templates_dir}"`);
    }

    if (args.output) {
      flags.push(`--output "${args.output}"`);
    }

    const cmd = `npx doc-tools generate crd-spec ${flags.join(' ')}`;

    const output = execSync(cmd, {
      cwd: repoRoot.root,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: MAX_EXEC_BUFFER_SIZE,
      timeout: DEFAULT_COMMAND_TIMEOUT
    });

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
