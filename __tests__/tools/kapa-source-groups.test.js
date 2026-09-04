'use strict';

const {
  generateKapaSourceGroups,
  toList,
  idOf,
  flattenGroups,
} = require('../../tools/kapa-source-groups/generate-kapa-source-groups');

const PROJECT = '97f44223-f930-4fb9-ae1e-ecd436a4d85c';
const PARENT_ID = '238b3c08-5cf6-4615-937c-fa2f5a2e83a4';

const group = (id, name, type = 'version', sub_groups = []) => ({
  id, name, type, description: '', sub_groups,
  created_at: '2025-12-01T11:00:22.034679Z',
  updated_at: '2025-12-01T11:00:22.047252Z',
});

const source = (id, name, source_groups = [], type = 'scrape') => ({
  id, name, type, contains_internal_data: false,
  created_at: '2025-08-20T14:55:34.149741Z',
  updated_at: '2025-11-17T16:01:33.551670Z',
  source_groups,
});

/**
 * Fake Kapa API. Routes on the path so pagination and both endpoints behave the
 * way the live service does (observed 2026-09-04).
 */
function fakeApi ({ groups = [], sources = [], pageSize = null, status = 200 } = {}) {
  return async (url) => {
    if (status !== 200) {
      return { ok: false, status, statusText: 'Forbidden', json: async () => ({}) };
    }
    const isGroups = url.includes('/source-groups/');
    const all = isGroups ? groups : sources;
    const offset = Number(new URL(url).searchParams.get('offset') || 0);
    const slice = pageSize ? all.slice(offset, offset + pageSize) : all;
    const nextOffset = offset + slice.length;
    const next = pageSize && nextOffset < all.length
      ? `${url.split('?')[0]}?offset=${nextOffset}`
      : null;
    return {
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ count: all.length, next, previous: null, results: slice }),
    };
  };
}

const HEALTHY = {
  groups: [
    group(PARENT_ID, 'Self-Managed', 'product', [
      group('g-242', '24.2'),
      group('g-243', '24.3'),
      group('g-251', '25.1'),
      group('g-252', '25.2'),
      group('g-cur', 'current'),
    ]),
  ],
  sources: [
    source('s-242', 'Documentation (24.2)', [{ id: 'g-242', name: '24.2' }]),
    source('s-243', 'Documentation (24.3)', [{ id: 'g-243', name: '24.3' }]),
    source('s-251', 'Documentation (25.1)', [{ id: 'g-251', name: '25.1' }]),
    source('s-252', 'Documentation (25.2)', [{ id: 'g-252', name: '25.2' }]),
    source('s-cur', 'Documentation (current)', [{ id: 'g-cur', name: 'current' }]),
    source('s-adp', 'Agentic Data Plane', []),
    source('s-cloud', 'Documentation (Cloud)', []),
    source('s-api', 'Admin API', [], 'openapi'),
  ],
};

const run = (overrides = {}, opts = {}) =>
  generateKapaSourceGroups({
    apiKey: 'k', projectId: PROJECT,
    fetchImpl: fakeApi({ ...HEALTHY, ...overrides }),
    ...opts,
  });

describe('toList (works around Kapa declaring array fields as "string")', () => {
  it('passes arrays through', () => {
    expect(toList([{ id: 'a' }])).toEqual([{ id: 'a' }]);
  });
  it('treats null, undefined and empty string as empty', () => {
    for (const v of [null, undefined, '']) expect(toList(v)).toEqual([]);
  });
  it('splits a comma-separated id string, tolerating spaces', () => {
    expect(toList('a, b ,c')).toEqual(['a', 'b', 'c']);
  });
  it('wraps a bare object', () => {
    expect(toList({ id: 'a' })).toEqual([{ id: 'a' }]);
  });
});

describe('idOf', () => {
  it('reads an object id or a bare string, and survives junk', () => {
    expect(idOf({ id: 'x' })).toBe('x');
    expect(idOf('x')).toBe('x');
    expect(idOf(null)).toBeNull();
    expect(idOf({})).toBeNull();
  });
});

describe('flattenGroups', () => {
  it('descends sub_groups, since Kapa exposes no parent_id anywhere', () => {
    const { parents, childrenByParentId } = flattenGroups(HEALTHY.groups);
    expect(parents.map((p) => p.name)).toContain('Self-Managed');
    expect(childrenByParentId.get(PARENT_ID).map((c) => c.name))
      .toEqual(['24.2', '24.3', '25.1', '25.2', 'current']);
  });
});

