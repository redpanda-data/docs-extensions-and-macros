'use strict';

/**
 * Tests for CGO connector diff logic
 * Covers the fix for false "removed connectors" reports
 */

const { generateConnectorDiffJson } = require('../../tools/redpanda-connect/report-delta');

describe('CGO Connector Diff - Platform Metadata Preservation', () => {
  test('should preserve requiresCgo metadata in buildComponentMap', () => {
    const oldIndex = {
      inputs: [
        {
          name: 'tigerbeetle_cdc',
          type: 'input',
          status: 'stable',
          requiresCgo: true,
          cloudSupported: false,
          config: { children: [] }
        }
      ]
    };

    const newIndex = {
      inputs: [
        {
          name: 'tigerbeetle_cdc',
          type: 'input',
          status: 'stable',
          requiresCgo: true,
          cloudSupported: false,
          config: { children: [] }
        }
      ]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.85.0',
      newVersion: '4.86.0'
    });

    // Should not report as removed when metadata matches
    expect(diff.summary.removedComponents).toBe(0);
    expect(diff.details.removedComponents).toHaveLength(0);
  });

  test('should not report CGO connectors as removed when both versions have them', () => {
    const cgoConnectors = [
      { name: 'tigerbeetle_cdc', type: 'input', status: 'stable', requiresCgo: true, config: { children: [] } },
      { name: 'zmq4', type: 'input', status: 'stable', requiresCgo: true, config: { children: [] } },
      { name: 'ffi', type: 'processor', status: 'stable', requiresCgo: true, config: { children: [] } }
    ];

    const oldIndex = {
      inputs: cgoConnectors.filter(c => c.type === 'input'),
      processors: cgoConnectors.filter(c => c.type === 'processor')
    };

    const newIndex = {
      inputs: cgoConnectors.filter(c => c.type === 'input'),
      processors: cgoConnectors.filter(c => c.type === 'processor')
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.85.0',
      newVersion: '4.86.0'
    });

    expect(diff.summary.removedComponents).toBe(0);
  });

  test('should detect new connector correctly with platform metadata', () => {
    const oldIndex = {
      processors: [
        { name: 'split', type: 'processor', status: 'stable', config: { children: [] } }
      ]
    };

    const newIndex = {
      processors: [
        { name: 'split', type: 'processor', status: 'stable', config: { children: [] } },
        { name: 'string_split', type: 'processor', status: 'stable', cloudSupported: true, config: { children: [] } }
      ]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.85.0',
      newVersion: '4.86.0'
    });

    expect(diff.summary.newComponents).toBe(1);
    expect(diff.details.newComponents).toHaveLength(1);
    expect(diff.details.newComponents[0].name).toBe('string_split');
  });

  test('should detect actual removals correctly', () => {
    const oldIndex = {
      inputs: [
        { name: 'deprecated_input', type: 'input', status: 'stable', config: { children: [] } },
        { name: 'kafka', type: 'input', status: 'stable', config: { children: [] } }
      ]
    };

    const newIndex = {
      inputs: [
        { name: 'kafka', type: 'input', status: 'stable', config: { children: [] } }
      ]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.85.0',
      newVersion: '4.86.0'
    });

    expect(diff.summary.removedComponents).toBe(1);
    expect(diff.details.removedComponents).toHaveLength(1);
    expect(diff.details.removedComponents[0].name).toBe('deprecated_input');
  });

  test('should preserve cloudSupported and cloudOnly metadata', () => {
    const oldIndex = {
      processors: [
        { name: 'cloud_only_processor', type: 'processor', status: 'stable', cloudOnly: true, config: { children: [] } }
      ]
    };

    const newIndex = {
      processors: [
        { name: 'cloud_only_processor', type: 'processor', status: 'stable', cloudOnly: true, config: { children: [] } }
      ]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.85.0',
      newVersion: '4.86.0'
    });

    expect(diff.summary.removedComponents).toBe(0);
  });

  test('should handle mixed CGO and OSS connectors correctly', () => {
    const oldIndex = {
      inputs: [
        { name: 'kafka', type: 'input', status: 'stable', cloudSupported: true, config: { children: [] } },
        { name: 'tigerbeetle_cdc', type: 'input', status: 'stable', requiresCgo: true, config: { children: [] } },
        { name: 'http_server', type: 'input', status: 'stable', cloudSupported: true, config: { children: [] } }
      ]
    };

    const newIndex = {
      inputs: [
        { name: 'kafka', type: 'input', status: 'stable', cloudSupported: true, config: { children: [] } },
        { name: 'tigerbeetle_cdc', type: 'input', status: 'stable', requiresCgo: true, config: { children: [] } },
        { name: 'http_server', type: 'input', status: 'stable', cloudSupported: true, config: { children: [] } }
      ]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.85.0',
      newVersion: '4.86.0'
    });

    expect(diff.summary.removedComponents).toBe(0);
    expect(diff.summary.newComponents).toBe(0);
  });
});

