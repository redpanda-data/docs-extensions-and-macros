/**
 * MCP Tools - Cloud Regions Table Generation
 */

const { spawnSync } = require('child_process');
const { findRepoRoot, getDocToolsCommand, MAX_EXEC_BUFFER_SIZE, DEFAULT_COMMAND_TIMEOUT } = require('./utils');
const { getAntoraStructure } = require('./antora');

/**
 * Generate cloud regions table documentation
 * @param {Object} args - Arguments
 * @param {string} [args.output] - Output file path (relative to repo root)
 * @param {string} [args.format] - Output format: 'md' or 'adoc'
 * @param {string} [args.owner] - GitHub repository owner
 * @param {string} [args.repo] - GitHub repository name
 * @param {string} [args.path] - Path to YAML file in repository
 * @param {string} [args.ref] - Git reference (branch, tag, or commit SHA)
 * @param {string} [args.template] - Path to custom Handlebars template
 * @param {boolean} [args.dry_run] - Print output to stdout instead of writing file
 * @returns {Object} Generation results
 */
function generateCloudRegions(args = {}) {
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
    // Get doc-tools command (handles both local and installed)
    const docTools = getDocToolsCommand(repoRoot);

    // Build command arguments array
    const baseArgs = ['generate', 'cloud-regions'];

    if (args.output) {
      baseArgs.push('--output');
      baseArgs.push(args.output);
    }

    if (args.format) {
      baseArgs.push('--format');
      baseArgs.push(args.format);
    }

    if (args.owner) {
      baseArgs.push('--owner');
      baseArgs.push(args.owner);
    }

    if (args.repo) {
      baseArgs.push('--repo');
      baseArgs.push(args.repo);
    }

    if (args.path) {
      baseArgs.push('--path');
      baseArgs.push(args.path);
    }

    if (args.ref) {
      baseArgs.push('--ref');
      baseArgs.push(args.ref);
    }

    if (args.template) {
      baseArgs.push('--template');
      baseArgs.push(args.template);
    }

    if (args.dry_run) {
      baseArgs.push('--dry-run');
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

    const output = result.stdout;

    // Parse output to extract information
    const regionCountMatch = output.match(/(\d+) regions?/i);

    return {
      success: true,
      format: args.format || 'md',
      ref: args.ref || 'integration',
      regions_documented: regionCountMatch ? parseInt(regionCountMatch[1]) : null,
      files_generated: args.dry_run ? [] : [args.output || 'cloud-controlplane/x-topics/cloud-regions.md'],
      output: output.trim(),
      summary: `Generated cloud regions table from GitHub YAML`
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
      suggestion: 'Check that you have access to the GitHub repository and the YAML file exists'
    };
  }
}

module.exports = {
  generateCloudRegions
};
