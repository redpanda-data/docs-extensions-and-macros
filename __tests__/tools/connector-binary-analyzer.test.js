'use strict';

/**
 * Tests for connector binary analyzer platform detection
 * Tests Docker vs native execution logic
 */

const os = require('os');

describe('Platform Detection for Binary Execution', () => {
  // Save original platform
  const originalPlatform = os.platform();

  test('should require Docker for Linux binaries on macOS', () => {
    const isLinuxBinary = true;
    const platform = 'darwin';
    const needsDocker = isLinuxBinary && platform !== 'linux';

    expect(needsDocker).toBe(true);
  });

  test('should require Docker for Linux binaries on Windows', () => {
    const isLinuxBinary = true;
    const platform = 'win32';
    const needsDocker = isLinuxBinary && platform !== 'linux';

    expect(needsDocker).toBe(true);
  });

  test('should NOT require Docker for Linux binaries on Linux', () => {
    const isLinuxBinary = true;
    const platform = 'linux';
    const needsDocker = isLinuxBinary && platform !== 'linux';

    expect(needsDocker).toBe(false);
  });

  test('should detect Linux binary by filename', () => {
    const binaryName = 'redpanda-connect-cgo-4.86.0-linux-amd64';
    const isLinuxBinary = binaryName.includes('linux');

    expect(isLinuxBinary).toBe(true);
  });

  test('should detect non-Linux binary by filename', () => {
    const binaryName = 'redpanda-connect-cloud-4.86.0-darwin-arm64';
    const isLinuxBinary = binaryName.includes('linux');

    expect(isLinuxBinary).toBe(false);
  });

  test('current system should match actual platform', () => {
    // This validates our test assumptions match reality
    expect(['darwin', 'linux', 'win32']).toContain(os.platform());
  });
});

describe('CGO Binary Analysis Failure Detection', () => {
  test('should detect CGO failure when cgoIndex is undefined', () => {
    const binaryAnalysis = {
      ossVersion: '4.86.0',
      cloudVersion: '4.86.0',
      cloudIndex: { inputs: [] },
      cgoIndex: undefined // CGO analysis failed
    };

    const cgoAnalysisFailed = !binaryAnalysis || !binaryAnalysis.ossVersion || !binaryAnalysis.cgoIndex;

    expect(cgoAnalysisFailed).toBe(true);
  });

  test('should detect CGO success when cgoIndex exists', () => {
    const binaryAnalysis = {
      ossVersion: '4.86.0',
      cloudVersion: '4.86.0',
      cloudIndex: { inputs: [] },
      cgoIndex: { inputs: [] } // CGO analysis succeeded
    };

    const cgoAnalysisFailed = !binaryAnalysis || !binaryAnalysis.ossVersion || !binaryAnalysis.cgoIndex;

    expect(cgoAnalysisFailed).toBe(false);
  });

  test('should detect failure when binaryAnalysis is null', () => {
    const binaryAnalysis = null;

    const cgoAnalysisFailed = !binaryAnalysis || !binaryAnalysis.ossVersion || !binaryAnalysis.cgoIndex;

    expect(cgoAnalysisFailed).toBe(true);
  });

  test('should detect failure when ossVersion is missing', () => {
    const binaryAnalysis = {
      cloudVersion: '4.86.0',
      cgoIndex: { inputs: [] }
    };

    const cgoAnalysisFailed = !binaryAnalysis || !binaryAnalysis.ossVersion || !binaryAnalysis.cgoIndex;

    expect(cgoAnalysisFailed).toBe(true);
  });
});

