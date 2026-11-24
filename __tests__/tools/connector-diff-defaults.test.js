'use strict';

const { generateConnectorDiffJson, printDeltaReport } = require('../../tools/redpanda-connect/report-delta');
const { generatePRSummary, generateMultiVersionPRSummary } = require('../../tools/redpanda-connect/pr-summary-formatter');

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

// A release whose only change is a newly stated default (4.113.0 to 4.113.1)
// must still say so, not print empty sections.
describe('PR summaries list newly stated defaults', () => {
  const d = diff({}, { default: 'snappy' });

  test('the single-version summary lists the field instead of an empty summary', () => {
    const summary = generatePRSummary(d);
    expect(summary).toContain('**1** newly stated default value (no behavior change expected)');
    expect(summary).toContain('#### Newly Stated Defaults');
    expect(summary).toContain('- `outputs:kafka_franz.compression`: `"snappy"`');
    expect(summary).not.toContain('default value change');
  });

  test('the multi-version summary lists the field under its release', () => {
    const summary = generateMultiVersionPRSummary({
      metadata: { startVersion: '4.113.0', endVersion: '4.113.1', processedReleases: 1 },
      totalSummary: { versions: ['4.113.1'], releaseCount: 1, documentedDefaults: 1 },
      releases: [{ fromVersion: '4.113.0', toVersion: '4.113.1', summary: d.summary, details: d.details }]
    });
    const release = summary.slice(summary.indexOf('#### Version 4.113.1'));
    expect(summary).toContain('- **1** newly stated default values');
    expect(release).toContain('**Newly Stated Defaults (1):**');
    expect(release).toContain('- `outputs:kafka_franz.compression`: `"snappy"`');
    expect(release).not.toContain('_No documentation changes in this release_');
  });
});

describe('console delta report', () => {
  test('a removed default prints as no default, not undefined', () => {
    const lines = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a) => lines.push(a.join(' ')));
    try {
      printDeltaReport(output({ default: 'snappy' }), output({}), { newVersion: '4.113.1' });
    } finally {
      spy.mockRestore();
    }
    const report = lines.join('\n');
    expect(report).toContain('New: no default');
    expect(report).not.toContain('undefined');
  });
});
