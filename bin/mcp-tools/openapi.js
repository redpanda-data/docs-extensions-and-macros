/**
 * MCP Tools - OpenAPI Bundle Generation
 */

const { execSync } = require('child_process');
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

    // Build command
    const flags = [];
    flags.push(`--tag ${tag}`);

    if (args.repo) {
      flags.push(`--repo "${args.repo}"`);
    }

    if (args.surface) {
      flags.push(`--surface ${args.surface}`);
    }

    if (args.out_admin) {
      flags.push(`--out-admin "${args.out_admin}"`);
    }

    if (args.out_connect) {
      flags.push(`--out-connect "${args.out_connect}"`);
    }

    if (args.admin_major) {
      flags.push(`--admin-major "${args.admin_major}"`);
    }

    if (args.use_admin_major_version) {
      flags.push('--use-admin-major-version');
    }

    if (args.quiet) {
      flags.push('--quiet');
    }

    const cmd = `npx doc-tools generate bundle-openapi ${flags.join(' ')}`;

    const output = execSync(cmd, {
      cwd: repoRoot.root,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: MAX_EXEC_BUFFER_SIZE,
      timeout: DEFAULT_COMMAND_TIMEOUT
    });

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
