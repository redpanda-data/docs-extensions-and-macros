'use strict';

/**
 * Tests for getRpkConnectVersion in tools/redpanda-connect/report-delta.js
 *
 * Pins the plugin-refresh command to `rpk connect install --force`, and pins
 * that refresh to CI only — see the "outside CI" block for why.
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
  const savedEnv = {};

  beforeEach(() => {
    // The refresh is gated on the environment, so pin it here instead of
    // inheriting whatever the host happens to set.
    for (const key of ['CI', 'RPCN_FORCE_CONNECT_INSTALL']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CI = 'true';

    execSync.mockReset();
    execSync.mockImplementation(cmd => {
      if (cmd === 'rpk connect --version') {
        return Buffer.from('Version: 4.101.0\nDate:    2026-08-01T00:00:00Z\n');
      }
      return Buffer.from('');
    });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

  // "install --force" skips the self-managed safeguard that "upgrade" applies
  // (rpk/pkg/cli/connect/upgrade.go refuses a plugin whose Managed flag is
  // false) and writes a managed binary that rpk then prioritises. Running it
  // on a developer's machine would shadow a Homebrew or hand-installed
  // Connect for every later rpk call, so it must stay CI-only.
  describe('outside CI', () => {
    beforeEach(() => {
      delete process.env.CI;
    });

    test('never installs, so a self-managed Connect is left alone', () => {
      getRpkConnectVersion();

      const commands = execSync.mock.calls.map(call => call[0]);
      expect(commands.some(cmd => cmd.includes('rpk connect install'))).toBe(false);
      expect(commands).toEqual(['rpk connect --version']);
    });

    test('still reports the installed version', () => {
      expect(getRpkConnectVersion()).toBe('4.101.0');
    });

    test('explains how to get a plugin when the version call fails', () => {
      execSync.mockImplementation(() => {
        throw new Error('exec failed');
      });

      expect(() => getRpkConnectVersion()).toThrow(/rpk connect install/);
    });

    test('RPCN_FORCE_CONNECT_INSTALL opts back in to the refresh', () => {
      process.env.RPCN_FORCE_CONNECT_INSTALL = '1';
      getRpkConnectVersion();

      expect(execSync.mock.calls.map(call => call[0])).toContain(
        'rpk connect install --force'
      );
    });
  });

  test('RPCN_FORCE_CONNECT_INSTALL=false suppresses the refresh in CI', () => {
    process.env.RPCN_FORCE_CONNECT_INSTALL = 'false';
    getRpkConnectVersion();

    const commands = execSync.mock.calls.map(call => call[0]);
    expect(commands.some(cmd => cmd.includes('rpk connect install'))).toBe(false);
  });
});
