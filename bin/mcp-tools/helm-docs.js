/**
 * MCP Tools - Helm Chart Documentation Generation
 *
 * OPTIMIZATION: This tool calls CLI, doesn't use LLM directly.
 * - No model recommendation (CLI tool)
 * - Cost comes from doc-tools CLI execution
 */

const { spawnSync } = require('child_process');
const { findRepoRoot, getDocToolsCommand, MAX_EXEC_BUFFER_SIZE, DEFAULT_COMMAND_TIMEOUT } = require('./utils');
const { getAntoraStructure } = require('./antora');

/**
 * Generate Helm chart documentation
 *
 * Use tags for released content (GA or beta), branches for in-progress content.
 * When using GitHub URLs, requires either --tag or --branch to be specified.
 * Auto-prepends "operator/" for tags when using redpanda-operator repository.
 *
 * @param {Object} args - Arguments
 * @param {string} [args.chart_dir] - Chart directory, root, or GitHub URL
 * @param {string} [args.tag] - Git tag for released content when using GitHub URL (auto-prepends "operator/" for redpanda-operator repository)
 * @param {string} [args.branch] - Branch name for in-progress content when using GitHub URL
 * @param {string} [args.readme] - Relative README.md path inside each chart dir
 * @param {string} [args.output_dir] - Where to write generated AsciiDoc files
 * @param {string} [args.output_suffix] - Suffix to append to each chart name
 * @returns {Object} Generation results
 */
function generateHelmDocs(args = {}) {
  const repoRoot = findRepoRoot();
  const structure = getAntoraStructure(repoRoot);

  if (!structure.hasDocTools) {
    return {
      success: false,
      error: 'doc-tools not found in this repository',
      suggestion: 'Navigate to the docs-extensions-and-macros repository'
    };
  }

  // Validate that tag and branch are mutually exclusive
  if (args.tag && args.branch) {
    return {
      success: false,
      error: 'Cannot specify both tag and branch',
      suggestion: 'Use either --tag or --branch, not both'
    };
  }

  try {
    // Normalize tag: add 'v' prefix if not present
    let normalizedTag = null;
    if (args.tag) {
      normalizedTag = args.tag;
      if (!normalizedTag.startsWith('v')) {
        normalizedTag = `v${normalizedTag}`;
      }
    }

    // Get doc-tools command (handles both local and installed)
    const docTools = getDocToolsCommand(repoRoot);

    // Build command arguments array
    const baseArgs = ['generate', 'helm-spec'];

    if (args.chart_dir) {
      baseArgs.push('--chart-dir');
      baseArgs.push(args.chart_dir);
    }

    if (normalizedTag) {
      baseArgs.push('--tag');
      baseArgs.push(normalizedTag);
    } else if (args.branch) {
      baseArgs.push('--branch');
      baseArgs.push(args.branch);
    }

    if (args.readme) {
      baseArgs.push('--readme');
      baseArgs.push(args.readme);
    }

    if (args.output_dir) {
      baseArgs.push('--output-dir');
      baseArgs.push(args.output_dir);
    }

    if (args.output_suffix) {
      baseArgs.push('--output-suffix');
      baseArgs.push(args.output_suffix);
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

    // Parse output to extract information
    const chartCountMatch = output.match(/(\d+) charts?/i);

    const refType = normalizedTag ? 'tag' : args.branch ? 'branch' : null;
    const gitRef = normalizedTag || args.branch;

    return {
      success: true,
      ...(refType && { [refType]: gitRef }),
      chart_dir: args.chart_dir || 'default',
      charts_documented: chartCountMatch ? parseInt(chartCountMatch[1]) : null,
      files_generated: [args.output_dir || 'modules/reference/pages'],
      output: output.trim(),
      summary: `Generated Helm chart documentation${gitRef ? ` for ${refType} ${gitRef}` : ''}`
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
      suggestion: 'Check that the chart directory or GitHub URL is valid and accessible'
    };
  }
}

module.exports = {
  generateHelmDocs
};
