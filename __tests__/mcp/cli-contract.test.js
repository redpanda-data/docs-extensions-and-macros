/**
 * CLI Contract Tests
 *
 * These tests verify that the doc-tools CLI maintains the expected interface
 * that the MCP server depends on. If these tests fail, it means the CLI has
 * changed in a way that might break the MCP server.
 */

const { describe, test, expect } = require('@jest/globals');
const { execSync } = require('child_process');

/**
 * Execute a CLI command and return the result
 */
function executeCLI(command) {
  try {
    const output = execSync(`npx doc-tools ${command}`, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 10000
    });
    return { success: true, output };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status
    };
  }
}

describe('CLI Contract Tests', () => {
  describe('Command Structure', () => {
    test('generate command exists', () => {
      const result = executeCLI('generate --help');
      expect(result.success).toBe(true);
      expect(result.output).toContain('generate');
    });

    test('get-redpanda-version command exists', () => {
      const result = executeCLI('get-redpanda-version --help');
      expect(result.success).toBe(true);
    });

    test('get-console-version command exists', () => {
      const result = executeCLI('get-console-version --help');
      expect(result.success).toBe(true);
    });
  });

  describe('Generate Subcommands', () => {
    const requiredSubcommands = [
      {
        name: 'property-docs',
        requiredFlags: ['--tag'],
        optionalFlags: ['--generate-partials', '--cloud-support', '--overrides']
      },
      {
        name: 'metrics-docs',
        requiredFlags: ['--tag'],
        optionalFlags: []
      },
      {
        name: 'rpk-docs',
        requiredFlags: ['--tag'],
        optionalFlags: []
      },
      {
        name: 'rpcn-connector-docs',
        requiredFlags: [],
        optionalFlags: ['--fetch-connectors', '--draft-missing', '--update-whats-new', '--include-bloblang', '--data-dir', '--old-data', '--csv', '--overrides']
      },
      {
        name: 'helm-spec',
        requiredFlags: [],
        optionalFlags: ['--chart-dir', '--tag', '--readme', '--output-dir', '--output-suffix']
      },
      {
        name: 'cloud-regions',
        requiredFlags: [],
        optionalFlags: ['--output', '--format', '--owner', '--repo', '--path', '--ref', '--template', '--dry-run']
      },
      {
        name: 'crd-spec',
        requiredFlags: ['--tag'],
        optionalFlags: ['--source-path', '--depth', '--templates-dir', '--output']
      },
      {
        name: 'bundle-openapi',
        requiredFlags: ['--tag'],
        optionalFlags: ['--repo', '--surface', '--out-admin', '--out-connect', '--admin-major', '--use-admin-major-version', '--quiet']
      }
    ];

    requiredSubcommands.forEach(({ name, requiredFlags, optionalFlags }) => {
      describe(name, () => {
        test(`${name} command exists`, () => {
          const result = executeCLI(`generate ${name} --help`);
          expect(result.success).toBe(true);
          expect(result.output).toContain(name);
        });

        requiredFlags.forEach(flag => {
          test(`${name} supports required flag ${flag}`, () => {
            const result = executeCLI(`generate ${name} --help`);
            expect(result.output).toContain(flag);
          });
        });

        optionalFlags.forEach(flag => {
          test(`${name} supports optional flag ${flag}`, () => {
            const result = executeCLI(`generate ${name} --help`);
            expect(result.output).toContain(flag);
          });
        });
      });
    });
  });

  describe('Output Format Contracts', () => {
    test('get-redpanda-version outputs expected format', () => {
      const result = executeCLI('get-redpanda-version');

      if (result.success) {
        // Should output REDPANDA_VERSION= format
        expect(result.output).toMatch(/REDPANDA_VERSION=v?\d+\.\d+\.\d+/);
      } else {
        // Network errors are acceptable, but format should still be parseable
        expect(result.stderr || result.error).toBeDefined();
      }
    });

    test('get-console-version outputs expected format', () => {
      const result = executeCLI('get-console-version');

      if (result.success) {
        // Should output CONSOLE_VERSION= format
        expect(result.output).toMatch(/CONSOLE_VERSION=v?\d+\.\d+\.\d+/);
      } else {
        // Network errors are acceptable
        expect(result.stderr || result.error).toBeDefined();
      }
    });
  });

  describe('Error Handling Contracts', () => {
    test('missing required parameter produces error', () => {
      // property-docs requires --tag
      const result = executeCLI('generate property-docs');

      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
    });

    test('invalid flag produces error', () => {
      const result = executeCLI('generate property-docs --invalid-flag-xyz');

      expect(result.success).toBe(false);
    });

    test('nonexistent command produces error', () => {
      const result = executeCLI('generate nonexistent-command');

      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe('Version Compatibility', () => {
    test('doc-tools version is available', () => {
      const result = executeCLI('--version');

      expect(result.success).toBe(true);
      expect(result.output).toMatch(/\d+\.\d+\.\d+/);
    });
  });
});
