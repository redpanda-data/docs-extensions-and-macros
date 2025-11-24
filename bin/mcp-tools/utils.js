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
 * Execute a command safely using spawnSync (no shell)
 * @param {string} program - Program to execute (e.g., 'npx')
 * @param {string[]} args - Array of arguments (e.g., ['doc-tools', 'generate', 'property-docs'])
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

module.exports = {
  MAX_RECURSION_DEPTH,
  MAX_EXEC_BUFFER_SIZE,
  DEFAULT_COMMAND_TIMEOUT,
  DEFAULT_SKIP_DIRS,
  PLAYBOOK_NAMES,
  findRepoRoot,
  executeCommand,
  normalizeVersion,
  formatDate
};
