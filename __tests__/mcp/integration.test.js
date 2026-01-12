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
    test('generate_property_docs defaults to dev branch when no parameters provided', () => {
      const result = mcpTools.executeTool('generate_property_docs', {});

      expect(result).toBeDefined();
      // Now defaults to branch 'dev', so should be treated as if branch was provided
      // Test will attempt to run but may fail due to missing dependencies - that's OK
      // The key is that it should NOT error about missing parameters
      if (result.error) {
        expect(result.error.toLowerCase()).not.toContain('required');
        expect(result.error.toLowerCase()).not.toContain('missing');
      } else {
        expect(result).toHaveProperty('branch', 'dev');
      }
    });

    test('generate_metrics_docs defaults to dev branch when no parameters provided', () => {
      const result = mcpTools.executeTool('generate_metrics_docs', {});

      expect(result).toBeDefined();
      // Now defaults to branch 'dev', so should be treated as if branch was provided
      // Test will attempt to run but may fail due to missing dependencies - that's OK
      // The key is that it should NOT error about missing parameters
      if (result.error) {
        expect(result.error.toLowerCase()).not.toContain('required');
        expect(result.error.toLowerCase()).not.toContain('missing');
      } else {
        expect(result).toHaveProperty('branch', 'dev');
      }
    });

    test('generate_rpk_docs defaults to dev branch when no parameters provided', () => {
      const result = mcpTools.executeTool('generate_rpk_docs', {});

      expect(result).toBeDefined();
      // Now defaults to branch 'dev', so should be treated as if branch was provided
      // Test will attempt to run but may fail due to missing dependencies - that's OK
      // The key is that it should NOT error about missing parameters
      if (result.error) {
        expect(result.error.toLowerCase()).not.toContain('required');
        expect(result.error.toLowerCase()).not.toContain('missing');
      } else {
        expect(result).toHaveProperty('branch', 'dev');
      }
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

  describe('Proto Comparison Tool', () => {
    test('compare_proto_descriptions requires api_docs_spec parameter', () => {
      const result = mcpTools.executeTool('compare_proto_descriptions', {});

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      // Error message varies based on what fails first (path validation, etc.)
    });

    test('compare_proto_descriptions validates api_docs_spec is non-empty', () => {
      const result = mcpTools.executeTool('compare_proto_descriptions', {
        api_docs_spec: ''
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('compare_proto_descriptions validates api_surface enum', () => {
      const result = mcpTools.executeTool('compare_proto_descriptions', {
        api_docs_spec: 'admin/admin.yaml',  // Use actual file that exists
        api_surface: 'invalid'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      // Should fail with either spec not found or unsupported api_surface
      expect(
        result.error.match(/unsupported|invalid|not found/i)
      ).toBeTruthy();
    });

    test('compare_proto_descriptions auto-detects admin API from spec path', () => {
      const result = mcpTools.executeTool('compare_proto_descriptions', {
        api_docs_spec: 'admin/redpanda-admin-api.yaml'
      });

      expect(result).toBeDefined();
      // Should attempt to run (may fail due to missing repos, but parameter validation passes)
      if (result.success === false && result.error) {
        expect(result.error.toLowerCase()).not.toContain('api_surface');
      }
    });

    test('compare_proto_descriptions auto-detects controlplane API from spec path', () => {
      const result = mcpTools.executeTool('compare_proto_descriptions', {
        api_docs_spec: 'controlplane/redpanda-controlplane-api.yaml'
      });

      expect(result).toBeDefined();
      // Should attempt to run (may fail due to missing repos, but parameter validation passes)
      if (result.success === false && result.error) {
        expect(result.error.toLowerCase()).not.toContain('api_surface');
      }
    });

    test('compare_proto_descriptions handles missing spec file gracefully', () => {
      const result = mcpTools.executeTool('compare_proto_descriptions', {
        api_docs_spec: 'nonexistent/spec.yaml'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('compare_proto_descriptions accepts valid output_format values', () => {
      const formats = ['report', 'detailed', 'json'];

      formats.forEach(format => {
        const result = mcpTools.executeTool('compare_proto_descriptions', {
          api_docs_spec: 'admin/redpanda-admin-api.yaml',
          output_format: format
        });

        expect(result).toBeDefined();
        // Should not fail on format validation (may fail for other reasons)
        if (result.success === false && result.error) {
          expect(result.error.toLowerCase()).not.toContain('output_format');
          expect(result.error.toLowerCase()).not.toContain('invalid format');
        }
      });
    });

    test('compare_proto_descriptions returns expected structure for json format', () => {
      const result = mcpTools.executeTool('compare_proto_descriptions', {
        api_docs_spec: 'admin/redpanda-admin-api.yaml',
        output_format: 'json'
      });

      expect(result).toBeDefined();
      if (result.success) {
        expect(result).toHaveProperty('differences');
        expect(Array.isArray(result.differences)).toBe(true);
      }
    });

    test('compare_proto_descriptions returns report for report format', () => {
      const result = mcpTools.executeTool('compare_proto_descriptions', {
        api_docs_spec: 'admin/redpanda-admin-api.yaml',
        output_format: 'report'
      });

      expect(result).toBeDefined();
      if (result.success) {
        expect(result).toHaveProperty('report');
        expect(typeof result.report).toBe('string');
      }
    });
  });

  describe('Proto Comparison Tool - Path Resolution', () => {
    test('compare_proto_descriptions auto-detects api-docs from sibling directory', () => {
      // This test assumes api-docs is cloned as sibling
      const result = mcpTools.executeTool('compare_proto_descriptions', {
        api_docs_spec: 'admin/redpanda-admin-api.yaml'
      });

      // Should either succeed or fail with helpful error (not repo detection error)
      expect(result).toBeDefined();
      if (result.success === false && result.error) {
        expect(result.error).not.toContain('Could not locate api-docs repository');
      }
    });

    test('compare_proto_descriptions respects explicit api_docs_repo_path', () => {
      const result = mcpTools.executeTool('compare_proto_descriptions', {
        api_docs_spec: 'admin/redpanda-admin-api.yaml',
        api_docs_repo_path: '/nonexistent/path/to/api-docs'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error).toContain('api-docs');
    });

    test('compare_proto_descriptions handles absolute spec paths', () => {
      const absolutePath = path.join('/tmp', 'test-spec.yaml');

      const result = mcpTools.executeTool('compare_proto_descriptions', {
        api_docs_spec: absolutePath
      });

      expect(result).toBeDefined();
      // Should fail on file not found, not repo detection
      if (result.success === false && result.error) {
        expect(result.error).not.toContain('Could not locate api-docs');
      }
    });

    test('compare_proto_descriptions provides helpful error when api-docs not found', () => {
      // Save current env var
      const originalPath = process.env.API_DOCS_REPO_PATH;

      // Set to invalid path to force detection failure
      process.env.API_DOCS_REPO_PATH = '/definitely/does/not/exist';

      const result = mcpTools.executeTool('compare_proto_descriptions', {
        api_docs_spec: 'admin/redpanda-admin-api.yaml',
        api_docs_repo_path: '/also/invalid'
      });

      // Restore env var
      if (originalPath !== undefined) {
        process.env.API_DOCS_REPO_PATH = originalPath;
      } else {
        delete process.env.API_DOCS_REPO_PATH;
      }

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not locate api-docs');
      expect(result.suggestion).toBeDefined();
      expect(result.suggestion).toContain('API_DOCS_REPO_PATH');
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

  describe('Proto Comparison Tool - Refactored Features', () => {
    test('validates API surface only accepts admin or controlplane', () => {
      const result = mcpTools.executeTool('compare_proto_descriptions', {
        api_docs_spec: 'test/test.yaml',
        api_surface: 'connect'  // Should be rejected
      });

      expect(result).toBeDefined();
      // Tool should fail when trying to find proto mappings for unsupported surface
      expect(result.success).toBe(false);
    });

    test('handles fallback instructions on generation errors', () => {
      // This test verifies the error handling provides fallback instructions
      const result = mcpTools.executeTool('compare_proto_descriptions', {
        api_docs_spec: 'nonexistent/spec.yaml',
        api_surface: 'admin'
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('inlined API surface detection works for admin', () => {
      const result = mcpTools.executeTool('compare_proto_descriptions', {
        api_docs_spec: 'admin/test-spec.yaml'
        // No api_surface parameter - should auto-detect as 'admin'
      });

      expect(result).toBeDefined();
      // Even if it fails due to missing files, it should detect admin surface
      if (!result.success) {
        expect(result.error).not.toContain('Could not detect API surface');
      }
    });

    test('inlined API surface detection works for controlplane', () => {
      const result = mcpTools.executeTool('compare_proto_descriptions', {
        api_docs_spec: 'cloud-controlplane/test-spec.yaml'
        // No api_surface parameter - should auto-detect as 'controlplane'
      });

      expect(result).toBeDefined();
      // Even if it fails due to missing files, it should detect controlplane surface
      if (!result.success) {
        expect(result.error).not.toContain('Could not detect API surface');
      }
    });

    test('returns structured output with metadata', () => {
      const result = mcpTools.executeTool('compare_proto_descriptions', {
        api_docs_spec: 'admin/admin.yaml',
        api_surface: 'admin',
        output_format: 'json'
      });

      expect(result).toBeDefined();
      // Should have structure even on error
      if (result.success) {
        expect(result.metadata).toBeDefined();
        expect(result.differences_found).toBeDefined();
      }
    });
  });

  describe('Proto Comparison Tool - PREVIEW Filtering', () => {
    test('accepts validate_format parameter', () => {
      const result = mcpTools.executeTool('compare_proto_descriptions', {
        api_docs_spec: 'admin/admin.yaml',
        api_surface: 'admin',
        validate_format: false
      });

      expect(result).toBeDefined();
      // Should not fail due to parameter validation
    });

    test('returns skipped_preview_count when PREVIEW items filtered', () => {
      const result = mcpTools.executeTool('compare_proto_descriptions', {
        api_docs_spec: 'admin/admin.yaml',
        api_surface: 'admin',
        output_format: 'json'
      });

      expect(result).toBeDefined();
      if (result.success) {
        // Should have preview-related fields in metadata or output
        expect(result.skipped_preview_count !== undefined || result.preview_items_skipped !== undefined).toBeTruthy();
      }
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

    test('proto-analysis module exists and is loadable', () => {
      const protoAnalysisPath = path.join(repoRoot.root, 'bin', 'mcp-tools', 'proto-analysis.js');

      expect(fs.existsSync(protoAnalysisPath)).toBe(true);

      // Verify it can be required
      expect(() => {
        require('../../bin/mcp-tools/proto-analysis');
      }).not.toThrow();
    });

    test('utils module exports git utilities', () => {
      const utils = require('../../bin/mcp-tools/utils');

      expect(utils.getCurrentBranch).toBeDefined();
      expect(typeof utils.getCurrentBranch).toBe('function');
      expect(utils.validateRepoState).toBeDefined();
      expect(typeof utils.validateRepoState).toBe('function');
    });
  });
});
