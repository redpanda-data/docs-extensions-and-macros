'use strict';

// Mock spawnSync before diff-utils captures it at require time
jest.mock('child_process', () => ({ spawnSync: jest.fn() }));

const { spawnSync } = require('child_process');
const fs = require('fs');

const { generatePropertyComparisonReport } = require('../../cli-utils/diff-utils.js');

describe('generatePropertyComparisonReport', () => {
  let existsSpy, logSpy;

  beforeEach(() => {
    existsSpy = jest.spyOn(fs, 'existsSync');
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    spawnSync.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const loggedOutput = () => logSpy.mock.calls.flat().join('\n');

  test('missing old baseline warns, explains what is skipped, and does not throw', () => {
    // findRepoRoot probes for .git/package.json, so only the baseline is missing
    existsSpy.mockImplementation(p => !String(p).includes('redpanda-properties-v1.0.0.json'));

    expect(() => generatePropertyComparisonReport('v1.0.0', 'v2.0.0', 'tmp-out')).not.toThrow();

    expect(spawnSync).not.toHaveBeenCalled();
    const logged = loggedOutput();
    expect(logged).toContain('Skipping detailed property comparison');
    expect(logged).toContain('removed deprecated properties are not restored');
    expect(logged).toContain('expected only when v1.0.0 has never been extracted');
  });

  test('missing new JSON warns and does not throw', () => {
    existsSpy.mockImplementation(p => !String(p).includes('redpanda-properties-v2.0.0.json'));

    expect(() => generatePropertyComparisonReport('v1.0.0', 'v2.0.0', 'tmp-out')).not.toThrow();

    expect(spawnSync).not.toHaveBeenCalled();
    expect(loggedOutput()).toContain('Skipping detailed property comparison');
  });

  test('throws when both inputs exist and the compare script exits non-zero', () => {
    existsSpy.mockReturnValue(true);
    spawnSync.mockReturnValue({ status: 1 });

    expect(() => generatePropertyComparisonReport('v1.0.0', 'v2.0.0', 'tmp-out'))
      .toThrow('Property comparison exited with code 1');
  });

  test('throws when both inputs exist and the compare script fails to spawn', () => {
    existsSpy.mockReturnValue(true);
    spawnSync.mockReturnValue({ error: new Error('spawn ENOENT'), status: null });

    expect(() => generatePropertyComparisonReport('v1.0.0', 'v2.0.0', 'tmp-out'))
      .toThrow('Property comparison failed to run: spawn ENOENT');
  });

  test('succeeds quietly when the compare script exits zero', () => {
    existsSpy.mockReturnValue(true);
    spawnSync.mockReturnValue({ status: 0 });

    expect(() => generatePropertyComparisonReport('v1.0.0', 'v2.0.0', 'tmp-out')).not.toThrow();

    expect(loggedOutput()).toContain('Property comparison report saved to');
  });
});
