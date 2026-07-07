'use strict';

/**
 * Tests for whats-new description summarization and config-component
 * platform metadata in the Redpanda Connect docs generator.
 *
 * Covers two bugs observed in rp-connect-docs auto-docs PR output:
 * 1. capToTwoSentences truncated descriptions containing Antora xref
 *    macros (periods inside try.adoc / catch.adoc broke sentence
 *    splitting, discarding all leading text).
 * 2. config-type components (e.g. error_handling) never received a
 *    cloudSupported flag from binary analysis, so the diff JSON marked
 *    them cloudSupported: false while binaryAnalysis.details listed
 *    them as cloud-supported.
 */

// The handler transitively requires the Octokit client (ESM-only under
// Jest); stub it out since these tests never touch GitHub.
jest.mock('../../cli-utils/octokit-client', () => ({}));

const { capToTwoSentences, augmentConnectorData } = require('../../tools/redpanda-connect/rpcn-connector-docs-handler');
const { generateConnectorDiffJson } = require('../../tools/redpanda-connect/report-delta');

describe('capToTwoSentences - xref and filename protection', () => {
  test('does not truncate descriptions containing xref macros', () => {
    const description = 'This processor combines the behaviour of the xref:components:processors/try.adoc[`try`] and xref:components:processors/catch.adoc[`catch`] processors into a single block with an explicit recovery path. Because it contains both the fallible step and its recovery within a single processor, it is the recommended way to handle expected errors when strict error handling is enabled.';

    const result = capToTwoSentences(description);

    // The regression produced the fragment "adoc[`catch`] processors into..."
    expect(result.startsWith('This processor combines')).toBe(true);
    expect(result).toContain('xref:components:processors/try.adoc[`try`]');
    expect(result).toContain('xref:components:processors/catch.adoc[`catch`]');
    expect(result.startsWith('adoc[')).toBe(false);
  });

  test('splits at real sentence boundaries around bare filenames', () => {
    const description = 'Reads settings from config.yaml at startup. Changes require a restart. A third sentence should be dropped.';

    const result = capToTwoSentences(description);

    expect(result).toBe('Reads settings from config.yaml at startup. Changes require a restart.');
  });

  test('keeps leading text when an unprotected mid-token period precedes the first boundary', () => {
    const description = 'Uses internal.token values here. Second sentence follows.';

    const result = capToTwoSentences(description);

    expect(result.startsWith('Uses internal.token values here.')).toBe(true);
  });

  test('still caps plain descriptions to two sentences', () => {
    const description = 'First sentence. Second sentence. Third sentence.';

    expect(capToTwoSentences(description)).toBe('First sentence. Second sentence.');
  });
});

describe('augmentConnectorData - config components', () => {
  const binaryAnalysis = {
    comparison: {
      inCloud: [
        { type: 'processors', name: 'mapping', status: 'stable' },
        { type: 'config', name: 'error_handling', status: '' }
      ]
    },
    cgoOnly: []
  };

  test('stamps cloudSupported on config components found in the cloud binary', () => {
    const connectorData = {
      processors: [{ name: 'mapping', type: 'processor', status: 'stable' }],
      config: [{ name: 'error_handling', type: 'object', kind: 'scalar' }]
    };

    const { augmentedData } = augmentConnectorData(connectorData, binaryAnalysis);

    const errorHandling = augmentedData.config.find(c => c.name === 'error_handling');
    expect(errorHandling.cloudSupported).toBe(true);
    expect(errorHandling.requiresCgo).toBe(false);
  });

  test('marks config components absent from the cloud binary as not cloud supported', () => {
    const connectorData = {
      config: [{ name: 'self_managed_only_block', type: 'object', kind: 'scalar' }]
    };

    const { augmentedData } = augmentConnectorData(connectorData, binaryAnalysis);

    const block = augmentedData.config.find(c => c.name === 'self_managed_only_block');
    expect(block.cloudSupported).toBe(false);
  });
});

describe('generateConnectorDiffJson - config component status and cloud support', () => {
  test('new config component without a status does not report its type as status', () => {
    const oldIndex = { config: [] };
    const newIndex = {
      config: [
        {
          name: 'error_handling',
          type: 'object',
          kind: 'scalar',
          description: 'Configures engine-wide error handling behaviour.',
          cloudSupported: true
        }
      ]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.97.0',
      newVersion: '4.98.0'
    });

    const added = diff.details.newComponents.find(c => c.name === 'error_handling');
    expect(added).toBeDefined();
    expect(added.status).toBe('');
    expect(added.status).not.toBe('object');
    expect(added.cloudSupported).toBe(true);
  });

  test('diff component entry agrees with binaryAnalysis cloud-supported details', () => {
    const oldIndex = { config: [] };
    const newIndex = {
      config: [
        {
          name: 'error_handling',
          type: 'object',
          kind: 'scalar',
          description: 'Configures engine-wide error handling behaviour.',
          cloudSupported: true
        }
      ]
    };
    const binaryAnalysis = {
      ossVersion: '4.98.0',
      cloudVersion: '4.98.0',
      comparison: {
        inCloud: [{ type: 'config', name: 'error_handling', status: '' }],
        ossOnly: [],
        cloudOnly: []
      }
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.97.0',
      newVersion: '4.98.0',
      binaryAnalysis
    });

    const added = diff.details.newComponents.find(c => c.name === 'error_handling');
    const inDetails = (diff.binaryAnalysis.details.cloudSupported || [])
      .some(c => c.type === 'config' && c.name === 'error_handling');

    expect(inDetails).toBe(true);
    expect(added.cloudSupported).toBe(true);
  });
});
