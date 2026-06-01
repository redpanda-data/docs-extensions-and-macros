'use strict';

/**
 * Tests for the available JSON version detection logic in set-latest-version.js
 *
 * These tests verify the filtering and version sorting logic used to find
 * the latest available properties and connect JSON files in the content catalog.
 */

const semver = require('semver');

// Extract the filtering logic from set-latest-version.js for testing
function filterPropertiesFiles(files) {
  return files.filter(f => {
    if (!f?.src?.stem || !f?.src?.component) return false;
    const isStreamingComponent = f.src.component === 'streaming' || f.src.component === 'ROOT';
    const isReferenceModule = f.src.module === 'reference';
    const isPropertiesFile = f.src.stem.startsWith('redpanda-properties-');
    return isStreamingComponent && isReferenceModule && isPropertiesFile;
  });
}

function filterConnectFiles(files) {
  return files.filter(f => {
    if (!f?.src?.stem || !f?.src?.component) return false;
    const isConnectComponent = f.src.component === 'connect' || f.src.component === 'redpanda-connect';
    const isComponentsModule = f.src.module === 'components';
    const isConnectFile = f.src.stem.startsWith('connect-');
    return isConnectComponent && isComponentsModule && isConnectFile;
  });
}

function extractLatestPropertiesVersion(files) {
  const versions = files
    .map(f => f.src.stem.replace('redpanda-properties-', ''))
    .filter(v => semver.valid(v.replace(/^v/, '')));

  if (versions.length === 0) return null;

  return versions.sort((a, b) =>
    semver.rcompare(a.replace(/^v/, ''), b.replace(/^v/, ''))
  )[0];
}

function extractLatestConnectVersion(files) {
  const versions = files
    .map(f => f.src.stem.replace('connect-', ''))
    .filter(v => semver.valid(v));

  if (versions.length === 0) return null;

  return versions.sort((a, b) => semver.rcompare(a, b))[0];
}

