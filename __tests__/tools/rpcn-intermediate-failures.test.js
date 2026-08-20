'use strict';

/**
 * Tests for the two helpers that decide how a failed intermediate release is
 * reported by `doc-tools generate rpcn-connector-docs`.
 *
 * Context: rpk validates --connect-version with a regex that caps each segment
 * at two digits (install.go in rpk <= v26.2.1), so installing any Connect
 * version >= 4.100.0 by explicit version fails. That took the whole pipeline
 * down, even though the cumulative diff — which uses install's unvalidated
 * "latest" path — computed correctly. These helpers keep the run alive in that
 * case and make the underlying reason visible.
 */

// The handler transitively requires the Octokit client (ESM-only under Jest);
// stub it out since these tests never touch GitHub.
jest.mock('../../cli-utils/octokit-client', () => ({}));

const {
  planIntermediateFailureReport,
  describeSpawnFailure,
} = require('../../tools/redpanda-connect/rpcn-connector-docs-handler');

const failure = (fromVersion, toVersion, error) => ({
  success: false,
  fromVersion,
  toVersion,
  error,
});

describe('planIntermediateFailureReport', () => {
  const context = { hasCumulativeDiff: true, newVersion: '4.106.0' };

  test('returns null when nothing failed', () => {
    const results = [{ success: true, fromVersion: '4.105.0', toVersion: '4.106.0' }];
    expect(planIntermediateFailureReport(results, context)).toBeNull();
  });

  test('returns null for empty or missing results', () => {
    expect(planIntermediateFailureReport([], context)).toBeNull();
    expect(planIntermediateFailureReport(undefined, context)).toBeNull();
  });

  test('is non-fatal when the cumulative diff exists', () => {
    const report = planIntermediateFailureReport(
      [failure('4.103.1', '4.103.2', 'data unavailable')],
      context
    );

    expect(report.fatal).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(report.lines[0]).toContain('1 intermediate release(s) failed');
    expect(report.lines[0]).not.toContain('Cannot update Antora version');
  });

  test('stays fatal without a cumulative diff, since nothing covers the span', () => {
    const report = planIntermediateFailureReport(
      [failure('4.103.1', '4.103.2', 'data unavailable')],
      { hasCumulativeDiff: false, newVersion: '4.106.0' }
    );

    expect(report.fatal).toBe(true);
    expect(report.lines[0]).toContain('Cannot update Antora version');
    // No reassurance about continuing, because it does not continue.
    expect(report.lines.join('\n')).not.toContain('generation continues');
  });

  test('lists every failure with its reason', () => {
    const report = planIntermediateFailureReport(
      [
        failure('4.103.1', '4.103.2', 'data unavailable (provided version not valid)'),
        failure('4.103.2', '4.104.0', 'data unavailable (provided version not valid)'),
      ],
      context
    );

    const text = report.lines.join('\n');
    expect(report.failures).toHaveLength(2);
    expect(text).toContain('4.103.1 → 4.103.2');
    expect(text).toContain('4.103.2 → 4.104.0');
    expect(text).toContain('provided version not valid');
  });

  test('names the version the skipped changes are attributed to', () => {
    const report = planIntermediateFailureReport(
      [failure('4.103.1', '4.103.2', 'data unavailable')],
      context
    );

    expect(report.lines.join('\n')).toContain('attributed to 4.106.0');
  });

  test('ignores successful releases when counting failures', () => {
    const report = planIntermediateFailureReport(
      [
        { success: true, fromVersion: '4.105.0', toVersion: '4.106.0' },
        failure('4.103.1', '4.103.2', 'data unavailable'),
      ],
      context
    );

    expect(report.failures).toHaveLength(1);
    expect(report.lines[0]).toContain('1 intermediate release(s)');
  });
});

describe('describeSpawnFailure', () => {
  test('prefers stderr, which is where rpk explains a refusal', () => {
    const result = {
      status: 1,
      stderr: Buffer.from('provided version "4.103.1" is not valid. Ensure is either \'latest\'...\n'),
      stdout: Buffer.from('ignored'),
    };

    expect(describeSpawnFailure(result)).toContain('"4.103.1" is not valid');
  });

  test('falls back to stdout when stderr is empty', () => {
    const result = { status: 1, stderr: Buffer.from('  \n'), stdout: Buffer.from('written to stdout') };
    expect(describeSpawnFailure(result)).toBe('written to stdout');
  });

  test('reports a spawn error ahead of any captured output', () => {
    const result = { error: new Error('spawnSync rpk ENOENT'), stderr: Buffer.from('noise') };
    expect(describeSpawnFailure(result)).toBe('spawnSync rpk ENOENT');
  });

  test('describes a signal when there is no output', () => {
    const result = { status: null, signal: 'SIGKILL', stderr: null, stdout: null };
    expect(describeSpawnFailure(result)).toBe('killed by signal SIGKILL');
  });

  test('falls back to the exit code when there is nothing else', () => {
    const result = { status: 3, stderr: Buffer.from(''), stdout: null };
    expect(describeSpawnFailure(result)).toBe('exit code 3');
  });

  test('caps a multi-line message so one failure cannot flood the log', () => {
    const result = { status: 1, stderr: Buffer.from('a\nb\nc\nd\ne\n') };
    expect(describeSpawnFailure(result)).toBe('a; b; c');
  });
});
