'use strict';

const { generateConnectorDiffJson } = require('../../tools/redpanda-connect/report-delta.js');

// What's new describes a new component with its summary and falls back to the
// description, so the diff has to carry both.
describe('connector diff for new components', () => {
  test('includes the summary and the description', () => {
    const oldIndex = { inputs: [] };
    const newIndex = {
      inputs: [{
        name: 'probe', type: 'input', status: 'stable', version: '4.111.0',
        summary: 'Reads probes.', description: 'Reads probes from a source. More detail follows.',
        config: { children: [] },
      }],
    };
    const diff = generateConnectorDiffJson(oldIndex, newIndex, { oldVersion: '4.110.0', newVersion: '4.111.0' });
    expect(diff.details.newComponents).toEqual([
      expect.objectContaining({ name: 'probe', summary: 'Reads probes.', description: 'Reads probes from a source. More detail follows.' }),
    ]);
  });
});
