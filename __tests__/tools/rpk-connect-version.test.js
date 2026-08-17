'use strict';

/**
 * Tests for getRpkConnectVersion in tools/redpanda-connect/report-delta.js
 *
 * Pins the plugin-refresh command to `rpk connect install --force`.
 * Do NOT "simplify" this back to `rpk connect upgrade`: upgrade parses the
 * currently-installed version through redpanda.VersionFromString
 * (rpk/pkg/redpanda/version.go), whose regex caps each version segment at
 * two digits and therefore throws for any Connect version >= 4.100.0 (same
 * bug class as CON-529). Fixed upstream on dev (redpanda commit 8fc022e7)
 * but present in all rpk releases up to at least v26.2.1. install's
 * "latest" path skips that regex entirely.
 */

jest.mock('child_process');

const { execSync } = require('child_process');
const { getRpkConnectVersion } = require('../../tools/redpanda-connect/report-delta');

describe('getRpkConnectVersion', () => {
  beforeEach(() => {
    execSync.mockReset();
    execSync.mockImplementation(cmd => {
      if (cmd === 'rpk connect --version') {
        return Buffer.from('Version: 4.101.0\nDate:    2026-08-01T00:00:00Z\n');
      }
      return Buffer.from('');
    });
  });

  test('refreshes the plugin with "rpk connect install --force", never "rpk connect upgrade"', () => {
    getRpkConnectVersion();

    const commands = execSync.mock.calls.map(call => call[0]);
    // Must use install --force to sidestep upgrade's VersionFromString bug
    // (see file header comment).
    expect(commands).toContain('rpk connect install --force');
    expect(commands.some(cmd => cmd.includes('rpk connect upgrade'))).toBe(false);
  });

  test('parses the version from "rpk connect --version" output', () => {
    expect(getRpkConnectVersion()).toBe('4.101.0');
  });

  test('throws a descriptive error when the version output is unparseable', () => {
    execSync.mockImplementation(cmd => {
      if (cmd === 'rpk connect --version') {
        return Buffer.from('garbage output\n');
      }
      return Buffer.from('');
    });

    expect(() => getRpkConnectVersion()).toThrow(/Unable to run "rpk connect --version"/);
  });
});
