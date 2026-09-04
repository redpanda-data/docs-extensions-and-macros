'use strict';

// Executes extensions/kapa-source-groups.js against a fake Antora generator
// context and content catalog, so the attribute it sets is observed rather than
// assumed.
//
// This extension is the link that makes docs-ui's get-kapa-source-groups helper
// live: without the attribute, the helper returns [] everywhere and Ask AI
// searches every docs version, which is the DOC-2450 behaviour. So what matters
// most is that a broken mapping degrades to "set nothing and warn" rather than
// setting something wrong -- scoping to a group that does not hold the reader's
// version returns only Kapa's global sources, silently.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ext = require('../../extensions/kapa-source-groups.js');
const { validateMapping, ATTRIBUTE_NAME, ASSET_DIR, ASSET_FILENAME } = ext;

const GOOD = {
  project_id: '97f44223-f930-4fb9-ae1e-ecd436a4d85c',
  parent_group: { id: '238b3c08', name: 'Streaming', type: 'product' },
  default_segment: 'current',
  segments: {
    '25.2': { group_id: 'grp-252', group_name: '25.2', source_ids: ['s1'], source_names: ['Documentation (25.2)'] },
    current: { group_id: 'grp-cur', group_name: 'current', source_ids: ['s2'], source_names: ['Documentation (current)'] },
  },
  global_sources: ['Agentic Data Plane'],
};

let tmpDir;
beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapa-ext-')); });
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/** Minimal stand-in for Antora's generator context + content catalog. */
function harness ({ mapping = GOOD, raw = null, components, missingFile = false } = {}) {
  const file = path.join(tmpDir, `m-${Math.random().toString(36).slice(2)}.json`);
  if (!missingFile) fs.writeFileSync(file, raw !== null ? raw : JSON.stringify(mapping));

  const logs = { warn: [], info: [], error: [] };
  const listeners = {};
  const ctx = {
    getLogger: () => ({
      warn: (m) => logs.warn.push(m),
      info: (m) => logs.info.push(m),
      error: (m) => logs.error.push(m),
    }),
    on: (event, fn) => { listeners[event] = fn; },
  };

  // Built ONCE and returned by reference. Rebuilding per call would hand the
  // extension different objects than the assertions inspect, so a working
  // extension would look broken.
  const componentList = components || [
    { name: 'streaming', versions: [{ version: '25.2', asciidoc: { attributes: {} } }, { version: '26.2', asciidoc: { attributes: {} } }] },
    { name: 'cloud-data-platform', versions: [{ version: '', asciidoc: { attributes: {} } }] },
  ];
  const catalog = { getComponents: async () => componentList };

  ext.register.call(ctx, { config: { mapping_file: file } });
  return {
    run: () => listeners.contentClassified({ contentCatalog: catalog }),
    // playbookBuilt is the 404 page's only channel. Antora derives the site UI
    // model from the playbook, so site.keys set here reaches every page whether
    // or not it belongs to a component.
    runPlaybook: (playbook = {}) => { listeners.playbookBuilt({ playbook }); return playbook; },
    // beforePublish publishes the mapping as a site asset for the /api/ proxy.
    runPublish: () => { const added = []; listeners.beforePublish({ siteCatalog: { addFile: (f) => added.push(f) } }); return added; },
    catalog,
    logs,
    attrsOf: async () => componentList.flatMap((c) => c.versions.filter((v) => v.asciidoc).map((v) => v.asciidoc.attributes)),
  };
}

