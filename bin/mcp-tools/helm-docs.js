/**
 * MCP Tools - Helm Chart Documentation Generation
 */

const { execSync } = require('child_process');
const { findRepoRoot, MAX_EXEC_BUFFER_SIZE, DEFAULT_COMMAND_TIMEOUT, normalizeVersion } = require('./utils');
const { getAntoraStructure } = require('./antora');

/**
 * Generate Helm chart documentation
 * @param {Object} args - Arguments
 * @param {string} [args.chart_dir] - Chart directory, root, or GitHub URL
 * @param {string} [args.tag] - Branch or tag to clone when using GitHub URL
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

  try {
    // Build command
    const flags = [];

    if (args.chart_dir) {
      flags.push(`--chart-dir "${args.chart_dir}"`);
    }

    if (args.tag) {
      const normalizedTag = normalizeVersion(args.tag);
      flags.push(`--tag ${normalizedTag}`);
    }

    if (args.readme) {
      flags.push(`--readme "${args.readme}"`);
    }

    if (args.output_dir) {
      flags.push(`--output-dir "${args.output_dir}"`);
    }

    if (args.output_suffix) {
      flags.push(`--output-suffix "${args.output_suffix}"`);
    }

    const cmd = `npx doc-tools generate helm-spec ${flags.join(' ')}`;

    const output = execSync(cmd, {
      cwd: repoRoot.root,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: MAX_EXEC_BUFFER_SIZE,
      timeout: DEFAULT_COMMAND_TIMEOUT
    });

    // Parse output to extract information
    const chartCountMatch = output.match(/(\d+) charts?/i);

    return {
      success: true,
      tag: args.tag || 'default',
      chart_dir: args.chart_dir || 'default',
      charts_documented: chartCountMatch ? parseInt(chartCountMatch[1]) : null,
      files_generated: [args.output_dir || 'modules/reference/pages'],
      output: output.trim(),
      summary: `Generated Helm chart documentation`
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
