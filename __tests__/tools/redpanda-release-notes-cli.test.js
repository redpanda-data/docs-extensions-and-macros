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
    expect(flags.sort()).toEqual(['--body', '--date', '--dry-run', '--page', '--section-only', '--tag']);
  });

  it('fails clearly when a required option is missing', () => {
    const res = run(['--tag', 'v26.2.3', '--date', '2026-09-15']); // no --body
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/--body/);
  });
});