describe('generateKapaSourceGroups: healthy project', () => {
  it('maps every version segment to its group id', async () => {
    const m = JSON.parse(await run());
    expect(Object.keys(m.segments)).toEqual(['24.2', '24.3', '25.1', '25.2', 'current']);
    expect(m.segments['25.2'].group_id).toBe('g-252');
    expect(m.segments['25.2'].source_ids).toEqual(['s-252']);
  });

  it('records the parent group and its type', async () => {
    const m = JSON.parse(await run());
    expect(m.parent_group).toEqual({ id: PARENT_ID, name: 'Self-Managed', type: 'product' });
  });

  it('defaults to current, which is what unversioned pages scope to', async () => {
    expect(JSON.parse(await run()).default_segment).toBe('current');
  });

  it('records unassigned sources as the global set, including Agentic Data Plane', async () => {
    // The whole ADP-always-visible requirement rests on these staying unassigned.
    const m = JSON.parse(await run());
    expect(m.global_sources).toContain('Agentic Data Plane');
    expect(m.global_sources).toContain('Documentation (Cloud)');
    expect(m.global_sources).not.toContain('Documentation (25.2)');
  });

  it('is byte-stable across runs and independent of upstream ordering', async () => {
    // This file is diff-checked in CI, so "no changes" must mean "nothing changed
    // upstream" -- not "the generator reshuffled itself".
    const a = await run();
    const b = await run();
    expect(a).toBe(b);

    const shuffled = {
      groups: [group(PARENT_ID, 'Self-Managed', 'product', [
        group('g-cur', 'current'), group('g-252', '25.2'), group('g-242', '24.2'),
        group('g-251', '25.1'), group('g-243', '24.3'),
      ])],
      sources: [...HEALTHY.sources].reverse(),
    };
    expect(await run(shuffled)).toBe(a);
  });

  it('sorts segments numerically, so 25.2 does not sort before 25.10', async () => {
    const groups = [group(PARENT_ID, 'Self-Managed', 'product', [
      group('g-2510', '25.10'), group('g-252', '25.2'), group('g-cur', 'current'),
    ])];
    const sources = [
      source('s-2510', 'Documentation (25.10)', [{ id: 'g-2510' }]),
      source('s-252', 'Documentation (25.2)', [{ id: 'g-252' }]),
      source('s-cur', 'Documentation (current)', [{ id: 'g-cur' }]),
    ];
    const m = JSON.parse(await run({ groups, sources }));
    expect(Object.keys(m.segments)).toEqual(['25.2', '25.10', 'current']);
  });

  it('contains no timestamp (the reason cloud-regions cannot be diff-checked)', async () => {
    const raw = await run();
    expect(raw).not.toMatch(/generated_at|lastUpdated|"\d{4}-\d{2}-\d{2}T/);
  });

  it('ends with exactly one newline', async () => {
    const raw = await run();
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw.endsWith('\n\n')).toBe(false);
  });
});

describe('generateKapaSourceGroups: refuses to emit a misleading mapping', () => {
  it('fails when no groups exist at all', async () => {
    await expect(run({ groups: [], sources: [] }))
      .rejects.toThrow(/no source groups.*Manage groups/is);
  });

  it('fails when the parent has no sub groups (the real state before the dashboard work)', async () => {
    await expect(run({ groups: [group(PARENT_ID, 'Self-managed Latest', 'version', [])] }))
      .rejects.toThrow(/any sub groups.*Self-managed Latest/is);
  });

  it('fails when a version group has no sources assigned', async () => {
    // Worse than no group: scoping to it returns only global sources, so the
    // reader silently gets nothing version-specific.
    const sources = HEALTHY.sources.filter((s) => s.name !== 'Documentation (25.1)');
    await expect(run({ sources })).rejects.toThrow(/no sources assigned: 25\.1/);
  });

  it('names every empty group, not just the first', async () => {
    const sources = HEALTHY.sources.filter(
      (s) => !['Documentation (25.1)', 'Documentation (24.2)'].includes(s.name)
    );
    await expect(run({ sources })).rejects.toThrow(/24\.2, 25\.1/);
  });

  it('fails when the default segment is not one of the groups', async () => {
    await expect(run({}, { defaultSegment: 'nope' }))
      .rejects.toThrow(/Default segment "nope" is not one of the version groups/);
  });

  it('fails on an ambiguous parent rather than guessing', async () => {
    const groups = [
      group('p1', 'Self-Managed', 'product', [group('g-cur', 'current')]),
      group('p2', 'Cloud', 'product', [group('g-c1', 'current')]),
    ];
    await expect(run({ groups })).rejects.toThrow(/Ambiguous parent group.*--parent-group/s);
  });

  it('selects a named parent when asked, resolving ambiguity', async () => {
    const groups = [
      group('p1', 'Self-Managed', 'product', [group('g-cur', 'current')]),
      group('p2', 'Cloud', 'product', [group('g-c1', 'cloud-current')]),
    ];
    const sources = [source('s-cur', 'Documentation (current)', [{ id: 'g-cur' }])];
    const m = JSON.parse(await run({ groups, sources }, { parentGroupName: 'Self-Managed' }));
    expect(m.parent_group.name).toBe('Self-Managed');
  });

  it('fails clearly on a named parent that does not exist', async () => {
    await expect(run({}, { parentGroupName: 'Nope' }))
      .rejects.toThrow(/No source group named "Nope".*Self-Managed/s);
  });

  it('requires credentials', async () => {
    await expect(generateKapaSourceGroups({ projectId: PROJECT })).rejects.toThrow(/apiKey/);
    await expect(generateKapaSourceGroups({ apiKey: 'k' })).rejects.toThrow(/projectId/);
  });
});

describe('generateKapaSourceGroups: transport behaviour', () => {
  it('follows next, since the ingestion endpoints declare no pagination params', async () => {
    const m = JSON.parse(await run({ pageSize: 2 }));
    // All five groups and all eight sources must survive paging.
    expect(Object.keys(m.segments)).toHaveLength(5);
    expect(m.global_sources).toHaveLength(3);
  });

  it('adds an auth hint on 403, which is what a wrong-project key returns', async () => {
    await expect(run({ status: 403 }))
      .rejects.toThrow(/403.*KAPA_API_KEY is valid and belongs to the project/s);
  });

  it('tolerates Kapa fixing its schema to return comma-separated id strings', async () => {
    // sub_groups/source_groups are declared "type":"string" upstream. If they
    // ever actually become strings, the parser must not break.
    const groups = [{ ...group(PARENT_ID, 'Self-Managed', 'product'), sub_groups: [group('g-cur', 'current')] }];
    const sources = [source('s-cur', 'Documentation (current)', 'g-cur')];
    const m = JSON.parse(await run({ groups, sources }));
    expect(m.segments.current.source_ids).toEqual(['s-cur']);
  });
});
