/**
 * MCP Tools - Property Documentation Generation
 */

const { execSync } = require('child_process');
const { findRepoRoot, MAX_EXEC_BUFFER_SIZE, DEFAULT_COMMAND_TIMEOUT } = require('./utils');
const { getAntoraStructure } = require('./antora');
const { createJob } = require('./job-queue');

/**
 * Generate Redpanda property documentation
 * @param {Object} args - Arguments
 * @param {string} args.version - Redpanda version/tag (e.g., "v25.3.1", "25.3.1", or "latest")
 * @param {boolean} [args.generate_partials] - Whether to generate AsciiDoc partials
 * @param {boolean} [args.background] - Run as background job
 * @returns {Object} Generation results
 */
function generatePropertyDocs(args) {
  const repoRoot = findRepoRoot();
  const structure = getAntoraStructure(repoRoot);

  if (!structure.hasDocTools) {
    return {
      success: false,
      error: 'doc-tools not found in this repository',
      suggestion: 'Navigate to the docs-extensions-and-macros repository'
    };
  }

  if (!args.version) {
    return {
      success: false,
      error: 'Version is required',
      suggestion: 'Provide a version like "25.3.1", "v25.3.1", or "latest"'
    };
  }

  // Normalize version (add 'v' prefix if not present and not "latest")
  let version = args.version;
  if (version !== 'latest' && !version.startsWith('v')) {
    version = `v${version}`;
  }

  // Build command
  const cmdArgs = ['npx', 'doc-tools', 'generate', 'property-docs', '--tag', version];
  if (args.generate_partials) {
    cmdArgs.push('--generate-partials');
  }

  // If background mode, create job and return immediately
  if (args.background) {
    const jobId = createJob('generate_property_docs', cmdArgs, {
      cwd: repoRoot.root
    });

    return {
      success: true,
      background: true,
      job_id: jobId,
      message: `Property docs generation started in background. Use get_job_status with job_id: ${jobId} to check progress.`,
      version
    };
  }

  // Otherwise run synchronously
  try {
    const output = execSync(cmdArgs.join(' '), {
      cwd: repoRoot.root,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: MAX_EXEC_BUFFER_SIZE,
      timeout: DEFAULT_COMMAND_TIMEOUT
    });

    // Parse output to extract useful information
    const propertyCountMatch = output.match(/(\d+) properties/i);
    const filesGenerated = [];

    if (args.generate_partials) {
      filesGenerated.push('modules/reference/partials/cluster-properties.adoc');
      filesGenerated.push('modules/reference/partials/broker-properties.adoc');
      filesGenerated.push('modules/reference/partials/tunable-properties.adoc');
      filesGenerated.push('modules/reference/partials/topic-properties.adoc');
    }
    filesGenerated.push('modules/reference/partials/properties.json');

    return {
      success: true,
      version,
      files_generated: filesGenerated,
      property_count: propertyCountMatch ? parseInt(propertyCountMatch[1]) : null,
      output: output.trim(),
      summary: `Generated property documentation for Redpanda ${version}`
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
      suggestion: 'Check that the version exists in the Redpanda repository'
    };
  }
}

module.exports = {
  generatePropertyDocs
};