describe('validateMapping', () => {
  it('accepts a well-formed mapping', () => {
    expect(validateMapping(GOOD)).toBeNull();
  });

  it('rejects a dangling default_segment, which would disable scoping site-wide', () => {
    // The helper uses default_segment for EVERY unversioned page, so a dangling
    // default silently unscopes most of the site.
    const bad = { ...GOOD, default_segment: 'gone' };
    expect(validateMapping(bad)).toMatch(/default_segment "gone" is not one of the segments/);
  });

  it('rejects a segment with no group_id', () => {
    const bad = { ...GOOD, segments: { ...GOOD.segments, '25.2': { group_name: '25.2' } } };
    expect(validateMapping(bad)).toMatch(/missing group_id: 25\.2/);
  });

  it('rejects empty, shapeless and missing input', () => {
    expect(validateMapping(null)).toMatch(/not an object/);
    expect(validateMapping('x')).toMatch(/not an object/);
    expect(validateMapping({})).toMatch(/no segments/);
    expect(validateMapping({ segments: {} })).toMatch(/segments is empty/);
    expect(validateMapping({ segments: GOOD.segments })).toMatch(/no default_segment/);
  });
});

describe('the extension sets the attribute', () => {
  it('sets it on every component version, versioned and unversioned alike', async () => {
    // Unversioned components need it too: their pages resolve to default_segment.
    const h = harness();
    await h.run();
    const attrs = await h.attrsOf();
    expect(attrs).toHaveLength(3);
    for (const a of attrs) expect(JSON.parse(a[ATTRIBUTE_NAME])).toEqual(GOOD);
  });

  it('serialises to a string, which is what survives Antora attribute handling', async () => {
    const h = harness();
    await h.run();
    const [first] = await h.attrsOf();
    expect(typeof first[ATTRIBUTE_NAME]).toBe('string');
  });

  it('logs what it did, including the segment count and default', async () => {
    const h = harness();
    await h.run();
    expect(h.logs.info.join('\n')).toMatch(/set kapa-source-groups on 3 component version\(s\).*2 version segments, default "current"/s);
  });

  it('does not clobber an explicit override from a playbook or antora.yml', async () => {
    const components = [{ name: 'streaming', versions: [{ version: '25.2', asciidoc: { attributes: { [ATTRIBUTE_NAME]: 'preset' } } }] }];
    const h = harness({ components });
    await h.run();
    const [attrs] = await h.attrsOf();
    expect(attrs[ATTRIBUTE_NAME]).toBe('preset');
  });

  it('tolerates a component version with no asciidoc block', async () => {
    const components = [{ name: 'weird', versions: [{ version: '1' }, { version: '2', asciidoc: { attributes: {} } }] }];
    const h = harness({ components });
    await expect(h.run()).resolves.not.toThrow();
  });
});