describe('CGO Connector Diff - Asymmetric Augmentation Scenario', () => {
  test('should handle old augmented vs new non-augmented correctly (the original bug)', () => {
    // Scenario: Old data has CGO metadata, new data doesn't (CGO analysis failed)
    const oldIndex = {
      inputs: [
        { name: 'kafka', type: 'input', status: 'stable', config: { children: [] } },
        { name: 'tigerbeetle_cdc', type: 'input', status: 'stable', requiresCgo: true, config: { children: [] } }
      ]
    };

    const newIndex = {
      inputs: [
        { name: 'kafka', type: 'input', status: 'stable', config: { children: [] } }
        // tigerbeetle_cdc not in new because it wasn't augmented
      ]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.85.0',
      newVersion: '4.86.0'
    });

    // This would have reported tigerbeetle_cdc as removed (the bug)
    // After fix, we handle this via fallback stripping in the handler
    expect(diff.summary.removedComponents).toBe(1);
  });

  test('should detect new field additions correctly', () => {
    const oldIndex = {
      inputs: [
        {
          name: 'kafka',
          type: 'input',
          status: 'stable',
          config: {
            children: [
              { name: 'address', type: 'string' }
            ]
          }
        }
      ]
    };

    const newIndex = {
      inputs: [
        {
          name: 'kafka',
          type: 'input',
          status: 'stable',
          config: {
            children: [
              { name: 'address', type: 'string' },
              { name: 'timeout', type: 'string' }
            ]
          }
        }
      ]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.85.0',
      newVersion: '4.86.0'
    });

    expect(diff.summary.newFields).toBe(1);
  });
});

describe('CGO Connector Diff - Edge Cases', () => {
  test('should handle empty old index (all new connectors)', () => {
    const oldIndex = { inputs: [] };
    const newIndex = {
      inputs: [
        { name: 'kafka', type: 'input', status: 'stable', config: { children: [] } }
      ]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.85.0',
      newVersion: '4.86.0'
    });

    expect(diff.summary.newComponents).toBe(1);
    expect(diff.summary.removedComponents).toBe(0);
  });

  test('should handle empty new index (all removed connectors)', () => {
    const oldIndex = {
      inputs: [
        { name: 'kafka', type: 'input', status: 'stable', config: { children: [] } }
      ]
    };
    const newIndex = { inputs: [] };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.85.0',
      newVersion: '4.86.0'
    });

    expect(diff.summary.newComponents).toBe(0);
    expect(diff.summary.removedComponents).toBe(1);
  });

  test('should handle missing config/fields gracefully', () => {
    const oldIndex = {
      inputs: [
        { name: 'test_input', type: 'input', status: 'stable' }
      ]
    };
    const newIndex = {
      inputs: [
        { name: 'test_input', type: 'input', status: 'stable' }
      ]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.85.0',
      newVersion: '4.86.0'
    });

    expect(diff.summary.removedComponents).toBe(0);
    expect(diff.summary.newComponents).toBe(0);
  });

  test('should handle multiple connector types simultaneously', () => {
    const oldIndex = {
      inputs: [{ name: 'kafka', type: 'input', status: 'stable', config: { children: [] } }],
      outputs: [{ name: 's3', type: 'output', status: 'stable', config: { children: [] } }],
      processors: [{ name: 'mapping', type: 'processor', status: 'stable', config: { children: [] } }]
    };

    const newIndex = {
      inputs: [
        { name: 'kafka', type: 'input', status: 'stable', config: { children: [] } },
        { name: 'mqtt', type: 'input', status: 'stable', config: { children: [] } }
      ],
      outputs: [{ name: 's3', type: 'output', status: 'stable', config: { children: [] } }],
      processors: [
        { name: 'mapping', type: 'processor', status: 'stable', config: { children: [] } },
        { name: 'string_split', type: 'processor', status: 'stable', config: { children: [] } }
      ]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.85.0',
      newVersion: '4.86.0'
    });

    expect(diff.summary.newComponents).toBe(2); // mqtt input + string_split processor
    expect(diff.summary.removedComponents).toBe(0);
  });
});

describe('CGO Connector Diff - Deprecation Detection', () => {
  test('should detect deprecated connectors', () => {
    const oldIndex = {
      inputs: [
        { name: 'kafka', type: 'input', status: 'stable', config: { children: [] } }
      ]
    };

    const newIndex = {
      inputs: [
        { name: 'kafka', type: 'input', status: 'deprecated', config: { children: [] } }
      ]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.85.0',
      newVersion: '4.86.0'
    });

    expect(diff.summary.deprecatedComponents).toBe(1);
  });

  test('should detect deprecated fields', () => {
    const oldIndex = {
      inputs: [
        {
          name: 'kafka',
          type: 'input',
          status: 'stable',
          config: {
            children: [
              { name: 'address', type: 'string', status: 'stable' }
            ]
          }
        }
      ]
    };

    const newIndex = {
      inputs: [
        {
          name: 'kafka',
          type: 'input',
          status: 'stable',
          config: {
            children: [
              { name: 'address', type: 'string', status: 'deprecated' }
            ]
          }
        }
      ]
    };

    const diff = generateConnectorDiffJson(oldIndex, newIndex, {
      oldVersion: '4.85.0',
      newVersion: '4.86.0'
    });

    expect(diff.summary.deprecatedFields).toBe(1);
  });
});
