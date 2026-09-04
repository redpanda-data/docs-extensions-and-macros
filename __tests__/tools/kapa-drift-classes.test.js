'use strict';

/**
 * Executes `validate kapa-source-groups` against a stubbed Kapa for every class
 * of drift the check claims to detect, and asserts the exit code the scheduled
 * job actually keys off.
 *
 * WHY THIS EXISTS
 * ---------------
 * Review found that the generator REFUSES (throws) on exactly the states that
 * constitute drift: a version group with no sources, the default segment's group
 * missing, no groups at all. validate called it inside its exit-2 try block, so
 * those states reported "could not find out" and the drift job filed NOTHING —
 * for the changes that break the most pages. Kapa answers an unknown-group query
 * from its global sources with no error, so production would silently lose every
 * versioned page while the weekly job stayed quiet.
 *
 * The inverse mattered too: exit 1 was taken as proof of drift, but Commander
 * exits 1 on a usage error and an uncaught throw exits 1 as well, so a crash
 * filed an issue announcing stale docs and quoting a stack trace as the report.
 * Hence the sentinel.
 *
 * fetch is stubbed via --require rather than by pointing KAPA_API_BASE at a
 * local server, because making that env-overridable would be a way to aim a real
 * API key at another host.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const STUB = path.join(__dirname, 'fixtures', 'kapa-fetch-stub.js');
const MAPPING = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs-data', 'kapa-source-groups.json'), 'utf8'));
const PARENT = { id: MAPPING.parent_group.id, name: MAPPING.parent_group.name, type: 'product' };

let tmpDir;
beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapa-drift-')); });
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/** Kapa's two endpoints, reconstructed from the committed mapping. */
const liveState = () => {
  const segs = JSON.parse(JSON.stringify(MAPPING.segments));
  return {
    subs: Object.entries(segs).map(([name, v]) => ({ id: v.group_id, name, parent_group: PARENT.id })),
    sources: Object.entries(segs).flatMap(([, v]) =>
      v.source_ids.map((id, i) => ({ id, name: v.source_names[i], source_groups: [{ id: v.group_id }] }))),
    globals: (MAPPING.global_sources || []).map((n, i) => ({ id: `g${i}`, name: n, source_groups: [] })),
  };
};

const runValidate = (mutate) => {
  const x = mutate(liveState());
  const stubFile = path.join(tmpDir, `s-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(stubFile, JSON.stringify({
    groups: [{ ...PARENT, sub_groups: x.subs }],
    sources: [...x.sources, ...x.globals],
  }));
  try {
    const stdout = execFileSync('node', ['--require', STUB, 'bin/doc-tools.js',
      'validate', 'kapa-source-groups', '--skip-site-check'], {
      cwd: repoRoot,
      env: { ...process.env, KAPA_API_KEY: 'k', KAPA_PROJECT_ID: MAPPING.project_id, STUB_FILE: stubFile },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, out: stdout };
  } catch (e) {
    return { status: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
};

const SENTINEL = /^KAPA_DRIFT_CONFIRMED$/m;

describe('validate exits 0 when Kapa matches the committed mapping', () => {
  it('reports in sync and prints no drift sentinel', () => {
    const r = runValidate((x) => x);
    expect(r.status).toBe(0);
    expect(r.out).not.toMatch(SENTINEL);
  });
});

describe('every drift class exits 1 WITH the sentinel, so an issue gets filed', () => {
  const drift = {
    // Each of these is a change someone can make in the Kapa dashboard.
    'a source is unassigned from its version group': (x) =>
      ({ ...x, sources: x.sources.filter((s) => !s.name.includes('24.1')) }),
    'a source is reassigned to the wrong version group': (x) =>
      ({ ...x, sources: x.sources.map((s) => s.name.includes('24.1')
        ? { ...s, source_groups: [{ id: MAPPING.segments['25.1'].group_id }] } : s) }),
    // The default segment's group is the one every unversioned page, every
    // /api/ page and every latest-version reader depends on.
    'the default segment group is renamed': (x) =>
      ({ ...x, subs: x.subs.map((g) => g.name === 'current' ? { ...g, name: 'latest' } : g) }),
    'the default segment group is deleted': (x) =>
      ({ ...x, subs: x.subs.filter((g) => g.name !== 'current') }),
    'a non-default group is deleted': (x) =>
      ({ ...x, subs: x.subs.filter((g) => g.name !== '24.2') }),
    // Two groups sharing a name used to collapse silently, and which id won
    // depended on the order Kapa returned them in.
    'two groups share a version name': (x) =>
      ({ ...x, subs: [...x.subs, { id: 'dup-999', name: 'current', parent_group: PARENT.id }] }),
    'the whole group tree is gone': (x) => ({ ...x, subs: [] }),
    'a source is renamed in place': (x) =>
      ({ ...x, sources: x.sources.map((s) => s.name.includes('25.2') ? { ...s, name: 'Renamed' } : s) }),
    'a versioned source becomes global': (x) =>
      ({ ...x, sources: x.sources.map((s) => s.name.includes('23.3') ? { ...s, source_groups: [] } : s) }),
  };

  it.each(Object.keys(drift))('%s', (label) => {
    const r = runValidate(drift[label]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(SENTINEL);
  });

  it('names a renamed source rather than blaming the mapping shape', () => {
    // Same source ids, different names fell through every branch and reported
    // "no known field changed, so the mapping shape itself has changed", which
    // sends the reader hunting a schema problem that does not exist.
    const r = runValidate(drift['a source is renamed in place']);
    expect(r.out).toMatch(/source renamed/);
    expect(r.out).not.toMatch(/mapping shape itself has changed/);
  });

  it('explains a deleted default group instead of reporting it as unreachable', () => {
    const r = runValidate(drift['the default segment group is deleted']);
    expect(r.out).toMatch(/Kapa source groups no longer match/);
    expect(r.out).not.toMatch(/Could not check/);
  });
});

describe('validate exits 2 when it genuinely could not find out', () => {
  it('a failing Kapa API is inconclusive, not drift', () => {
    const stubFile = path.join(tmpDir, 'unreachable.json');
    fs.writeFileSync(stubFile, JSON.stringify({ fail: true }));
    let status, out = '';
    try {
      out = execFileSync('node', ['--require', STUB, 'bin/doc-tools.js',
        'validate', 'kapa-source-groups', '--skip-site-check'], {
        cwd: repoRoot,
        env: { ...process.env, KAPA_API_KEY: 'k', KAPA_PROJECT_ID: MAPPING.project_id, STUB_FILE: stubFile, STUB_FAIL: '1' },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      status = 0;
    } catch (e) { status = e.status; out = (e.stdout || '') + (e.stderr || ''); }
    expect(status).toBe(2);
    expect(out).not.toMatch(SENTINEL);
  });
});
