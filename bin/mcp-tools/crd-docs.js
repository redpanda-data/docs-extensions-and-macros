/**
 * MCP Tools - Kubernetes CRD Documentation Generation
 *
 * OPTIMIZATION: This tool calls CLI, doesn't use LLM directly.
 * - No model recommendation (CLI tool)
 * - Cost comes from doc-tools CLI execution
 */

const { spawnSync } = require('child_process');
const { findRepoRoot, getDocToolsCommand, MAX_EXEC_BUFFER_SIZE, normalizeVersion, DEFAULT_COMMAND_TIMEOUT } = require('./utils');
const { getAntoraStructure } = require('./antora');

/**
 * Generate Kubernetes CRD documentation
 *
 * Use tags for released content (GA or beta), branches for in-progress content.
 *
 * @param {Object} args - Arguments
 * @param {string} [args.tag] - Operator release tag for GA/beta content (for example, operator/v2.2.6-25.3.1 or v25.1.2). Auto-prepends "operator/" if not present.
 * @param {string} [args.branch] - Branch name for in-progress content (for example, release/v2.2.x, main, dev)
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

  // Validate that either tag or branch is provided (but not both)
  if (!args.tag && !args.branch) {
    return {
      success: false,
      error: 'Either tag or branch is required',
      suggestion: 'Provide --tag "operator/v25.1.2" or --branch "main"'
    };
  }

  if (args.tag && args.branch) {
    return {
      success: false,
      error: 'Cannot specify both tag and branch',
      suggestion: 'Use either --tag or --branch, not both'
    };
  }

  try {
    // Get the appropriate doc-tools command (local or installed)
    const docTools = getDocToolsCommand(repoRoot);

    // Build command arguments array (no shell interpolation)
    const cmdArgs = ['generate', 'crd-spec'];

    // Add tag or branch flag
    if (args.tag) {
      cmdArgs.push('--tag');
      cmdArgs.push(args.tag);
    } else {
      cmdArgs.push('--branch');
      cmdArgs.push(args.branch);
    }

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

    const result = spawnSync(docTools.program, docTools.getArgs(cmdArgs), {
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

    const ref = args.tag || args.branch;
    const refType = args.tag ? 'tag' : 'branch';

    return {
      success: true,
      [refType]: ref,
      files_generated: [args.output || 'modules/reference/pages/k-crd.adoc'],
      output: output.trim(),
      summary: `Generated CRD documentation for operator ${refType} ${ref}`
    };
  } catch (err) {
    // Check if the error is due to --branch not being supported (old doc-tools version)
    const isOldVersionError = err.stderr &&
      err.stderr.includes('required option') &&
      err.stderr.includes('--tag') &&
      args.branch;

    return {
      success: false,
      error: err.message,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
      suggestion: isOldVersionError
        ? 'Your doc-tools version doesn\'t support --branch. Update with: npm install (in docs-extensions-and-macros repo)'
        : 'Check that the operator tag exists in the repository'
    };
  }
}

module.exports = {
  generateCrdDocs
};
