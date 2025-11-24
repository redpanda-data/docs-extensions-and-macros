/**
 * MCP Tools - OpenAPI Bundle Generation
 */

const { spawnSync } = require('child_process');
const { findRepoRoot, MAX_EXEC_BUFFER_SIZE, normalizeVersion, DEFAULT_COMMAND_TIMEOUT } = require('./utils');
const { getAntoraStructure } = require('./antora');

/**
 * Generate bundled OpenAPI documentation
 * @param {Object} args - Arguments
 * @param {string} args.tag - Branch or tag to clone (e.g., "v24.3.2", "24.3.2", or "dev")
 * @param {string} [args.repo] - Repository URL
 * @param {string} [args.surface] - Which API surface(s) to bundle: 'admin', 'connect', or 'both'
 * @param {string} [args.out_admin] - Output path for admin API
 * @param {string} [args.out_connect] - Output path for connect API
 * @param {string} [args.admin_major] - Admin API major version
 * @param {boolean} [args.use_admin_major_version] - Use admin major version for info.version
 * @param {boolean} [args.quiet] - Suppress logs
 * @returns {Object} Generation results
 */
function generateBundleOpenApi(args) {
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
      suggestion: 'Provide a tag like "v24.3.2", "24.3.2", or "dev"'
    };
  }

  try {
    // Normalize version
    let tag = args.tag;
    if (tag !== 'dev' && !tag.startsWith('v')) {
      tag = `v${tag}`;
    }

    // Build command arguments array (no shell interpolation)
    const cmdArgs = ['doc-tools', 'generate', 'bundle-openapi'];

    // Add flags only when present, each as separate array entries
    cmdArgs.push('--tag');
    cmdArgs.push(tag);

    if (args.repo) {
      cmdArgs.push('--repo');
      cmdArgs.push(args.repo);
    }

    if (args.surface) {
      cmdArgs.push('--surface');
      cmdArgs.push(args.surface);
    }

    if (args.out_admin) {
      cmdArgs.push('--out-admin');
      cmdArgs.push(args.out_admin);
    }

    if (args.out_connect) {
      cmdArgs.push('--out-connect');
      cmdArgs.push(args.out_connect);
    }

    if (args.admin_major) {
      cmdArgs.push('--admin-major');
      cmdArgs.push(args.admin_major);
    }

    if (args.use_admin_major_version) {
      cmdArgs.push('--use-admin-major-version');
    }

    if (args.quiet) {
      cmdArgs.push('--quiet');
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

    // Determine which files were generated based on surface
    const filesGenerated = [];
    const surface = args.surface || 'both';

    if (surface === 'admin' || surface === 'both') {
      filesGenerated.push(args.out_admin || 'admin/redpanda-admin-api.yaml');
    }

    if (surface === 'connect' || surface === 'both') {
      filesGenerated.push(args.out_connect || 'connect/redpanda-connect-api.yaml');
    }

    return {
      success: true,
      tag,
      surface,
      files_generated: filesGenerated,
      output: output.trim(),
      summary: `Bundled OpenAPI documentation for ${surface} API(s) at ${tag}`
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
      suggestion: 'Check that the tag exists in the Redpanda repository'
    };
  }
}

module.exports = {
  generateBundleOpenApi
};
