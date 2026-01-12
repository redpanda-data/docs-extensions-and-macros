/**
 * MCP Tools - Shared Utilities
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Constants
const MAX_RECURSION_DEPTH = 3;
const MAX_EXEC_BUFFER_SIZE = 50 * 1024 * 1024; // 50MB
const DEFAULT_COMMAND_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const DEFAULT_SKIP_DIRS = ['node_modules', '.git', 'venv', '__pycache__', '.pytest_cache'];
const PLAYBOOK_NAMES = [
  'local-antora-playbook.yml',
  'antora-playbook.yml',
  'docs-playbook.yml'
];

/**
 * Find the repository root from current working directory
 * @param {string} [start=process.cwd()] - Starting directory for search
 * @returns {{ root: string, detected: boolean, type: string|null }} Repository information
 */
function findRepoRoot(start = process.cwd()) {
  let dir = start;
  while (dir !== path.parse(dir).root) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return { root: dir, detected: true, type: 'git' };
    }
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return { root: dir, detected: true, type: 'npm' };
    }
    dir = path.dirname(dir);
  }
  return { root: start, detected: false, type: null };
}

/**
 * Get the doc-tools command and arguments
 * Handles both development mode (source repo) and installed mode (npm package)
 * @param {Object} repoRoot - Repository root information from findRepoRoot()
 * @returns {{ program: string, getArgs: function }} Command configuration
 */
function getDocToolsCommand(repoRoot) {
  // Check if we're in the source repository (development mode)
  const localDocTools = path.join(repoRoot.root, 'bin', 'doc-tools.js');
  if (fs.existsSync(localDocTools)) {
    return {
      program: 'node',
      getArgs: (cmdArgs) => [localDocTools, ...cmdArgs]
    };
  }

  // Otherwise use npx, which will find the installed package in node_modules
  return {
    program: 'npx',
    getArgs: (cmdArgs) => ['doc-tools', ...cmdArgs]
  };
}

/**
 * Execute a command safely using spawnSync (no shell)
 * @param {string} program - Program to execute (for example, 'npx')
 * @param {string[]} args - Array of arguments (for example, ['doc-tools', 'generate', 'property-docs'])
 * @param {Object} options - Execution options
 * @returns {string} Command output (stdout)
 * @throws {Error} Error with stdout, stderr, and status properties on failure
 */
function executeCommand(program, args, options = {}) {
  const defaultOptions = {
    encoding: 'utf8',
    maxBuffer: MAX_EXEC_BUFFER_SIZE,
    timeout: DEFAULT_COMMAND_TIMEOUT,
    stdio: 'pipe'
  };

  const result = spawnSync(program, args, { ...defaultOptions, ...options });

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

  return result.stdout;
}

/**
 * Normalize version string (remove 'v' prefix if present)
 * @param {string} version - Version string
 * @returns {string} Normalized version
 */
function normalizeVersion(version) {
  return version.startsWith('v') ? version.substring(1) : version;
}

/**
 * Format date as YYYY-MM-DD
 * @param {Date} date - Date to format
 * @returns {string} Formatted date string
 */
function formatDate(date = new Date()) {
  return date.toISOString().split('T')[0];
}

/**
 * Repository configuration for multi-repo detection
 * Used for proto comparison and API documentation workflows
 */
const REPO_CONFIG = {
  redpanda: {
    envVar: 'REDPANDA_REPO_PATH',
    siblingNames: ['redpanda'],
    validator: (dir) => {
      try {
        return fs.existsSync(path.join(dir, 'proto', 'redpanda', 'core'));
      } catch {
        return false;
      }
    },
    protoRoot: 'proto',
    repoUrl: 'https://github.com/redpanda-data/redpanda',
    description: 'Redpanda core repository (for Admin and Connect APIs)'
  },

  cloudv2: {
    envVar: 'CLOUDV2_REPO_PATH',
    siblingNames: ['cloudv2', 'cloud-v2', 'cloudv2-infra'],
    validator: (dir) => {
      try {
        return fs.existsSync(path.join(dir, 'proto', 'public', 'cloud')) ||
               fs.existsSync(path.join(dir, 'proto', 'redpanda'));
      } catch {
        return false;
      }
    },
    protoRoot: 'proto',
    repoUrl: 'https://github.com/redpanda-data/cloudv2-infra',
    description: 'Control Plane repository (for Cloud API)'
  },

  'api-docs': {
    envVar: 'API_DOCS_REPO_PATH',
    siblingNames: ['api-docs'],
    validator: (dir) => {
      try {
        // Check for typical api-docs directory structure
        const hasAdmin = fs.existsSync(path.join(dir, 'admin'));
        const hasControlPlane = fs.existsSync(path.join(dir, 'cloud-controlplane'));
        return hasAdmin || hasControlPlane;
      } catch {
        return false;
      }
    },
    repoUrl: 'https://github.com/redpanda-data/api-docs',
    description: 'API documentation repository (OpenAPI specs)'
  }
};

