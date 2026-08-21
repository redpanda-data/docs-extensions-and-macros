const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveInsideRepo } = require('../../cli-utils/doc-tools-utils');

describe('resolveInsideRepo', () => {
  let repoRoot;
  let outside;

  beforeEach(() => {
    const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contain-')));
    repoRoot = path.join(sandbox, 'repo');
    outside = path.join(sandbox, 'outside');
    fs.mkdirSync(path.join(repoRoot, 'templates'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'templates', 'table.hbs'), '{{name}}', 'utf8');
    fs.writeFileSync(path.join(outside, 'secrets.txt'), 'decoy', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(repoRoot), { recursive: true, force: true });
  });

  it('resolves a path inside the repository to an absolute path', () => {
    expect(resolveInsideRepo(repoRoot, 'templates/table.hbs')).toBe(
      path.join(repoRoot, 'templates', 'table.hbs')
    );
  });

  it('allows a path that does not exist yet, such as a new output file', () => {
    expect(resolveInsideRepo(repoRoot, 'generated/new/regions.md')).toBe(
      path.join(repoRoot, 'generated', 'new', 'regions.md')
    );
  });

  it('allows an absolute path that stays inside the repository', () => {
    const inside = path.join(repoRoot, 'templates', 'table.hbs');
    expect(resolveInsideRepo(repoRoot, inside)).toBe(inside);
  });

  it('refuses an absolute path outside the repository', () => {
    expect(() => resolveInsideRepo(repoRoot, path.join(outside, 'secrets.txt'), '--template'))
      .toThrow(/--template must be inside the repository/);
  });

  it('refuses a relative path that climbs out of the repository', () => {
    expect(() => resolveInsideRepo(repoRoot, '../outside/secrets.txt', '--output'))
      .toThrow(/--output must be inside the repository/);
  });

  it('refuses a symlink inside the repository that points outside it', () => {
    const link = path.join(repoRoot, 'templates', 'escape.hbs');
    fs.symlinkSync(path.join(outside, 'secrets.txt'), link);
    expect(() => resolveInsideRepo(repoRoot, 'templates/escape.hbs', '--template'))
      .toThrow(/--template must be inside the repository/);
  });

  it('refuses the repository root itself', () => {
    expect(() => resolveInsideRepo(repoRoot, '.')).toThrow(/must be inside the repository/);
  });
});