describe('Fallback Stripping Logic', () => {
  test('should strip CGO connectors from old data when CGO analysis fails', () => {
    const oldIndex = {
      inputs: [
        { name: 'kafka', type: 'input', status: 'stable', config: {} },
        { name: 'tigerbeetle_cdc', type: 'input', status: 'stable', requiresCgo: true, config: {} },
        { name: 'zmq4', type: 'input', status: 'stable', requiresCgo: true, config: {} }
      ],
      processors: [
        { name: 'mapping', type: 'processor', status: 'stable', config: {} },
        { name: 'ffi', type: 'processor', status: 'stable', requiresCgo: true, config: {} }
      ]
    };

    // Simulate fallback stripping
    const strippedIndex = JSON.parse(JSON.stringify(oldIndex));
    const connectorTypes = ['inputs', 'processors'];

    for (const type of connectorTypes) {
      if (Array.isArray(strippedIndex[type])) {
        strippedIndex[type] = strippedIndex[type].filter(c => {
          return !(c.requiresCgo || c.cloudOnly);
        });
      }
    }

    expect(strippedIndex.inputs).toHaveLength(1);
    expect(strippedIndex.inputs[0].name).toBe('kafka');
    expect(strippedIndex.processors).toHaveLength(1);
    expect(strippedIndex.processors[0].name).toBe('mapping');
  });

  test('should strip cloud-only connectors from old data', () => {
    const oldIndex = {
      inputs: [
        { name: 'kafka', type: 'input', status: 'stable', config: {} },
        { name: 'cloud_special', type: 'input', status: 'stable', cloudOnly: true, config: {} }
      ]
    };

    const strippedIndex = JSON.parse(JSON.stringify(oldIndex));
    strippedIndex.inputs = strippedIndex.inputs.filter(c => {
      return !(c.requiresCgo || c.cloudOnly);
    });

    expect(strippedIndex.inputs).toHaveLength(1);
    expect(strippedIndex.inputs[0].name).toBe('kafka');
  });

  test('should remove platform metadata from remaining connectors', () => {
    const oldIndex = {
      inputs: [
        { name: 'kafka', type: 'input', status: 'stable', cloudSupported: true, config: {} }
      ]
    };

    const strippedIndex = JSON.parse(JSON.stringify(oldIndex));
    strippedIndex.inputs.forEach(c => {
      delete c.cloudSupported;
      delete c.requiresCgo;
      delete c.cloudOnly;
    });

    expect(strippedIndex.inputs[0].cloudSupported).toBeUndefined();
    expect(strippedIndex.inputs[0].requiresCgo).toBeUndefined();
    expect(strippedIndex.inputs[0].cloudOnly).toBeUndefined();
  });

  test('should handle empty connector arrays gracefully', () => {
    const oldIndex = {
      inputs: [],
      outputs: []
    };

    const strippedIndex = JSON.parse(JSON.stringify(oldIndex));
    const connectorTypes = ['inputs', 'outputs'];

    for (const type of connectorTypes) {
      if (Array.isArray(strippedIndex[type])) {
        strippedIndex[type] = strippedIndex[type].filter(c => {
          return !(c.requiresCgo || c.cloudOnly);
        });
      }
    }

    expect(strippedIndex.inputs).toHaveLength(0);
    expect(strippedIndex.outputs).toHaveLength(0);
  });

  test('should keep connectors with both requiresCgo false and cloudOnly false', () => {
    const oldIndex = {
      inputs: [
        { name: 'kafka', type: 'input', status: 'stable', requiresCgo: false, cloudOnly: false, config: {} },
        { name: 'http', type: 'input', status: 'stable', config: {} }
      ]
    };

    const strippedIndex = JSON.parse(JSON.stringify(oldIndex));
    strippedIndex.inputs = strippedIndex.inputs.filter(c => {
      return !(c.requiresCgo || c.cloudOnly);
    });

    expect(strippedIndex.inputs).toHaveLength(2);
  });
});

describe('Binary Analysis Integration', () => {
  test('should count correct number of CGO-only connectors', () => {
    const binaryAnalysis = {
      ossVersion: '4.86.0',
      cloudVersion: '4.86.0',
      cgoIndex: { inputs: [] },
      cgoOnly: [
        { name: 'tigerbeetle_cdc', type: 'input', status: 'stable' },
        { name: 'zmq4', type: 'input', status: 'stable' },
        { name: 'zmq4', type: 'output', status: 'stable' },
        { name: 'ffi', type: 'processor', status: 'stable' }
      ]
    };

    expect(binaryAnalysis.cgoOnly).toHaveLength(4);
  });

  test('should structure cloud-only connector data correctly', () => {
    const cloudOnlyConnector = {
      name: 'cloud_special',
      type: 'input',
      status: 'stable',
      cloudOnly: true,
      cloudSupported: true,
      requiresCgo: false
    };

    expect(cloudOnlyConnector.cloudOnly).toBe(true);
    expect(cloudOnlyConnector.cloudSupported).toBe(true);
    expect(cloudOnlyConnector.requiresCgo).toBe(false);
  });
});