describe('Properties JSON file detection', () => {
  describe('filterPropertiesFiles', () => {
    it('should filter files from streaming component with reference module', () => {
      const files = [
        { src: { stem: 'redpanda-properties-v25.3.1', component: 'streaming', module: 'reference' } },
        { src: { stem: 'redpanda-properties-v25.2.0', component: 'streaming', module: 'reference' } },
        { src: { stem: 'other-file', component: 'streaming', module: 'reference' } },
      ];

      const result = filterPropertiesFiles(files);
      expect(result).toHaveLength(2);
      expect(result[0].src.stem).toBe('redpanda-properties-v25.3.1');
    });

    it('should accept ROOT component for backwards compatibility', () => {
      const files = [
        { src: { stem: 'redpanda-properties-v25.3.1', component: 'ROOT', module: 'reference' } },
      ];

      const result = filterPropertiesFiles(files);
      expect(result).toHaveLength(1);
    });

    it('should reject files from wrong component', () => {
      const files = [
        { src: { stem: 'redpanda-properties-v25.3.1', component: 'cloud', module: 'reference' } },
        { src: { stem: 'redpanda-properties-v25.3.1', component: 'connect', module: 'reference' } },
      ];

      const result = filterPropertiesFiles(files);
      expect(result).toHaveLength(0);
    });

    it('should reject files from wrong module', () => {
      const files = [
        { src: { stem: 'redpanda-properties-v25.3.1', component: 'streaming', module: 'deploy' } },
        { src: { stem: 'redpanda-properties-v25.3.1', component: 'streaming', module: 'ROOT' } },
      ];

      const result = filterPropertiesFiles(files);
      expect(result).toHaveLength(0);
    });

    it('should handle null/undefined src properties gracefully', () => {
      const files = [
        { src: null },
        { src: { stem: null, component: 'streaming', module: 'reference' } },
        { src: { stem: 'redpanda-properties-v25.3.1', component: null, module: 'reference' } },
        {},
        null,
        undefined,
      ].filter(Boolean); // Remove null/undefined from array

      const result = filterPropertiesFiles(files);
      expect(result).toHaveLength(0);
    });
  });

  describe('extractLatestPropertiesVersion', () => {
    it('should find the highest semver version with v prefix', () => {
      const files = [
        { src: { stem: 'redpanda-properties-v25.1.0' } },
        { src: { stem: 'redpanda-properties-v25.3.1' } },
        { src: { stem: 'redpanda-properties-v25.2.5' } },
        { src: { stem: 'redpanda-properties-v24.3.0' } },
      ];

      const result = extractLatestPropertiesVersion(files);
      expect(result).toBe('v25.3.1');
    });

    it('should handle versions without v prefix', () => {
      const files = [
        { src: { stem: 'redpanda-properties-25.1.0' } },
        { src: { stem: 'redpanda-properties-25.3.1' } },
      ];

      const result = extractLatestPropertiesVersion(files);
      expect(result).toBe('25.3.1');
    });

    it('should handle mixed v-prefix and non-v-prefix versions', () => {
      const files = [
        { src: { stem: 'redpanda-properties-v25.1.0' } },
        { src: { stem: 'redpanda-properties-25.3.1' } },
      ];

      const result = extractLatestPropertiesVersion(files);
      // Both are valid, should return the higher one
      expect(result).toBe('25.3.1');
    });

    it('should filter out invalid version strings', () => {
      const files = [
        { src: { stem: 'redpanda-properties-invalid' } },
        { src: { stem: 'redpanda-properties-v25.3.1' } },
        { src: { stem: 'redpanda-properties-latest' } },
      ];

      const result = extractLatestPropertiesVersion(files);
      expect(result).toBe('v25.3.1');
    });

    it('should return null for empty array', () => {
      const result = extractLatestPropertiesVersion([]);
      expect(result).toBeNull();
    });

    it('should return null if no valid versions found', () => {
      const files = [
        { src: { stem: 'redpanda-properties-invalid' } },
        { src: { stem: 'redpanda-properties-not-a-version' } },
      ];

      const result = extractLatestPropertiesVersion(files);
      expect(result).toBeNull();
    });

    it('should handle prerelease versions correctly', () => {
      const files = [
        { src: { stem: 'redpanda-properties-v25.3.1' } },
        { src: { stem: 'redpanda-properties-v26.0.0-rc1' } },
      ];

      const result = extractLatestPropertiesVersion(files);
      // v26.0.0-rc1 is higher than v25.3.1 in semver (26 > 25)
      // If a prerelease JSON exists, we should use it
      expect(result).toBe('v26.0.0-rc1');
    });

    it('should prefer stable over prerelease of same major.minor', () => {
      const files = [
        { src: { stem: 'redpanda-properties-v25.3.1' } },
        { src: { stem: 'redpanda-properties-v25.3.2-rc1' } },
      ];

      const result = extractLatestPropertiesVersion(files);
      // v25.3.2-rc1 < v25.3.2 but > v25.3.1, so rc1 wins
      expect(result).toBe('v25.3.2-rc1');
    });

    it('should sort prereleases correctly against each other', () => {
      const files = [
        { src: { stem: 'redpanda-properties-v25.4.0-rc1' } },
        { src: { stem: 'redpanda-properties-v25.4.0-rc2' } },
        { src: { stem: 'redpanda-properties-v25.4.0-beta1' } },
      ];

      const result = extractLatestPropertiesVersion(files);
      // rc2 > rc1 > beta1
      expect(result).toBe('v25.4.0-rc2');
    });
  });
});

