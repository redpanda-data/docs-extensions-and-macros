const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../..');
const cli = path.join(repoRoot, 'bin', 'doc-tools.js');

function run(args) {
  const result = spawnSync(process.execPath, [cli, 'generate', 'redpanda-release-notes', ...args], {
    cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', timeout: 60000,
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

describe('generate redpanda-release-notes flags', () => {
  it('offers exactly the expected flags', () => {
    const help = run(['--help']);
    const flags = [...help.stdout.matchAll(/^ {2}(--[a-z][a-z-]*)/gm)].map((m) => m[1]);
    expect(flags.sort()).toEqual([
      '--body', '--date', '--dry-run', '--page', '--properties-file', '--section-file', '--section-only', '--tag',
    ]);
  });

  it('fails when neither --body nor --section-file is given', () => {
    const res = run(['--tag', 'v26.2.3']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/exactly one of --body .* or --section-file/);
  });

  it('fails when --body is given without --date', () => {
    const res = run(['--tag', 'v26.2.3', '--body', 'nope.md']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/--date is required with --body/);
  });

  it('treats a non-GA tag under --section-only as a clean skip, not an error (finding 4)', () => {
    const res = run([
      '--tag', 'v26.2.3-rc1', '--date', '2026-09-15', '--section-only',
      '--body', '__tests__/fixtures/release-notes/v26.2.3-streaming-enterprise.md',
    ]);
    expect(res.status).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/Skipped: not a GA tag/);
    expect(res.stdout).not.toContain('== v'); // no section emitted
  });

  const PROPS_BODY = '__tests__/fixtures/release-notes/v26.2.5-property-names.md';
  const PROPS_FILE = '__tests__/fixtures/release-notes/properties/redpanda-properties-v26.2.4.json';

  it('links known property names as prop: macros with --properties-file', () => {
    const res = run([
      '--tag', 'v26.2.5', '--date', '2026-10-16', '--section-only',
      '--body', PROPS_BODY, '--properties-file', PROPS_FILE,
    ]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Changing prop:cloud_storage_segment_max_upload_interval_sec[link=true] now reports');
    expect(res.stdout).toContain('`health_manager`');
  });

  it('keeps names monospace and warns when no property file is found', () => {
    const res = run([
      '--tag', 'v26.2.5', '--date', '2026-10-16', '--section-only', '--body', PROPS_BODY,
    ]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('`cloud_storage_segment_max_upload_interval_sec`');
    expect(res.stdout).not.toContain('prop:');
    expect(res.stderr).toMatch(/no property file for v26\.2\.5/);
  });

  it('fails when --properties-file names a missing file', () => {
    const res = run([
      '--tag', 'v26.2.5', '--date', '2026-10-16', '--section-only',
      '--body', PROPS_BODY, '--properties-file', 'nope.json',
    ]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/--properties-file/);
  });
});
