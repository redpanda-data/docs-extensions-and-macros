/**
 * MCP Tools - Version Information
 */

const { spawnSync } = require('child_process');
const { findRepoRoot, getDocToolsCommand } = require('./utils');

/**
 * Get the latest Redpanda version information
 * @param {Object} args - Arguments
 * @param {boolean} [args.beta] - Whether to get beta/RC version
 * @returns {Object} Version information
 */
function getRedpandaVersion(args = {}) {
  try {
    // Get doc-tools command (handles both local and installed)
    const repoRoot = findRepoRoot();
    const docTools = getDocToolsCommand(repoRoot);

    // Build command arguments array
    const baseArgs = ['get-redpanda-version'];
    if (args.beta) {
      baseArgs.push('--beta');
    }

    const result = spawnSync(docTools.program, docTools.getArgs(baseArgs), {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30000
    });

    // Check for errors
    if (result.error) {
      throw new Error(`Failed to execute command: ${result.error.message}`);
    }

    if (result.status !== 0) {
      const errorMsg = result.stderr || `Command failed with exit code ${result.status}`;
      throw new Error(errorMsg);
    }

    const output = result.stdout;

    // Parse the output (format: REDPANDA_VERSION=vX.Y.Z\nREDPANDA_DOCKER_REPO=redpanda)
    const lines = output.trim().split('\n');
    const versionLine = lines.find(l => l.startsWith('REDPANDA_VERSION='));
    const dockerLine = lines.find(l => l.startsWith('REDPANDA_DOCKER_REPO='));

    if (!versionLine) {
      return {
        success: false,
        error: 'Failed to parse version from output'
      };
    }

    const version = versionLine.split('=')[1];
    const dockerRepo = dockerLine ? dockerLine.split('=')[1] : 'redpanda';

    return {
      success: true,
      version,
      docker_tag: `docker.redpanda.com/redpandadata/${dockerRepo}:${version}`,
      is_beta: args.beta || false,
      notes_url: `https://github.com/redpanda-data/redpanda/releases/tag/${version}`
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      suggestion: 'Make sure you have network access to fetch version information from GitHub'
    };
  }
}

/**
 * Get the latest Redpanda Console version information
 * @returns {Object} Version information
 */
function getConsoleVersion() {
  try {
    // Get doc-tools command (handles both local and installed)
    const repoRoot = findRepoRoot();
    const docTools = getDocToolsCommand(repoRoot);

    const result = spawnSync(docTools.program, docTools.getArgs(['get-console-version']), {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30000
    });

    // Check for errors
    if (result.error) {
      throw new Error(`Failed to execute command: ${result.error.message}`);
    }

    if (result.status !== 0) {
      const errorMsg = result.stderr || `Command failed with exit code ${result.status}`;
      throw new Error(errorMsg);
    }

    const output = result.stdout;

    // Parse the output (format: CONSOLE_VERSION=vX.Y.Z\nCONSOLE_DOCKER_REPO=console)
    const lines = output.trim().split('\n');
    const versionLine = lines.find(l => l.startsWith('CONSOLE_VERSION='));
    const dockerLine = lines.find(l => l.startsWith('CONSOLE_DOCKER_REPO='));

    if (!versionLine) {
      return {
        success: false,
        error: 'Failed to parse version from output'
      };
    }

    const version = versionLine.split('=')[1];
    const dockerRepo = dockerLine ? dockerLine.split('=')[1] : 'console';

    return {
      success: true,
      version,
      docker_tag: `docker.redpanda.com/redpandadata/${dockerRepo}:${version}`,
      notes_url: `https://github.com/redpanda-data/console/releases/tag/${version}`
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      suggestion: 'Make sure you have network access to fetch version information from GitHub'
    };
  }
}

module.exports = {
  getRedpandaVersion,
  getConsoleVersion
};
