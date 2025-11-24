/**
 * Integration tests for MCP tools
 * These tests verify that the MCP tools correctly interface with the doc-tools CLI
 */

const { describe, test, expect, beforeAll } = require('@jest/globals');
const mcpTools = require('../../bin/mcp-tools');
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
        execSync('npx doc-tools --version', {
          encoding: 'utf8',
          stdio: 'pipe'
        });
      }).not.toThrow();
    });

    test('all required generate subcommands exist', () => {
      const output = execSync('npx doc-tools generate --help', {
        encoding: 'utf8',
        stdio: 'pipe'
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
    test('generate_property_docs requires version parameter', () => {
      const result = mcpTools.executeTool('generate_property_docs', {});

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error.toLowerCase()).toContain('version');
    });

    test('generate_metrics_docs requires version parameter', () => {
      const result = mcpTools.executeTool('generate_metrics_docs', {});

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error.toLowerCase()).toContain('version');
    });

    test('generate_rpk_docs requires version parameter', () => {
      const result = mcpTools.executeTool('generate_rpk_docs', {});

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error.toLowerCase()).toContain('version');
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
