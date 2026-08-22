'use strict';

const { collectGeneratorReports } = require('../../tools/redpanda-connect/pr-summary-formatter.js');

describe('collectGeneratorReports', () => {
  const accumulators = () => ({ descriptionReports: [], lostSectionWarnings: [] });

  test('collects every report key the generator returns', () => {
    const into = accumulators();
    collectGeneratorReports({
      descriptionReports: [{ connector: 'outputs/x', message: 'structure' }],
      lostSectionWarnings: [{ partial: 'p.adoc', sections: ['Caveats'] }],
    }, into);

    // Both call sites feed the PR summary through this function, so a key
    // dropped here is a key missing from the summary. The draft call site
    // used to push lostSectionWarnings inline and forget descriptionReports,
    // which is why the structure reports for newly drafted connectors never
    // reached the summary.
    expect(into.descriptionReports).toEqual([{ connector: 'outputs/x', message: 'structure' }]);
    expect(into.lostSectionWarnings).toEqual([{ partial: 'p.adoc', sections: ['Caveats'] }]);
  });

  test('accumulates across the partials and drafts call sites', () => {
    const into = accumulators();
    collectGeneratorReports({ descriptionReports: [{ connector: 'a', message: 'm1' }] }, into);
    collectGeneratorReports({ descriptionReports: [{ connector: 'b', message: 'm2' }] }, into);
    expect(into.descriptionReports.map((r) => r.connector)).toEqual(['a', 'b']);
  });

  test('tolerates a missing result and missing keys', () => {
    const into = accumulators();
    expect(collectGeneratorReports(undefined, into)).toBe(into);
    collectGeneratorReports({}, into);
    expect(into).toEqual(accumulators());
  });
});