/**
 * Find a repository using multi-strategy auto-detection
 * @param {string} repoKey - Key from REPO_CONFIG (e.g., 'redpanda', 'cloudv2')
 * @param {string} [explicitPath] - Optional explicit path override
 * @param {boolean} [silent=false] - Suppress console output
 * @returns {string} Path to repository
 * @throws {Error} If repository cannot be found
 */
function findRepository(repoKey, explicitPath, silent = false) {
  const config = REPO_CONFIG[repoKey];
  if (!config) {
    throw new Error(`Unknown repository: ${repoKey}. Valid options: ${Object.keys(REPO_CONFIG).join(', ')}`);
  }

  const log = (msg) => {
    if (!silent) console.error(msg);
  };

  // Strategy 1: Explicit path (tool parameter)
  if (explicitPath) {
    if (!config.validator(explicitPath)) {
      throw new Error(
        `Not a valid ${repoKey} repository: ${explicitPath}\n` +
        `${config.description}\n` +
        `Expected to find proto files at the location.`
      );
    }
    log(`Using ${repoKey} from explicit path: ${explicitPath}`);
    return explicitPath;
  }

  // Strategy 2: Environment variable
  if (process.env[config.envVar]) {
    const envPath = process.env[config.envVar];
    if (config.validator(envPath)) {
      log(`Using ${repoKey} from ${config.envVar}: ${envPath}`);
      return envPath;
    }
    log(`Warning: ${config.envVar} set but invalid: ${envPath}`);
  }

  // Get parent directory for sibling/workspace detection
  const repoRoot = findRepoRoot();
  const parent = path.dirname(repoRoot.root);

  // Strategy 3: Sibling directories
  for (const siblingName of config.siblingNames) {
    const candidate = path.join(parent, siblingName);
    if (config.validator(candidate)) {
      log(`Auto-detected ${repoKey} as sibling: ${candidate}`);
      return candidate;
    }
  }

  // Strategy 4: Fail with helpful message
  throw new Error(
    `❌ Could not find ${repoKey} repository.\n\n` +
    `Description: ${config.description}\n\n` +
    `Options:\n` +
    `1. Clone as sibling directory:\n` +
    `   cd ${parent}\n` +
    `   git clone ${config.repoUrl} ${config.siblingNames[0]}\n\n` +
    `2. Set environment variable:\n` +
    `   export ${config.envVar}=/path/to/${repoKey}\n\n` +
    `3. Pass repo path to tool:\n` +
    `   { ${repoKey}_repo_path: "/path/to/repo" }`
  );
}

/**
 * Get all configured repository paths (for tools that need multiple repos)
 * @param {Object} explicitPaths - Object with repo keys and explicit paths
 * @returns {Object} Object mapping repo keys to paths
 */
function findAllRepositories(explicitPaths = {}) {
  const repos = {};
  for (const repoKey of Object.keys(REPO_CONFIG)) {
    try {
      repos[repoKey] = findRepository(repoKey, explicitPaths[repoKey], true);
    } catch (err) {
      // Repository not found - that's ok, not all tools need all repos
      repos[repoKey] = null;
    }
  }
  return repos;
}

/**
 * Get current git branch for a repository
 * @param {string} repoPath - Path to git repository
 * @returns {string} Current branch name
 * @throws {Error} If branch cannot be detected or repo is in detached HEAD state
 */
function getCurrentBranch(repoPath) {
  try {
    const result = executeCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoPath
    });
    const branch = result.trim();

    if (branch === 'HEAD') {
      throw new Error('Repository is in detached HEAD state');
    }

    return branch;
  } catch (err) {
    throw new Error(
      `Could not detect git branch in ${repoPath}: ${err.message}\n` +
      `Please specify source_branch parameter explicitly, or ensure repo is on a valid branch.`
    );
  }
}

/**
 * Validate repository state and warn about uncommitted changes
 * @param {string} repoPath - Path to git repository
 * @returns {Object} Repository state information
 */
function validateRepoState(repoPath) {
  try {
    const status = executeCommand('git', ['status', '--porcelain'], { cwd: repoPath });
    const hasChanges = status.trim().length > 0;

    if (hasChanges) {
      console.error(`⚠️  Warning: ${repoPath} has uncommitted changes`);
      console.error(`   Comparison will use working directory state, not committed state.`);
    }

    return { hasUncommittedChanges: hasChanges };
  } catch (err) {
    console.error(`Warning: Could not check repo state: ${err.message}`);
    return { hasUncommittedChanges: false };
  }
}

module.exports = {
  MAX_RECURSION_DEPTH,
  MAX_EXEC_BUFFER_SIZE,
  DEFAULT_COMMAND_TIMEOUT,
  DEFAULT_SKIP_DIRS,
  PLAYBOOK_NAMES,
  REPO_CONFIG,
  findRepoRoot,
  getDocToolsCommand,
  executeCommand,
  normalizeVersion,
  formatDate,
  findRepository,
  findAllRepositories,
  getCurrentBranch,
  validateRepoState
};
