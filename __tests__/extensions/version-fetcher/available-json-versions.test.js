'use strict';

/**
 * Tests for the available JSON version detection logic in set-latest-version.js
 *
 * These tests verify the filtering and version sorting logic used to find
 * the latest available properties and connect JSON files in the content catalog.
 */

const semver = require('semver');

// Import the actual filtering logic from set-latest-version.js
const {
  filterPropertiesFiles,
  filterConnectFiles,
  extractLatestPropertiesVersion: _extractLatestPropertiesVersion,
  extractLatestConnectVersion: _extractLatestConnectVersion
} = require('../../../extensions/version-fetcher/set-latest-version');

// Wrap the version extractors to inject semver dependency
function extractLatestPropertiesVersion(files) {
  return _extractLatestPropertiesVersion(files, semver);
}

function extractLatestConnectVersion(files) {
  return _extractLatestConnectVersion(files, semver);
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

    it('should reject prerelease versions and use stable', () => {
      const files = [
        { src: { stem: 'redpanda-properties-v25.3.1' } },
        { src: { stem: 'redpanda-properties-v26.0.0-rc1' } },
      ];

      const result = extractLatestPropertiesVersion(files);
      // v26.0.0-rc1 is filtered out as a prerelease, so v25.3.1 wins
      expect(result).toBe('v25.3.1');
    });

    it('should reject all prerelease suffixes (-rc1, -beta1, -backup, etc.)', () => {
      const files = [
        { src: { stem: 'redpanda-properties-v25.3.1' } },
        { src: { stem: 'redpanda-properties-v25.3.2-rc1' } },
        { src: { stem: 'redpanda-properties-v26.0.0-backup' } },
        { src: { stem: 'redpanda-properties-v25.4.0-beta1' } },
      ];

      const result = extractLatestPropertiesVersion(files);
      // All prerelease/suffixed versions are filtered out
      expect(result).toBe('v25.3.1');
    });

    it('should return null if only prerelease versions exist', () => {
      const files = [
        { src: { stem: 'redpanda-properties-v25.4.0-rc1' } },
        { src: { stem: 'redpanda-properties-v25.4.0-rc2' } },
        { src: { stem: 'redpanda-properties-v25.4.0-beta1' } },
      ];

      const result = extractLatestPropertiesVersion(files);
      // All are prereleases, so no valid versions
      expect(result).toBeNull();
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

  it('should handle files with similar names and reject suffixed versions', () => {
    const files = [
      { src: { stem: 'redpanda-properties-v25.3.1', component: 'streaming', module: 'reference' } },
      { src: { stem: 'redpanda-properties-schema', component: 'streaming', module: 'reference' } },
      { src: { stem: 'redpanda-properties-v25.3.1-backup', component: 'streaming', module: 'reference' } },
    ];

    const filtered = filterPropertiesFiles(files);
    expect(filtered).toHaveLength(3); // All match the prefix filter (file discovery stage)

    const version = extractLatestPropertiesVersion(filtered);
    // extractLatestPropertiesVersion filters out:
    // - 'schema' (not valid semver)
    // - 'v25.3.1-backup' (valid semver prerelease, but we only accept stable versions)
    // Only 'v25.3.1' remains as a stable release
    expect(version).toBe('v25.3.1');
  });

  it('should pick stable version even when higher-versioned suffixed file exists', () => {
    const files = [
      { src: { stem: 'redpanda-properties-v25.3.1', component: 'streaming', module: 'reference' } },
      { src: { stem: 'redpanda-properties-v26.0.0-backup', component: 'streaming', module: 'reference' } },
    ];

    const filtered = filterPropertiesFiles(files);
    const version = extractLatestPropertiesVersion(filtered);
    // v26.0.0-backup has higher base version but is rejected as prerelease
    expect(version).toBe('v25.3.1');
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
