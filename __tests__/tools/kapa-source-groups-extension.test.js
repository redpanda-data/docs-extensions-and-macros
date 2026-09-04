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
const { validateMapping, ATTRIBUTE_NAME } = ext;

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

describe('the shipped mapping is usable by this extension', () => {
  it('docs-data/kapa-source-groups.json passes validation', () => {
    // Guards the real committed artifact, not just fixtures.
    const real = JSON.parse(fs.readFileSync(ext.DEFAULT_MAPPING_PATH, 'utf8'));
    expect(validateMapping(real)).toBeNull();
  });
});
