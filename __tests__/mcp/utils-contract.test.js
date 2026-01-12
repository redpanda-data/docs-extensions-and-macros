/**
 * Contract tests for utils module
 * Tests the public API contracts for utility functions, especially git utilities
 */

const { describe, test, expect } = require('@jest/globals');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const {
  findRepoRoot,
  getCurrentBranch,
  validateRepoState,
  findRepository,
  REPO_CONFIG
} = require('../../bin/mcp-tools/utils');

describe('Utils Module - Contract Tests', () => {
  describe('findRepoRoot', () => {
    test('returns object with required properties', () => {
      const result = findRepoRoot();

      expect(result).toBeDefined();
      expect(result).toHaveProperty('root');
      expect(result).toHaveProperty('detected');
      expect(result).toHaveProperty('type');
      expect(typeof result.root).toBe('string');
      expect(typeof result.detected).toBe('boolean');
    });

    test('detects git repo when in a git directory', () => {
      const result = findRepoRoot();

      // This test repo should be a git repo
      expect(result.detected).toBe(true);
      expect(result.type).toBe('git');
      expect(fs.existsSync(path.join(result.root, '.git'))).toBe(true);
    });

    test('accepts optional start directory parameter', () => {
      const currentDir = process.cwd();
      const result = findRepoRoot(currentDir);

      expect(result).toBeDefined();
      expect(result.root).toBeDefined();
    });
  });

  describe('getCurrentBranch', () => {
    test('returns string for valid git repository', () => {
      const repoRoot = findRepoRoot();
      const result = getCurrentBranch(repoRoot.root);

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      expect(result).not.toBe('HEAD'); // Should not be detached
    });

    test('throws error for detached HEAD state', () => {
      // Create a temporary git repo in detached HEAD state
      const tmpDir = path.join(os.tmpdir(), 'git-detached-test-' + Date.now());
      fs.mkdirSync(tmpDir, { recursive: true });

      try {
        execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git commit --allow-empty -m "initial"', { cwd: tmpDir, stdio: 'pipe' });
        const commitHash = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
        execSync(`git checkout ${commitHash}`, { cwd: tmpDir, stdio: 'pipe' });

        expect(() => {
          getCurrentBranch(tmpDir);
        }).toThrow(/detached HEAD/i);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test('throws error with helpful message for invalid repo', () => {
      const tmpDir = path.join(os.tmpdir(), 'not-a-repo-' + Date.now());
      fs.mkdirSync(tmpDir, { recursive: true });

      try {
        expect(() => {
          getCurrentBranch(tmpDir);
        }).toThrow();

        try {
          getCurrentBranch(tmpDir);
        } catch (err) {
          expect(err.message).toContain('specify source_branch parameter');
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test('error message includes repo path for debugging', () => {
      const invalidPath = '/nonexistent/path';

      try {
        getCurrentBranch(invalidPath);
      } catch (err) {
        expect(err.message).toContain(invalidPath);
      }
    });
  });

  describe('validateRepoState', () => {
    test('returns object with hasUncommittedChanges property', () => {
      const repoRoot = findRepoRoot();
      const result = validateRepoState(repoRoot.root);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('hasUncommittedChanges');
      expect(typeof result.hasUncommittedChanges).toBe('boolean');
    });

    test('detects clean working directory', () => {
      // Create a clean temporary repo
      const tmpDir = path.join(os.tmpdir(), 'clean-repo-test-' + Date.now());
      fs.mkdirSync(tmpDir, { recursive: true });

      try {
        execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git commit --allow-empty -m "initial"', { cwd: tmpDir, stdio: 'pipe' });

        const result = validateRepoState(tmpDir);

        expect(result.hasUncommittedChanges).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test('detects uncommitted changes', () => {
      // Create a repo with uncommitted changes
      const tmpDir = path.join(os.tmpdir(), 'dirty-repo-test-' + Date.now());
      fs.mkdirSync(tmpDir, { recursive: true });

      try {
        execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

        // Create an uncommitted file
        fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'content');

        const result = validateRepoState(tmpDir);

        expect(result.hasUncommittedChanges).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test('handles non-git directories gracefully', () => {
      const tmpDir = path.join(os.tmpdir(), 'not-git-' + Date.now());
      fs.mkdirSync(tmpDir, { recursive: true });

      try {
        const result = validateRepoState(tmpDir);

        // Should not throw, should return safe default
        expect(result).toBeDefined();
        expect(result.hasUncommittedChanges).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('findRepository', () => {
    test('throws error for unknown repository key', () => {
      expect(() => {
        findRepository('nonexistent');
      }).toThrow(/Unknown repository/);
    });

    test('error message lists valid repository options', () => {
      try {
        findRepository('invalid');
      } catch (err) {
        expect(err.message).toContain('redpanda');
        expect(err.message).toContain('cloudv2');
        expect(err.message).toContain('api-docs');
      }
    });

    test('accepts explicit path and validates it', () => {
      // Should throw when explicit path is invalid
      expect(() => {
        findRepository('redpanda', '/nonexistent/path');
      }).toThrow(/Not a valid redpanda repository/);
    });

    test('provides helpful setup instructions on failure', () => {
      try {
        findRepository('redpanda');
      } catch (err) {
        // Error should include setup instructions
        expect(err.message).toContain('Options:');
        expect(err.message).toContain('git clone');
        expect(err.message).toContain('export');
      }
    });
  });

  describe('REPO_CONFIG', () => {
    test('contains required repository configurations', () => {
      expect(REPO_CONFIG).toBeDefined();
      expect(REPO_CONFIG.redpanda).toBeDefined();
      expect(REPO_CONFIG.cloudv2).toBeDefined();
      expect(REPO_CONFIG['api-docs']).toBeDefined();
    });

    test('each repo config has required fields', () => {
      for (const [key, config] of Object.entries(REPO_CONFIG)) {
        expect(config).toHaveProperty('envVar');
        expect(config).toHaveProperty('siblingNames');
        expect(config).toHaveProperty('validator');
        expect(config).toHaveProperty('repoUrl');
        expect(config).toHaveProperty('description');

        expect(typeof config.envVar).toBe('string');
        expect(Array.isArray(config.siblingNames)).toBe(true);
        expect(typeof config.validator).toBe('function');
        expect(typeof config.repoUrl).toBe('string');
        expect(typeof config.description).toBe('string');
      }
    });

    test('redpanda config has expected structure', () => {
      const config = REPO_CONFIG.redpanda;

      expect(config.envVar).toBe('REDPANDA_REPO_PATH');
      expect(config.siblingNames).toContain('redpanda');
      expect(config.repoUrl).toContain('github.com');
      expect(config.protoRoot).toBe('proto');
    });

    test('cloudv2 config has expected structure', () => {
      const config = REPO_CONFIG.cloudv2;

      expect(config.envVar).toBe('CLOUDV2_REPO_PATH');
      expect(config.siblingNames).toContain('cloudv2');
      expect(config.repoUrl).toContain('github.com');
      expect(config.protoRoot).toBe('proto');
    });

    test('api-docs config has expected structure', () => {
      const config = REPO_CONFIG['api-docs'];

      expect(config.envVar).toBe('API_DOCS_REPO_PATH');
      expect(config.siblingNames).toContain('api-docs');
      expect(config.repoUrl).toContain('github.com');
    });

    test('validators are callable functions', () => {
      expect(() => {
        REPO_CONFIG.redpanda.validator('/tmp');
      }).not.toThrow();

      expect(() => {
        REPO_CONFIG.cloudv2.validator('/tmp');
      }).not.toThrow();

      expect(() => {
        REPO_CONFIG['api-docs'].validator('/tmp');
      }).not.toThrow();
    });

    test('sibling names do not contain workspace-specific patterns', () => {
      // Verify the refactoring removed workspace-specific patterns
      for (const [key, config] of Object.entries(REPO_CONFIG)) {
        expect(config.siblingNames).not.toContain('rp-repos');
        expect(config.siblingNames.every(name => !name.includes('/'))).toBe(true);
      }
    });
  });

  describe('Git Utilities - Error Handling Contract', () => {
    test('getCurrentBranch errors are Error instances', () => {
      try {
        getCurrentBranch('/nonexistent');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBeDefined();
        expect(typeof err.message).toBe('string');
      }
    });

    test('validateRepoState never throws, always returns result', () => {
      // Should handle all errors gracefully
      expect(() => {
        const result = validateRepoState('/nonexistent/path');
        expect(result).toBeDefined();
        expect(result).toHaveProperty('hasUncommittedChanges');
      }).not.toThrow();
    });

    test('findRepository error includes all necessary information', () => {
      try {
        findRepository('redpanda', '/invalid/path');
      } catch (err) {
        expect(err.message).toContain('redpanda');
        expect(err.message).toContain('/invalid/path');
        expect(err.message).toContain('proto');
      }
    });
  });

  describe('Module Exports Contract', () => {
    test('exports all documented functions', () => {
      const utils = require('../../bin/mcp-tools/utils');

      const requiredExports = [
        'findRepoRoot',
        'getDocToolsCommand',
        'executeCommand',
        'normalizeVersion',
        'formatDate',
        'findRepository',
        'findAllRepositories',
        'getCurrentBranch',
        'validateRepoState'
      ];

      requiredExports.forEach(funcName => {
        expect(utils[funcName]).toBeDefined();
        expect(typeof utils[funcName]).toBe('function');
      });
    });

    test('exports all documented constants', () => {
      const utils = require('../../bin/mcp-tools/utils');

      const requiredConstants = [
        'MAX_RECURSION_DEPTH',
        'MAX_EXEC_BUFFER_SIZE',
        'DEFAULT_COMMAND_TIMEOUT',
        'DEFAULT_SKIP_DIRS',
        'PLAYBOOK_NAMES',
        'REPO_CONFIG'
      ];

      requiredConstants.forEach(constName => {
        expect(utils[constName]).toBeDefined();
      });
    });
  });
});
