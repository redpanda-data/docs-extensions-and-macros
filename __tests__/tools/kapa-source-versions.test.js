'use strict';

/**
 * The one check the scheduled job runs: does every published streaming version
 * have a Kapa source in a group? Unit-tests the classification, then EXECUTES
 * `validate kapa-source-groups` against a stubbed fetch and asserts the exit
 * code and sentinel the drift script keys off.
 *
 * Why the latest release is never the missing one: it publishes at
 * /streaming/current/ and `Documentation (current)` follows it. The version that
 * goes missing is the one just archived, when 26.3 ships and 26.2 moves to
 * /streaming/26.2/ needing a crawl of its own.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { versionFromSourceName, classifySources } = require('../../tools/kapa-source-groups/kapa-source-versions.js');

const repoRoot = path.join(__dirname, '..', '..');
const STUB = path.join(__dirname, 'fixtures', 'kapa-fetch-stub.js');
const SENTINEL = /^KAPA_DRIFT_CONFIRMED$/m;

describe('versionFromSourceName', () => {
  it('reads the version out of the documented naming convention', () => {
    expect(versionFromSourceName('Documentation (24.2)')).toBe('24.2');
    expect(versionFromSourceName('Documentation (current)')).toBe('current');
  });

  it('ignores the Cloud and RPCN crawls, which share the naming but are not versions', () => {
    expect(versionFromSourceName('Documentation (Cloud)')).toBeNull();
    expect(versionFromSourceName('Documentation (RPCN)')).toBeNull();
  });

  it('ignores every other source and never throws on junk', () => {
    for (const v of ['Agentic Data Plane', 'GitHub Discussions', '', null, undefined, 42, 'Documentation ()']) {
      expect(versionFromSourceName(v)).toBeNull();
    }
  });
});

describe('classifySources', () => {
  it('separates grouped sources from unassigned ones', () => {
    const r = classifySources([
      { name: 'Documentation (24.2)', source_groups: [{ id: 'g1' }] },
      { name: 'Documentation (26.2)', source_groups: [] },
      { name: 'Documentation (Cloud)', source_groups: [] },
    ]);
    expect([...r.covered]).toEqual(['24.2']);
    expect([...r.unassigned]).toEqual(['26.2']);
  });

  it('treats a version as covered if ANY of its sources is grouped', () => {
    const r = classifySources([
      { name: 'Documentation (25.2)', source_groups: [{ id: 'g' }] },
      { name: 'Documentation (25.2)', source_groups: [] },
    ]);
    expect([...r.covered]).toEqual(['25.2']);
    expect(r.unassigned.size).toBe(0);
  });

  it('tolerates the spec bug where source_groups is a string, a null, or absent', () => {
    // Kapa declares source_groups as "type":"string" but returns arrays. toList
    // handles all shapes; here we only need it not to throw and not to invent
    // a group.
    const r = classifySources([
      { name: 'Documentation (24.1)', source_groups: null },
      { name: 'Documentation (24.3)' },
      { name: 'Documentation (25.1)', source_groups: 'g1' },
    ]);
    expect(r.covered.has('25.1')).toBe(true);
    expect([...r.unassigned].sort()).toEqual(['24.1', '24.3']);
  });
});

describe('validate kapa-source-groups, executed', () => {
  let tmpDir;
  beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapa-cov-')); });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const source = (v, grouped = true) => ({ name: `Documentation (${v})`, source_groups: grouped ? [{ id: `g-${v}` }] : [] });

  // `mapped` is the committed mapping's segment list. It defaults to every
  // grouped source, which is the in-sync state; tests that want the mapping to
  // lag Kapa pass it explicitly. `mapping: 'missing'` points at no file.
  const run = ({ sources, sitemapVersions, fail, mapped, mapping }) => {
    const id = Math.random().toString(36).slice(2);
    const stubFile = path.join(tmpDir, `s-${id}.json`);
    fs.writeFileSync(stubFile, JSON.stringify({ sources, sitemapVersions }));
    let mappingFile = path.join(tmpDir, `m-${id}.json`);
    if (mapping === 'missing') {
      mappingFile = path.join(tmpDir, 'does-not-exist.json');
    } else {
      const segs = mapped || sources.filter((src) => src.source_groups.length).map((src) => src.name.match(/\((.+)\)/)[1]);
      fs.writeFileSync(mappingFile, JSON.stringify({
        default_segment: 'current',
        segments: Object.fromEntries(segs.map((v) => [v, { group_id: `g-${v}`, group_name: v, source_ids: [], source_names: [] }])),
      }));
    }
    const env = { ...process.env, KAPA_API_KEY: 'k', KAPA_PROJECT_ID: 'p', STUB_FILE: stubFile };
    if (fail) env.STUB_FAIL = fail; else delete env.STUB_FAIL;
    try {
      const out = execFileSync('node', ['--require', STUB, 'bin/doc-tools.js', 'validate', 'kapa-source-groups', '--mapping', mappingFile],
        { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: 0, out };
    } catch (e) {
      return { status: e.status, out: (e.stdout || '') + (e.stderr || '') };
    }
  };

  it('exits 0 with no sentinel when every published version has a grouped source', () => {
    const r = run({ sources: ['24.2', '25.2', 'current'].map((v) => source(v)), sitemapVersions: ['24.2', '25.2', 'current'] });
    expect(r.status).toBe(0);
    expect(r.out).not.toMatch(SENTINEL);
  });

  it('exits 1 with the sentinel when a just-archived version has no source', () => {
    // 26.3 shipped: current now holds 26.3, and 26.2 was published at
    // /streaming/26.2/ with no crawl of its own yet.
    const r = run({ sources: ['25.2', 'current'].map((v) => source(v)), sitemapVersions: ['25.2', '26.2', 'current'] });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(SENTINEL);
    expect(r.out).toMatch(/26\.2: published at \/streaming\/26\.2\/ but Kapa has no "Documentation \(26\.2\)" source/);
    expect(r.out).not.toMatch(/25\.2: published/);
  });

  it('exits 1 when a source exists but is not in a group, since that makes it global', () => {
    const r = run({ sources: [source('25.2'), source('26.2', false), source('current')], sitemapVersions: ['25.2', '26.2', 'current'] });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(SENTINEL);
    expect(r.out).toMatch(/26\.2: "Documentation \(26\.2\)" exists but is not in a source group/);
    // The source exists, so it must not ALSO be reported as absent: the issue
    // body quotes this output and a false "no source" line sends the reader to
    // create a duplicate crawl.
    expect(r.out).not.toMatch(/26\.2: published at .* but Kapa has no/);
  });

  it('exits 1 with the sentinel when Kapa covers a version the committed mapping lacks', () => {
    // The dashboard work was done but nobody regenerated and released the
    // mapping. Every surface reads the mapping, so readers on 26.2 are still
    // getting the default segment, and a Kapa-only check would say all clear.
    const r = run({
      sources: ['25.2', '26.2', 'current'].map((v) => source(v)),
      sitemapVersions: ['25.2', '26.2', 'current'],
      mapped: ['25.2', 'current'],
    });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(SENTINEL);
    expect(r.out).toMatch(/26\.2: Kapa has a grouped "Documentation \(26\.2\)" source, but .* has no "26\.2" segment/);
    expect(r.out).toMatch(/doc-tools generate kapa-source-groups/);
    // Nothing is wrong in the dashboard, so do not send the reader there.
    expect(r.out).not.toMatch(/Sources > Add source/);
  });

  it('ignores the prerelease segment, which publishes at /streaming/beta/ with no group by design', () => {
    // docs-site sets latest_prerelease_version_segment: 'beta'. During a beta
    // cycle the sitemap carries /streaming/beta/ for weeks; reporting it would
    // file the same false issue every Monday and ask for a crawl nobody wants.
    const r = run({ sources: ['25.2', 'current'].map((v) => source(v)), sitemapVersions: ['25.2', 'beta', 'current'] });
    expect(r.status).toBe(0);
    expect(r.out).not.toMatch(SENTINEL);
    expect(r.out).toMatch(/ignoring prerelease segment beta/);
    expect(r.out).not.toMatch(/beta: published/);
  });

  it('still reports a real gap when a beta is also published', () => {
    const r = run({ sources: ['25.2', 'current'].map((v) => source(v)), sitemapVersions: ['25.2', '26.2', 'beta', 'current'] });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/26\.2: published at/);
    expect(r.out).not.toMatch(/beta: published/);
  });

  it('exits 2 with no sentinel when the committed mapping cannot be read', () => {
    // "Cannot tell what the surfaces read" is inconclusive, not a gap.
    const r = run({ sources: [source('current')], sitemapVersions: ['current'], mapping: 'missing' });
    expect(r.status).toBe(2);
    expect(r.out).not.toMatch(SENTINEL);
    expect(r.out).toMatch(/Could not read the committed mapping/);
  });

  it('does not report Kapa sources for versions no longer published', () => {
    // An extra old crawl is harmless to scoping; this check is about coverage.
    const r = run({ sources: ['23.3', '25.2', 'current'].map((v) => source(v)), sitemapVersions: ['25.2', 'current'] });
    expect(r.status).toBe(0);
  });

  it('exits 2 with no sentinel when Kapa is unreachable', () => {
    const r = run({ sources: [source('current')], sitemapVersions: ['current'], fail: 'kapa' });
    expect(r.status).toBe(2);
    expect(r.out).not.toMatch(SENTINEL);
    expect(r.out).toMatch(/Could not check Kapa sources/);
  });

  it('exits 2 with no sentinel when the sitemap is unreachable', () => {
    // "We do not know what is published" must never read as "a version is missing".
    const r = run({ sources: [source('current')], sitemapVersions: ['current'], fail: 'sitemap' });
    expect(r.status).toBe(2);
    expect(r.out).not.toMatch(SENTINEL);
  });

  it('tells the reader what to do, in the dashboard and then in this repo', () => {
    const r = run({ sources: [source('current')], sitemapVersions: ['26.2', 'current'] });
    expect(r.out).toMatch(/Sources > Add source/);
    expect(r.out).toMatch(/doc-tools generate kapa-source-groups/);
  });
});
