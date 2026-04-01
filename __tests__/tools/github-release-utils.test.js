'use strict';

// Mock the shared Octokit client
const mockPaginate = jest.fn();
jest.mock('../../cli-utils/octokit-client', () => ({
  rest: {
    repos: {
      listReleases: jest.fn()
    }
  },
  get paginate() {
    return mockPaginate;
  }
}));

// Mock the GitHub token utility
jest.mock('../../cli-utils/github-token', () => ({
  hasGitHubToken: jest.fn(() => false),
  getGitHubToken: jest.fn(() => null)
}));

const {
  discoverIntermediateReleases,
  parseVersionFromTag,
  isPrerelease,
  filterToStableReleases,
  findCloudVersionForDate,
  clearCache
} = require('../../tools/redpanda-connect/github-release-utils');

describe('GitHub Release Utils', () => {
  beforeEach(() => {
    // Clear cache before each test
    clearCache();
    jest.clearAllMocks();
  });

  describe('parseVersionFromTag', () => {
    it('should parse version with v prefix', () => {
      expect(parseVersionFromTag('v4.50.0')).toBe('4.50.0');
    });

    it('should parse version without v prefix', () => {
      expect(parseVersionFromTag('4.50.0')).toBe('4.50.0');
    });

    it('should return null for invalid version', () => {
      expect(parseVersionFromTag('invalid')).toBeNull();
      expect(parseVersionFromTag('')).toBeNull();
      expect(parseVersionFromTag(null)).toBeNull();
    });

    it('should parse beta versions', () => {
      expect(parseVersionFromTag('v4.50.0-beta.1')).toBe('4.50.0-beta.1');
    });

    it('should parse RC versions', () => {
      expect(parseVersionFromTag('v4.50.0-rc1')).toBe('4.50.0-rc1');
    });
  });

  describe('isPrerelease', () => {
    it('should identify beta versions as prerelease', () => {
      expect(isPrerelease('4.50.0-beta.1')).toBe(true);
    });

    it('should identify RC versions as prerelease', () => {
      expect(isPrerelease('4.50.0-rc1')).toBe(true);
    });

    it('should identify alpha versions as prerelease', () => {
      expect(isPrerelease('4.50.0-alpha.1')).toBe(true);
    });

    it('should identify stable versions as NOT prerelease', () => {
      expect(isPrerelease('4.50.0')).toBe(false);
    });

    it('should handle invalid versions', () => {
      expect(isPrerelease('invalid')).toBe(false);
    });
  });

  describe('filterToStableReleases', () => {
    it('should filter out drafts', () => {
      const releases = [
        { draft: true, tag_name: 'v4.50.0', prerelease: false },
        { draft: false, tag_name: 'v4.51.0', prerelease: false }
      ];

      const result = filterToStableReleases(releases);
      expect(result).toHaveLength(1);
      expect(result[0].tag_name).toBe('v4.51.0');
    });

    it('should filter out beta/RC versions', () => {
      const releases = [
        { draft: false, tag_name: 'v4.50.0', prerelease: false },
        { draft: false, tag_name: 'v4.51.0-beta.1', prerelease: true },
        { draft: false, tag_name: 'v4.51.0-rc1', prerelease: true },
        { draft: false, tag_name: 'v4.51.0', prerelease: false }
      ];

      const result = filterToStableReleases(releases);
      expect(result).toHaveLength(2);
      expect(result[0].tag_name).toBe('v4.50.0');
      expect(result[1].tag_name).toBe('v4.51.0');
    });

    it('should filter out invalid version tags', () => {
      const releases = [
        { draft: false, tag_name: 'v4.50.0', prerelease: false },
        { draft: false, tag_name: 'invalid-tag', prerelease: false },
        { draft: false, tag_name: 'v4.51.0', prerelease: false }
      ];

      const result = filterToStableReleases(releases);
      expect(result).toHaveLength(2);
    });
  });

  describe('discoverIntermediateReleases', () => {
    it('should discover releases between two versions', async () => {
      const mockReleases = [
        { draft: false, tag_name: 'v4.49.0', published_at: '2024-01-01', html_url: 'https://github.com/redpanda-data/connect/releases/tag/v4.49.0' },
        { draft: false, tag_name: 'v4.50.0', published_at: '2024-01-08', html_url: 'https://github.com/redpanda-data/connect/releases/tag/v4.50.0' },
        { draft: false, tag_name: 'v4.51.0', published_at: '2024-01-15', html_url: 'https://github.com/redpanda-data/connect/releases/tag/v4.51.0' },
        { draft: false, tag_name: 'v4.52.0', published_at: '2024-01-22', html_url: 'https://github.com/redpanda-data/connect/releases/tag/v4.52.0' },
        { draft: false, tag_name: 'v4.53.0', published_at: '2024-01-29', html_url: 'https://github.com/redpanda-data/connect/releases/tag/v4.53.0' }
      ];

      mockPaginate.mockResolvedValue(mockReleases);

      const result = await discoverIntermediateReleases('4.50.0', '4.52.0', { useCache: false });

      expect(result).toHaveLength(3);
      expect(result[0].version).toBe('4.50.0');
      expect(result[1].version).toBe('4.51.0');
      expect(result[2].version).toBe('4.52.0');
    });

    it('should exclude prerelease versions by default', async () => {
      const mockReleases = [
        { draft: false, tag_name: 'v4.50.0', published_at: '2024-01-08', html_url: 'https://...' },
        { draft: false, tag_name: 'v4.51.0-beta.1', published_at: '2024-01-12', html_url: 'https://...' },
        { draft: false, tag_name: 'v4.51.0', published_at: '2024-01-15', html_url: 'https://...' }
      ];

      mockPaginate.mockResolvedValue(mockReleases);

      const result = await discoverIntermediateReleases('4.50.0', '4.51.0', { useCache: false });

      expect(result).toHaveLength(2);
      expect(result[0].version).toBe('4.50.0');
      expect(result[1].version).toBe('4.51.0');
      // Beta should be excluded
      expect(result.find(r => r.version.includes('beta'))).toBeUndefined();
    });

    it('should include prerelease versions if requested', async () => {
      const mockReleases = [
        { draft: false, tag_name: 'v4.50.0', published_at: '2024-01-08', html_url: 'https://...' },
        { draft: false, tag_name: 'v4.51.0-beta.1', published_at: '2024-01-12', html_url: 'https://...' },
        { draft: false, tag_name: 'v4.51.0', published_at: '2024-01-15', html_url: 'https://...' }
      ];

      mockPaginate.mockResolvedValue(mockReleases);

      const result = await discoverIntermediateReleases('4.50.0', '4.51.0', {
        includePrerelease: true,
        useCache: false
      });

      expect(result).toHaveLength(3);
      expect(result[1].version).toBe('4.51.0-beta.1');
      expect(result[1].isPrerelease).toBe(true);
    });

    it('should sort versions correctly', async () => {
      const mockReleases = [
        { draft: false, tag_name: 'v4.52.0', published_at: '2024-01-22', html_url: 'https://...' },
        { draft: false, tag_name: 'v4.50.0', published_at: '2024-01-08', html_url: 'https://...' },
        { draft: false, tag_name: 'v4.51.0', published_at: '2024-01-15', html_url: 'https://...' }
      ];

      mockPaginate.mockResolvedValue(mockReleases);

      const result = await discoverIntermediateReleases('4.50.0', '4.52.0', { useCache: false });

      expect(result[0].version).toBe('4.50.0');
      expect(result[1].version).toBe('4.51.0');
      expect(result[2].version).toBe('4.52.0');
    });

    it('should handle version with v prefix', async () => {
      const mockReleases = [
        { draft: false, tag_name: 'v4.50.0', published_at: '2024-01-08', html_url: 'https://...' },
        { draft: false, tag_name: 'v4.51.0', published_at: '2024-01-15', html_url: 'https://...' }
      ];

      mockPaginate.mockResolvedValue(mockReleases);

      const result = await discoverIntermediateReleases('v4.50.0', 'v4.51.0', { useCache: false });

      expect(result).toHaveLength(2);
      expect(result[0].version).toBe('4.50.0');
      expect(result[1].version).toBe('4.51.0');
    });

    it('should return empty array if no releases in range', async () => {
      const mockReleases = [
        { draft: false, tag_name: 'v4.40.0', published_at: '2024-01-01', html_url: 'https://...' },
        { draft: false, tag_name: 'v4.60.0', published_at: '2024-03-01', html_url: 'https://...' }
      ];

      mockPaginate.mockResolvedValue(mockReleases);

      const result = await discoverIntermediateReleases('4.50.0', '4.52.0', { useCache: false });

      expect(result).toHaveLength(0);
    });

    it('should throw error for invalid starting version', async () => {
      await expect(discoverIntermediateReleases('invalid', '4.52.0', { useCache: false }))
        .rejects.toThrow('Invalid starting version');
    });

    it('should throw error for invalid ending version', async () => {
      await expect(discoverIntermediateReleases('4.50.0', 'invalid', { useCache: false }))
        .rejects.toThrow('Invalid ending version');
    });
  });

  describe('findCloudVersionForDate', () => {
    it('should find cloud version for a given date', async () => {
      const mockReleases = [
        { draft: false, tag_name: 'v4.50.0', published_at: '2024-01-08T00:00:00Z', html_url: 'https://...' },
        { draft: false, tag_name: 'v4.51.0', published_at: '2024-01-15T00:00:00Z', html_url: 'https://...' },
        { draft: false, tag_name: 'v4.52.0', published_at: '2024-01-22T00:00:00Z', html_url: 'https://...' }
      ];

      mockPaginate.mockResolvedValue(mockReleases);

      // Date is 2024-01-20, should return 4.51.0 (most recent before that date)
      const result = await findCloudVersionForDate('2024-01-20T00:00:00Z', { useCache: false });

      expect(result).toBe('4.51.0');
    });

    it('should return most recent version when date is after all releases', async () => {
      const mockReleases = [
        { draft: false, tag_name: 'v4.50.0', published_at: '2024-01-08T00:00:00Z', html_url: 'https://...' },
        { draft: false, tag_name: 'v4.51.0', published_at: '2024-01-15T00:00:00Z', html_url: 'https://...' }
      ];

      mockPaginate.mockResolvedValue(mockReleases);

      // Date is after all releases
      const result = await findCloudVersionForDate('2024-02-01T00:00:00Z', { useCache: false });

      expect(result).toBe('4.51.0');
    });

    it('should return null when no releases exist before the date', async () => {
      const mockReleases = [
        { draft: false, tag_name: 'v4.52.0', published_at: '2024-01-22T00:00:00Z', html_url: 'https://...' }
      ];

      mockPaginate.mockResolvedValue(mockReleases);

      // Date is before all releases
      const result = await findCloudVersionForDate('2024-01-01T00:00:00Z', { useCache: false });

      expect(result).toBeNull();
    });

    it('should exclude prerelease versions', async () => {
      const mockReleases = [
        { draft: false, tag_name: 'v4.50.0', published_at: '2024-01-08T00:00:00Z', html_url: 'https://...' },
        { draft: false, tag_name: 'v4.51.0-beta.1', published_at: '2024-01-12T00:00:00Z', prerelease: true, html_url: 'https://...' },
        { draft: false, tag_name: 'v4.51.0', published_at: '2024-01-15T00:00:00Z', html_url: 'https://...' }
      ];

      mockPaginate.mockResolvedValue(mockReleases);

      // Date is 2024-01-14, should return 4.50.0 (skips beta)
      const result = await findCloudVersionForDate('2024-01-14T00:00:00Z', { useCache: false });

      expect(result).toBe('4.50.0');
    });

    it('should return null when API returns no releases', async () => {
      mockPaginate.mockResolvedValue([]);

      const result = await findCloudVersionForDate('2024-01-20T00:00:00Z', { useCache: false });

      expect(result).toBeNull();
    });
  });
});