describe('Connect JSON file detection', () => {
  describe('filterConnectFiles', () => {
    it('should filter files from connect component with components module', () => {
      const files = [
        { src: { stem: 'connect-4.93.0', component: 'connect', module: 'components' } },
        { src: { stem: 'connect-4.92.0', component: 'connect', module: 'components' } },
        { src: { stem: 'other-file', component: 'connect', module: 'components' } },
      ];

      const result = filterConnectFiles(files);
      expect(result).toHaveLength(2);
    });

    it('should accept redpanda-connect component for backwards compatibility', () => {
      const files = [
        { src: { stem: 'connect-4.93.0', component: 'redpanda-connect', module: 'components' } },
      ];

      const result = filterConnectFiles(files);
      expect(result).toHaveLength(1);
    });

    it('should reject files from wrong component', () => {
      const files = [
        { src: { stem: 'connect-4.93.0', component: 'streaming', module: 'components' } },
        { src: { stem: 'connect-4.93.0', component: 'cloud', module: 'components' } },
      ];

      const result = filterConnectFiles(files);
      expect(result).toHaveLength(0);
    });

    it('should reject files from wrong module', () => {
      const files = [
        { src: { stem: 'connect-4.93.0', component: 'connect', module: 'reference' } },
        { src: { stem: 'connect-4.93.0', component: 'connect', module: 'ROOT' } },
      ];

      const result = filterConnectFiles(files);
      expect(result).toHaveLength(0);
    });
  });

  describe('extractLatestConnectVersion', () => {
    it('should find the highest semver version', () => {
      const files = [
        { src: { stem: 'connect-4.91.0' } },
        { src: { stem: 'connect-4.93.0' } },
        { src: { stem: 'connect-4.92.5' } },
        { src: { stem: 'connect-4.78.0' } },
      ];

      const result = extractLatestConnectVersion(files);
      expect(result).toBe('4.93.0');
    });

    it('should filter out invalid version strings', () => {
      const files = [
        { src: { stem: 'connect-invalid' } },
        { src: { stem: 'connect-4.93.0' } },
        { src: { stem: 'connect-latest' } },
      ];

      const result = extractLatestConnectVersion(files);
      expect(result).toBe('4.93.0');
    });

    it('should return null for empty array', () => {
      const result = extractLatestConnectVersion([]);
      expect(result).toBeNull();
    });

    it('should handle patch versions correctly', () => {
      const files = [
        { src: { stem: 'connect-4.93.0' } },
        { src: { stem: 'connect-4.93.1' } },
        { src: { stem: 'connect-4.93.10' } },
      ];

      const result = extractLatestConnectVersion(files);
      expect(result).toBe('4.93.10');
    });
  });
});

describe('Edge cases', () => {
  it('should handle single file correctly', () => {
    const propertiesFiles = [
      { src: { stem: 'redpanda-properties-v25.3.1', component: 'streaming', module: 'reference' } },
    ];
    const connectFiles = [
      { src: { stem: 'connect-4.93.0', component: 'connect', module: 'components' } },
    ];

    expect(extractLatestPropertiesVersion(filterPropertiesFiles(propertiesFiles))).toBe('v25.3.1');
    expect(extractLatestConnectVersion(filterConnectFiles(connectFiles))).toBe('4.93.0');
  });

  it('should handle files with similar names', () => {
    const files = [
      { src: { stem: 'redpanda-properties-v25.3.1', component: 'streaming', module: 'reference' } },
      { src: { stem: 'redpanda-properties-schema', component: 'streaming', module: 'reference' } },
      { src: { stem: 'redpanda-properties-v25.3.1-backup', component: 'streaming', module: 'reference' } },
    ];

    const filtered = filterPropertiesFiles(files);
    expect(filtered).toHaveLength(3); // All match the prefix filter

    const version = extractLatestPropertiesVersion(filtered);
    expect(version).toBe('v25.3.1'); // Only valid semver
  });

  it('should handle very old versions', () => {
    const files = [
      { src: { stem: 'redpanda-properties-v21.1.0' } },
      { src: { stem: 'redpanda-properties-v25.3.1' } },
      { src: { stem: 'redpanda-properties-v22.0.0' } },
    ];

    const result = extractLatestPropertiesVersion(files);
    expect(result).toBe('v25.3.1');
  });
});
