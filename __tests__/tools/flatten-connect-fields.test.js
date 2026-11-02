'use strict';

const {
  flattenConnectFields,
  connectFieldName
} = require('../../tools/redpanda-connect/helpers/flattenConnectFields');

describe('connectFieldName', () => {
  test('marks an array-of-object field with []', () => {
    expect(connectFieldName({ name: 'sasl', kind: 'array', type: 'object' })).toBe('sasl[]');
  });

  test('leaves a name that already carries the marker alone', () => {
    expect(connectFieldName({ name: 'sasl[]', kind: 'array' })).toBe('sasl[]');
  });

  test('leaves a scalar field alone', () => {
    expect(connectFieldName({ name: 'bucket', kind: 'scalar' })).toBe('bucket');
  });
});

describe('flattenConnectFields', () => {
  const tree = [
    { name: 'bucket', kind: 'scalar' },
    {
      name: 'sasl',
      kind: 'array',
      type: 'object',
      children: [
        { name: 'mechanism', kind: 'scalar' },
        { name: 'aws', kind: 'scalar', children: [{ name: 'tcp', kind: 'scalar' }] }
      ]
    }
  ];

  test('returns every field in the tree, depth first, as a dotted path', () => {
    expect(flattenConnectFields(tree).map(f => f.path)).toEqual([
      'bucket',
      'sasl',
      'sasl.mechanism',
      'sasl.aws',
      'sasl.aws.tcp'
    ]);
  });

  test('keeps the [] array marker when asked, all the way down the path', () => {
    expect(flattenConnectFields(tree, { arrayMarker: true }).map(f => f.path)).toEqual([
      'bucket',
      'sasl[]',
      'sasl[].mechanism',
      'sasl[].aws',
      'sasl[].aws.tcp'
    ]);
  });

  test('reports the parent path so callers can spot a descendant of another field', () => {
    const byPath = new Map(flattenConnectFields(tree).map(f => [f.path, f.parentPath]));

    expect(byPath.get('bucket')).toBeNull();
    expect(byPath.get('sasl')).toBeNull();
    expect(byPath.get('sasl.mechanism')).toBe('sasl');
    expect(byPath.get('sasl.aws.tcp')).toBe('sasl.aws');
  });

  test('returns the field object alongside its path', () => {
    const entry = flattenConnectFields(tree).find(f => f.path === 'sasl.mechanism');

    expect(entry.field).toBe(tree[1].children[0]);
    expect(entry.name).toBe('mechanism');
  });

  test('skips deprecated fields and their subtrees when asked', () => {
    const withDeprecated = [
      { name: 'live', kind: 'scalar' },
      {
        name: 'legacy',
        kind: 'scalar',
        is_deprecated: true,
        children: [{ name: 'nested', kind: 'scalar' }]
      }
    ];

    expect(flattenConnectFields(withDeprecated, { skipDeprecated: true }).map(f => f.path))
      .toEqual(['live']);
    expect(flattenConnectFields(withDeprecated).map(f => f.path))
      .toEqual(['live', 'legacy', 'legacy.nested']);
  });

  test('skips a nameless node and its subtree, because it gets no heading', () => {
    const withNameless = [
      { name: 'kept', kind: 'scalar' },
      { kind: 'scalar', children: [{ name: 'orphan', kind: 'scalar' }] }
    ];

    expect(flattenConnectFields(withNameless).map(f => f.path)).toEqual(['kept']);
  });

  test('tolerates missing or non-array input', () => {
    expect(flattenConnectFields(undefined)).toEqual([]);
    expect(flattenConnectFields(null)).toEqual([]);
    expect(flattenConnectFields({})).toEqual([]);
  });
});
