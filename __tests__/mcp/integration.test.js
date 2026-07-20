/**
 * Integration tests for MCP tools
 * These tests verify that the MCP tools correctly interface with the doc-tools CLI
 */

const { describe, test, expect, beforeAll, afterAll } = require('@jest/globals');

// Stub only `spawnSync` so the parameter-defaulting tests below can verify
// ref/tag defaulting without triggering a real (multi-minute, environment-
// dependent) build from source. `execSync` and `spawn` keep their real
// implementations, so the CLI-availability tests still exercise the actual
// doc-tools binary. The default implementation delegates to the real
// spawnSync; individual describe blocks override it as needed.
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return { ...actual, spawnSync: jest.fn(actual.spawnSync) };
});

const mcpTools = require('../../bin/mcp-tools');
const childProcess = require('child_process');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

describe('MCP Tools Integration Tests', () => {
  let repoRoot;

  beforeAll(() => {
    repoRoot = mcpTools.findRepoRoot();
  });

  describe('CLI Availability', () => {
    test('doc-tools CLI is available', () => {
      expect(() => {
        // Use local bin/doc-tools.js to avoid npx cache issues in CI
        execSync('node bin/doc-tools.js --version', {
          encoding: 'utf8',
          stdio: 'pipe',
          cwd: repoRoot.root
        });
      }).not.toThrow();
    });

    test('all required generate subcommands exist', () => {
      // Use local bin/doc-tools.js to avoid npx cache issues in CI
      const output = execSync('node bin/doc-tools.js generate --help', {
        encoding: 'utf8',
        stdio: 'pipe',
        cwd: repoRoot.root
      });

      const requiredCommands = [
        'property-docs',
        'metrics-docs',
        'rpk-docs',
        'rpcn-connector-docs',
        'helm-spec',
        'cloud-regions',
        'crd-spec',
        'bundle-openapi'
      ];

      requiredCommands.forEach(cmd => {
        expect(output).toContain(cmd);
      });
    });
  });

  describe('Tool Execution', () => {
    test('get_antora_structure returns valid structure', () => {
      const result = mcpTools.executeTool('get_antora_structure', {});

      expect(result).toBeDefined();
      expect(result.repoRoot).toBe(repoRoot.root);
      expect(result.components).toBeDefined();
      expect(Array.isArray(result.components)).toBe(true);
    });

    test('get_redpanda_version returns version info', async () => {
      const result = mcpTools.executeTool('get_redpanda_version', {});

      expect(result).toBeDefined();
      if (result.success) {
        expect(result.version).toBeDefined();
        expect(result.docker_tag).toBeDefined();
        expect(result.notes_url).toBeDefined();
      } else {
        // Network errors are acceptable in tests
        expect(result.error).toBeDefined();
      }
    }, 30000);

    test('get_console_version returns version info', async () => {
      const result = mcpTools.executeTool('get_console_version', {});

      expect(result).toBeDefined();
      if (result.success) {
        expect(result.version).toBeDefined();
        expect(result.docker_tag).toBeDefined();
      } else {
        // Network errors are acceptable in tests
        expect(result.error).toBeDefined();
      }
    }, 30000);
  });

  describe('Generate Tools - Parameter Validation', () => {
    // These tools default to ref/branch 'dev' when no ref is given, then build
    // from source. We only want to verify the *defaulting*, not run a real
    // build (which is multi-minute and environment-dependent), so stub the
    // build to fail fast. Each tool now reports the resolved ref even on the
    // failure path, so defaulting can be asserted deterministically.
    beforeAll(() => {
      childProcess.spawnSync.mockImplementation(() => ({
        status: 1,
        stdout: '',
        stderr: 'build skipped in unit test',
        error: null
      }));
    });

    afterAll(() => {
      // Restore the real implementation for any later describe blocks.
      childProcess.spawnSync.mockImplementation(
        jest.requireActual('child_process').spawnSync
      );
    });

    test('generate_property_docs defaults to dev branch when no parameters provided', () => {
      const result = mcpTools.executeTool('generate_property_docs', {});

      expect(result).toBeDefined();
      // Defaulting to branch 'dev' must be reported regardless of build outcome.
      expect(result).toHaveProperty('branch', 'dev');
    });

    test('generate_metrics_docs defaults to dev branch when no parameters provided', () => {
      const result = mcpTools.executeTool('generate_metrics_docs', {});

      expect(result).toBeDefined();
      // Defaulting to branch 'dev' must be reported regardless of build outcome.
      expect(result).toHaveProperty('branch', 'dev');
    });

    test('generate_rpk_docs defaults to dev branch when no parameters provided', () => {
      const result = mcpTools.executeTool('generate_rpk_docs', {});

      expect(result).toBeDefined();
      // The tool defaults to ref 'dev' when no ref/tag/branch is given. What
      // this test verifies is that parameter defaulting worked: the resolved
      // ref must be 'dev' regardless of the (stubbed, and in real use
      // environment-dependent) build outcome, which the tool reports even on
      // failure. Substring-matching the error text for "required"/"missing"
      // was unreliable: build errors such as "requires go 1.x or newer" contain
      // those words without being parameter-validation failures.
      expect(result).toHaveProperty('ref', 'dev');
      expect(result).toHaveProperty('version', 'dev');
      expect(result).toHaveProperty('ref_type', 'branch');
    });

    test('generate_crd_docs requires tag parameter', () => {
      const result = mcpTools.executeTool('generate_crd_docs', {});

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error.toLowerCase()).toContain('tag');
    });

    test('generate_bundle_openapi requires tag parameter', () => {
      const result = mcpTools.executeTool('generate_bundle_openapi', {});

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error.toLowerCase()).toContain('tag');
    });
  });

  describe('Review Tool', () => {
    test('review_generated_docs requires doc_type parameter', () => {
      const result = mcpTools.executeTool('review_generated_docs', {});

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error).toContain('doc_type');
    });

    test('review_generated_docs validates doc_type enum', () => {
      const result = mcpTools.executeTool('review_generated_docs', {
        doc_type: 'invalid_type'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    test('unknown tool returns error', () => {
      const result = mcpTools.executeTool('nonexistent_tool', {});

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown tool');
    });

    test('invalid command in run_doc_tools_command is rejected', () => {
      const result = mcpTools.executeTool('run_doc_tools_command', {
        command: 'generate property-docs; rm -rf /'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error).toContain('shell metacharacters');
    });
  });

  describe('CLI Output Parsing', () => {
    test('property-docs CLI output format is parseable', () => {
      // Test that we can detect property counts from CLI output
      const mockOutput = 'Successfully extracted 245 properties to JSON';
      const match = mockOutput.match(/(\d+) properties/i);

      expect(match).toBeDefined();
      expect(match[1]).toBe('245');
    });

    test('metrics-docs CLI output format is parseable', () => {
      const mockOutput = 'Generated docs for 180 metrics';
      const match = mockOutput.match(/(\d+) metrics/i);

      expect(match).toBeDefined();
      expect(match[1]).toBe('180');
    });

    test('rpk-docs CLI output format is parseable', () => {
      const mockOutput = 'Generated documentation for 75 commands';
      const match = mockOutput.match(/(\d+) commands/i);

      expect(match).toBeDefined();
      expect(match[1]).toBe('75');
    });
  });

  describe('File System Expectations', () => {
    test('doc-tools expects docs-extensions-and-macros structure', () => {
      const packageJsonPath = path.join(repoRoot.root, 'package.json');
      const binPath = path.join(repoRoot.root, 'bin', 'doc-tools.js');

      expect(fs.existsSync(packageJsonPath)).toBe(true);
      expect(fs.existsSync(binPath)).toBe(true);
    });

    test('property overrides file location is correct', () => {
      const overridesPath = path.join(repoRoot.root, 'docs-data', 'property-overrides.json');
      const docsDataDir = path.join(repoRoot.root, 'docs-data');

      expect(fs.existsSync(docsDataDir)).toBe(true);
      // File may or may not exist depending on repo state, but dir should exist
    });
  });
});
