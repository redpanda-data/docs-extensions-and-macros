/**
 * MCP Tools - Version Information
 *
 * OPTIMIZATION: This tool calls CLI and caches results.
 * - Caches version info for 5 minutes (rarely changes)
 * - No model recommendation (CLI tool)
 * - Recommended model: haiku (if LLM processing needed)
 */

const { spawnSync } = require('child_process');
const { findRepoRoot, getDocToolsCommand } = require('./utils');
const cache = require('./cache');

/**
 * Get the latest Redpanda version information
 * @param {Object} args - Arguments
 * @param {boolean} [args.beta] - Whether to get beta/RC version
 * @returns {Object} Version information
 */
function getRedpandaVersion(args = {}) {
  // Check cache first (5 minute TTL)
  const cacheKey = `redpanda-version:${args.beta ? 'beta' : 'stable'}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return { ...cached, _cached: true };
  }

  try {
    // Get doc-tools command (handles both local and installed)
    const repoRoot = findRepoRoot();
    const docTools = getDocToolsCommand(repoRoot);

    // Build command arguments array
    const baseArgs = ['get-redpanda-version'];
    if (args.beta) {
      baseArgs.push('--beta');
    }

    const cmdResult = spawnSync(docTools.program, docTools.getArgs(baseArgs), {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30000
    });

    // Check for errors
    if (cmdResult.error) {
      throw new Error(`Failed to execute command: ${cmdResult.error.message}`);
    }

    if (cmdResult.status !== 0) {
      const errorMsg = cmdResult.stderr || `Command failed with exit code ${cmdResult.status}`;
      throw new Error(errorMsg);
    }

    const output = cmdResult.stdout;

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

    const result = {
      success: true,
      version,
      docker_tag: `docker.redpanda.com/redpandadata/${dockerRepo}:${version}`,
      is_beta: args.beta || false,
      notes_url: `https://github.com/redpanda-data/redpanda/releases/tag/${version}`,
      _modelRecommendation: 'haiku'
    };

    // Cache for 5 minutes
    cache.set(cacheKey, result, 5 * 60 * 1000);

    return result;
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
  // Check cache first (5 minute TTL)
  const cacheKey = 'console-version';
  const cached = cache.get(cacheKey);
  if (cached) {
    return { ...cached, _cached: true };
  }

  try {
    // Get doc-tools command (handles both local and installed)
    const repoRoot = findRepoRoot();
    const docTools = getDocToolsCommand(repoRoot);

    const cmdResult = spawnSync(docTools.program, docTools.getArgs(['get-console-version']), {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30000
    });

    // Check for errors
    if (cmdResult.error) {
      throw new Error(`Failed to execute command: ${cmdResult.error.message}`);
    }

    if (cmdResult.status !== 0) {
      const errorMsg = cmdResult.stderr || `Command failed with exit code ${cmdResult.status}`;
      throw new Error(errorMsg);
    }

    const output = cmdResult.stdout;

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

    const result = {
      success: true,
      version,
      docker_tag: `docker.redpanda.com/redpandadata/${dockerRepo}:${version}`,
      notes_url: `https://github.com/redpanda-data/console/releases/tag/${version}`,
      _modelRecommendation: 'haiku'
    };

    // Cache for 5 minutes
    cache.set(cacheKey, result, 5 * 60 * 1000);

    return result;
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