describe('the extension degrades rather than setting something wrong', () => {
  const expectUnset = async (h) => {
    await h.run();
    for (const a of await h.attrsOf()) expect(a[ATTRIBUTE_NAME]).toBeUndefined();
  };

  it('warns and sets nothing when the mapping file is absent', async () => {
    const h = harness({ missingFile: true });
    await expectUnset(h);
    expect(h.logs.warn.join()).toMatch(/not found.*Generate it with: doc-tools generate kapa-source-groups/s);
  });

  it('warns and sets nothing on malformed JSON', async () => {
    const h = harness({ raw: '{not json' });
    await expectUnset(h);
    expect(h.logs.warn.join()).toMatch(/Could not read/);
  });

  it('warns and sets nothing when the mapping is structurally unusable', async () => {
    const h = harness({ mapping: { ...GOOD, default_segment: 'gone' } });
    await expectUnset(h);
    expect(h.logs.warn.join()).toMatch(/unusable \(default_segment "gone"/);
  });

  it('never throws out of contentClassified, since that would fail the whole build', async () => {
    for (const opts of [{ missingFile: true }, { raw: '{' }, { mapping: {} }, { mapping: null }]) {
      const h = harness(opts);
      await expect(h.run()).resolves.not.toThrow();
    }
  });

  it('always says what the consequence is, so a warning is actionable', async () => {
    for (const opts of [{ missingFile: true }, { raw: '{' }, { mapping: { segments: {} } }]) {
      const h = harness(opts);
      await h.run();
      expect(h.logs.warn.join()).toMatch(/Ask AI will search every docs version/);
    }
  });
});

describe('the extension also publishes via site.keys, for pages with no component', () => {
  // 404.hbs renders the Ask AI panel but has no page.component and no
  // page.componentVersion, so the component-version attribute never reaches it.
  // Its layout pulls in head and header, both of which already read site.keys.
  // Verified in a real Antora build: before this hook 404.html emitted
  // window.KAPA_SOURCE_GROUP_IDS = [], meaning Ask AI searched all nine versions
  // from the one page where a reader is most likely to ask where something went.

  it('sets site.keys on the playbook', () => {
    const h = harness();
    const playbook = h.runPlaybook();
    expect(JSON.parse(playbook.site.keys[ATTRIBUTE_NAME])).toEqual(GOOD);
  });

  it('creates site and site.keys when the playbook has neither', () => {
    // A minimal playbook has no site.keys at all, and throwing here would fail
    // the whole build before a single page rendered.
    const h = harness();
    expect(() => h.runPlaybook({})).not.toThrow();
    const playbook = h.runPlaybook({ site: {} });
    expect(playbook.site.keys[ATTRIBUTE_NAME]).toBeDefined();
  });

  it('preserves other site.keys rather than replacing the object', () => {
    // header-scripts, announcement-bar and head-meta all read site.keys.
    // Clobbering it would silently disable them.
    const h = harness();
    const playbook = h.runPlaybook({ site: { keys: { google_analytics: 'G-XYZ' } } });
    expect(playbook.site.keys.google_analytics).toBe('G-XYZ');
    expect(playbook.site.keys[ATTRIBUTE_NAME]).toBeDefined();
  });

  it('does not clobber an explicit playbook override', () => {
    const h = harness();
    const playbook = h.runPlaybook({ site: { keys: { [ATTRIBUTE_NAME]: 'preset' } } });
    expect(playbook.site.keys[ATTRIBUTE_NAME]).toBe('preset');
  });

  it('sets nothing when the mapping is unusable, matching the other hook', () => {
    for (const opts of [{ missingFile: true }, { raw: '{' }, { mapping: { segments: {} } }]) {
      const h = harness(opts);
      const playbook = h.runPlaybook();
      expect(playbook.site && playbook.site.keys && playbook.site.keys[ATTRIBUTE_NAME]).toBeUndefined();
    }
  });
});

describe('the extension publishes a site asset for the /api/ proxy', () => {
  // /api/ is Bump.sh HTML assembled by docs-site's proxy-api-docs edge function.
  // It has no Antora page context and cannot import from node_modules, so it
  // reads the default group from this asset at request time. Hardcoding the UUID
  // into docs-ui's static widget context instead would be a second copy of the
  // mapping that drifts the first time a Kapa group is recreated.

  it('writes the mapping next to assets/widgets, which the proxy already fetches', () => {
    const h = harness();
    const [file] = h.runPublish();
    expect(file.out.path).toBe(`${ASSET_DIR}/${ASSET_FILENAME}`);
    expect(JSON.parse(file.contents.toString('utf8'))).toEqual(GOOD);
  });

  it('publishes exactly one file', () => {
    expect(harness().runPublish()).toHaveLength(1);
  });

  it('publishes nothing when the mapping is unusable', () => {
    // The proxy treats a missing asset as "send no filter", so failing closed
    // here degrades /api/ to today's behaviour rather than to a wrong group.
    for (const opts of [{ missingFile: true }, { raw: '{' }, { mapping: { segments: {} } }]) {
      expect(harness(opts).runPublish()).toHaveLength(0);
    }
  });

  it('never throws out of beforePublish, which would fail the build at the last step', () => {
    for (const opts of [{ missingFile: true }, { raw: '{' }, { mapping: null }]) {
      expect(() => harness(opts).runPublish()).not.toThrow();
    }
  });
});

describe('the shipped mapping is usable by this extension', () => {
  it('docs-data/kapa-source-groups.json passes validation', () => {
    // Guards the real committed artifact, not just fixtures.
    const real = JSON.parse(fs.readFileSync(ext.DEFAULT_MAPPING_PATH, 'utf8'));
    expect(validateMapping(real)).toBeNull();
  });
});
