/**
 * CLI-level tests for `doc-tools generate cloud-regions` path handling.
 *
 * The containment check lives in the CLI action, which is also the single
 * enforcement point for the MCP server (bin/mcp-tools/cloud-regions.js spawns
 * this command). These tests therefore run the real binary.
 *
 * Every GitHub token variable is stripped from the child environment, so the
 * command can never reach the network: a contained path stops at the token
 * check, and an uncontained path is refused before it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../..');
const cli = path.join(repoRoot, 'bin', 'doc-tools.js');

function runCloudRegions(args) {
  const env = { ...process.env };
  for (const name of [
    'GIT_CREDENTIALS',
    'REDPANDA_GITHUB_TOKEN',
    'ACTIONS_BOT_TOKEN',
    'GITHUB_TOKEN',
    'VBOT_GITHUB_API_TOKEN',
    'GH_TOKEN'
  ]) {
    delete env[name];
  }
  const result = spawnSync(process.execPath, [cli, 'generate', 'cloud-regions', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    env,
    timeout: 60000
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

describe('generate cloud-regions path containment', () => {
  let outsideDir;
  let outsideFile;

  beforeAll(() => {
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-regions-outside-'));
    outsideFile = path.join(outsideDir, 'decoy.txt');
    fs.writeFileSync(outsideFile, 'DECOY-NOT-A-SECRET\n', 'utf8');
  });

  afterAll(() => {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('refuses an absolute --template outside the repository', () => {
    const result = runCloudRegions(['--dry-run', '--template', outsideFile]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--template must be inside the repository/);
    expect(result.stdout).not.toContain('DECOY-NOT-A-SECRET');
  });

  it('refuses a --template that climbs out of the repository', () => {
    const traversal = path.join('..', path.relative(path.dirname(repoRoot), outsideFile));
    const result = runCloudRegions(['--dry-run', '--template', traversal]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--template must be inside the repository/);
    expect(result.stdout).not.toContain('DECOY-NOT-A-SECRET');
  });

  it('refuses an absolute --output outside the repository', () => {
    const target = path.join(outsideDir, 'written-by-cli.md');
    const result = runCloudRegions(['--output', target]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--output must be inside the repository/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('refuses an --output that climbs out of the repository', () => {
    const target = path.join(outsideDir, 'written-by-traversal.md');
    const traversal = path.join('..', path.relative(path.dirname(repoRoot), target));
    const result = runCloudRegions(['--output', traversal]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--output must be inside the repository/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('refuses --cluster-type without a destination of its own', () => {
    const result = runCloudRegions(['--cluster-type', 'BYOC']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--cluster-type needs its own destination/);
  });

  it('accepts --cluster-type with --dry-run', () => {
    const result = runCloudRegions(['--cluster-type', 'BYOC', '--dry-run']);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toMatch(/needs its own destination/);
    expect(result.stderr).toMatch(/GitHub token is required/);
  });

  it('accepts an in-repo --template and --output and only then asks for a token', () => {
    const result = runCloudRegions([
      '--template', path.join('tools', 'cloud-regions', 'cloud-regions-table-md.hbs'),
      '--output', path.join('build', 'cloud-regions-test.md')
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toMatch(/must be inside the repository/);
    expect(result.stderr).toMatch(/GitHub token is required/);
  });
});
