'use strict';

const { generateConnectorDiffJson } = require('../../tools/redpanda-connect/report-delta');

const output = (fieldOverrides) => ({
  outputs: [{
    name: 'kafka_franz',
    type: 'output',
    status: 'stable',
    config: { children: [{ name: 'compression', type: 'string', kind: 'scalar', ...fieldOverrides }] }
  }]
});

const diff = (oldField, newField) =>
  generateConnectorDiffJson(output(oldField), output(newField), { oldVersion: '4.113.0', newVersion: '4.113.1' });

describe('connector diff default values', () => {
  test('a field that starts stating its default is not a default change', () => {
    const d = diff({}, { default: 'snappy' });
    expect(d.summary.changedDefaults).toBe(0);
    expect(d.details.changedDefaults).toEqual([]);
    expect(d.summary.documentedDefaults).toBe(1);
    expect(d.details.documentedDefaults[0]).toMatchObject({ field: 'compression', newDefault: 'snappy' });
  });

  test('a changed default is still reported', () => {
    const d = diff({ default: 'none' }, { default: 'snappy' });
    expect(d.summary.changedDefaults).toBe(1);
    expect(d.details.changedDefaults[0]).toMatchObject({ oldDefault: 'none', newDefault: 'snappy' });
    expect(d.summary.documentedDefaults).toBe(0);
  });

  test('a removed default is still reported', () => {
    const d = diff({ default: 'snappy' }, {});
    expect(d.summary.changedDefaults).toBe(1);
    expect(d.details.changedDefaults[0].newDefault).toBeUndefined();
  });
});
