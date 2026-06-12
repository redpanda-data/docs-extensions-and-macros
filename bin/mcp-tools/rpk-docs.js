/**
 * MCP Tools - rpk Documentation Generation
 *
 * Generates rpk CLI reference documentation by building from Go source
 * and parsing build tags to detect Linux-only commands.
 *
 * Features:
 * - Builds rpk from source (requires Go)
 * - Detects Linux-only commands from Go build tags
 * - Supports overrides.json for description improvements
 * - Generates diffs between versions for release notes
 * - Publishes versioned JSON for downstream consumers
 *
 * OPTIMIZATION: This tool calls CLI, doesn't use LLM directly.
 * - No model recommendation (CLI tool)
 * - Cost comes from doc-tools CLI execution
 */

const { spawnSync } = require('child_process');
const { findRepoRoot, getDocToolsCommand, MAX_EXEC_BUFFER_SIZE, DEFAULT_COMMAND_TIMEOUT } = require('./utils');
const { getAntoraStructure } = require('./antora');
const { createJob } = require('./job-queue');

/**
 * Generate rpk command documentation from source
 *
 * Clones redpanda source (or uses local checkout) and builds rpk to generate
 * documentation. Parses Go build tags to detect Linux-only commands.
 *
 * @param {Object} args - Arguments
 * @param {string} [args.ref] - Git ref to document (e.g., "dev", "v26.2.0", "main")
 * @param {string} [args.tag] - Git tag (alias for ref, backward compatibility)
 * @param {string} [args.branch] - Git branch (alias for ref, backward compatibility)
 * @param {string} [args.from_source] - Path to local rpk source directory
 * @param {string} [args.overrides] - Path to overrides JSON file (defaults to docs-data/rpk-overrides.json)
 * @param {string} [args.diff] - Generate diff against this previous version
 * @param {boolean} [args.update_whats_new] - Update whats-new.adoc with changes
 * @param {boolean} [args.draft_missing] - Generate draft pages for new commands
 * @param {string} [args.output_dir] - Output directory for generated AsciiDoc
 * @param {string} [args.data_dir] - Directory for versioned JSON and diff files
 * @param {boolean} [args.background] - Run as background job
 * @returns {Object} Generation results
 */
function generateRpkDocs(args) {
  const repoRoot = findRepoRoot();
  const structure = getAntoraStructure(repoRoot);

  if (!structure.hasDocTools) {
    return {
      success: false,
      error: 'doc-tools not found in this repository',
      suggestion: 'Navigate to the docs-extensions-and-macros repository'
    };
  }

  // Determine version from ref, tag, or branch (backward compatibility)
  // Priority: ref > tag > branch > 'dev' (default)
  let version;
  let refType;
  if (args.ref) {
    version = args.ref;
    refType = args.ref.match(/^v?\d/) ? 'tag' : 'branch';
  } else if (args.tag) {
    version = args.tag.startsWith('v') ? args.tag : `v${args.tag}`;
    refType = 'tag';
  } else if (args.branch) {
    version = args.branch;
    refType = 'branch';
  } else {
    // No ref specified - default to 'dev'
    version = 'dev';
    refType = 'branch';
  }

  // Get doc-tools command (handles both local and installed)
  const docTools = getDocToolsCommand(repoRoot);

  // Build command arguments array
  const baseArgs = ['generate', 'rpk-docs'];

  // Always use --ref (defaults to 'dev' if not specified)
  baseArgs.push('--ref', version);

  // Add optional arguments
  if (args.from_source) {
    baseArgs.push('--from-source', args.from_source);
  }

  if (args.overrides) {
    baseArgs.push('--overrides', args.overrides);
  }

  if (args.diff) {
    let diffVersion = args.diff;
    if (!diffVersion.startsWith('v')) {
      diffVersion = `v${diffVersion}`;
    }
    baseArgs.push('--diff', diffVersion);
  }

  if (args.update_whats_new) {
    baseArgs.push('--update-whats-new');
  }

  if (args.draft_missing) {
    baseArgs.push('--draft-missing');
  }

  if (args.output_dir) {
    baseArgs.push('--output-dir', args.output_dir);
  }

  if (args.data_dir) {
    baseArgs.push('--data-dir', args.data_dir);
  }

  // If background mode, create job and return immediately
  if (args.background) {
    const cmdArgs = [docTools.program, ...docTools.getArgs(baseArgs)];
    const jobId = createJob('generate_rpk_docs', cmdArgs, {
      cwd: repoRoot.root
    });

    return {
      success: true,
      background: true,
      job_id: jobId,
      message: `rpk docs generation started in background. Use get_job_status with job_id: ${jobId} to check progress.`,
      ref: version,
      version: version,
      ref_type: refType
    };
  }

  // Otherwise run synchronously
  try {
    const result = spawnSync(docTools.program, docTools.getArgs(baseArgs), {
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
    const commandCountMatch = output.match(/(\d+) commands/i);
    const filesGeneratedMatch = output.match(/Generated (\d+) files/i);

    const response = {
      success: true,
      ref: version,
      version: version,
      ref_type: refType,
      commands_documented: commandCountMatch ? parseInt(commandCountMatch[1]) : null,
      files_generated: filesGeneratedMatch ? parseInt(filesGeneratedMatch[1]) : null,
      output: output.trim()
    };

    // Add diff summary if available
    if (args.diff) {
      response.diff_from = args.diff.startsWith('v') ? args.diff : `v${args.diff}`;
      response.diff_to = version;
    }

    response.summary = `Generated rpk documentation for ${version}`;

    return response;
  } catch (err) {
    const response = {
      success: false,
      error: err.message,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status
    };

    // Provide helpful suggestions based on error
    if (err.message.includes('Go is required')) {
      response.suggestion = 'Install Go from https://go.dev/ and ensure it\'s in your PATH.';
    } else if (err.message.includes('not found') || err.message.includes('ENOENT')) {
      response.suggestion = 'Ensure Go and Git are installed and in your PATH.';
    } else {
      response.suggestion = 'Check that the version/ref exists in the Redpanda repository.';
    }

    return response;
  }
}

module.exports = {
  generateRpkDocs
};
