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
 * Serialize an Error object to a plain object
 * Prevents circular reference errors when JSON.stringify'ing results
 * @param {Error} error - The error to serialize
 * @returns {Object|string|null} Plain object with error properties, string, or null
 */
function serializeError(error) {
  if (!error) return null;

  // If it's already a string, return as-is
  if (typeof error === 'string') return error;

  // If it's not an Error object, try to convert to string
  if (!(error instanceof Error)) {
    return String(error);
  }

  // Serialize Error object - use try-catch in case any property access fails
  try {
    const serialized = {
      name: error.name || 'Error',
      message: error.message || String(error)
    };

    // Safely add stack if available
    if (error.stack) {
      serialized.stack = String(error.stack);
    }

    // Include any additional properties (like stdout, stderr from exec errors)
    // Use hasOwnProperty to avoid accessing inherited properties that might cause issues
    for (const key of ['stdout', 'stderr', 'code', 'status']) {
      if (Object.prototype.hasOwnProperty.call(error, key) && error[key] != null) {
        // Convert to string to ensure serializability
        serialized[key] = String(error[key]);
      }
    }

    return serialized;
  } catch (err) {
    // If serialization fails for any reason, return a safe fallback
    return {
      name: 'Error',
      message: 'Error object could not be fully serialized',
      originalError: String(error)
    };
  }
}

/**
 * Deep serialize a result object, converting any Error objects to plain objects
 * Handles circular references by tracking visited objects
 * @param {*} obj - The object to serialize
 * @param {WeakSet} [visited] - Set of visited objects (for circular reference detection)
 * @returns {*} Object with all errors serialized
 */
function serializeResult(obj, visited = new WeakSet()) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  // Check for circular references
  if (visited.has(obj)) {
    return '[Circular]';
  }

  // Handle Error objects first
  if (obj instanceof Error) {
    return serializeError(obj);
  }

  // Add to visited set
  visited.add(obj);

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => serializeResult(item, visited));
  }

  // Handle plain objects
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value instanceof Error) {
      result[key] = serializeError(value);
    } else if (value && typeof value === 'object') {
      result[key] = serializeResult(value, visited);
    } else {
      result[key] = value;
    }
  }

  return result;
}

module.exports = {
  MAX_RECURSION_DEPTH,
  MAX_EXEC_BUFFER_SIZE,
  DEFAULT_COMMAND_TIMEOUT,
  DEFAULT_SKIP_DIRS,
  PLAYBOOK_NAMES,
  findRepoRoot,
  getDocToolsCommand,
  executeCommand,
  normalizeVersion,
  formatDate,
  serializeError,
  serializeResult
};
