/**
 * MCP Tools - Cloud Regions Table Generation
 */

const { execSync } = require('child_process');
const { findRepoRoot, MAX_EXEC_BUFFER_SIZE, DEFAULT_COMMAND_TIMEOUT } = require('./utils');
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
    // Build command
    const flags = [];

    if (args.output) {
      flags.push(`--output "${args.output}"`);
    }

    if (args.format) {
      flags.push(`--format ${args.format}`);
    }

    if (args.owner) {
      flags.push(`--owner ${args.owner}`);
    }

    if (args.repo) {
      flags.push(`--repo ${args.repo}`);
    }

    if (args.path) {
      flags.push(`--path "${args.path}"`);
    }

    if (args.ref) {
      flags.push(`--ref ${args.ref}`);
    }

    if (args.template) {
      flags.push(`--template "${args.template}"`);
    }

    if (args.dry_run) {
      flags.push('--dry-run');
    }

    const cmd = `npx doc-tools generate cloud-regions ${flags.join(' ')}`;

    const output = execSync(cmd, {
      cwd: repoRoot.root,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: MAX_EXEC_BUFFER_SIZE,
      timeout: DEFAULT_COMMAND_TIMEOUT
    });

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
