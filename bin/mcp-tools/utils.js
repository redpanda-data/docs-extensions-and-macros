/**
 * MCP Tools - Shared Utilities
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
 * Execute a shell command and return output
 * @param {string} command - Command to execute
 * @param {Object} options - Execution options
 * @returns {string} Command output
 */
function executeCommand(command, options = {}) {
  const defaultOptions = {
    encoding: 'utf8',
    maxBuffer: MAX_EXEC_BUFFER_SIZE,
    timeout: DEFAULT_COMMAND_TIMEOUT,
    stdio: ['pipe', 'pipe', 'inherit']
  };

  return execSync(command, { ...defaultOptions, ...options });
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
