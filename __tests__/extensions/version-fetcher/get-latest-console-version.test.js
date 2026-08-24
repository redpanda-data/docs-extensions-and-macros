const getLatestConsoleVersion = require('../../../extensions/version-fetcher/get-latest-console-version');

// GitHub only returns draft releases to callers whose token has push access to
// the repository, so the draft cases here only reproduce with such a token.
// A draft has no published Docker image, so its tag must not be handed back as
// a version to pull.
const release = (tag_name, draft = false) => ({ tag_name, draft });

describe('getLatestConsoleVersion', () => {
  let mockGithub;

  beforeEach(() => {
    mockGithub = {
      rest: { repos: { listReleases: jest.fn() } }
    };
  });

  const mockReleases = (releases) => {
    mockGithub.rest.repos.listReleases.mockResolvedValue({ data: releases });
  };

  it('resolves the latest stable and beta releases', async () => {
    mockReleases([
      release('v3.11.0-beta1'),
      release('v3.10.0'),
      release('v3.9.0')
    ]);

    const result = await getLatestConsoleVersion(mockGithub, 'redpanda-data', 'console');

    expect(result.latestStableRelease).toBe('v3.10.0');
    expect(result.latestBetaRelease).toBe('v3.11.0-beta1');
  });

  it('skips a draft stable release in favour of the newest published one', async () => {
    mockReleases([
      release('v3.11.0', true),
      release('v3.10.0'),
      release('v3.9.0')
    ]);

    const result = await getLatestConsoleVersion(mockGithub, 'redpanda-data', 'console');

    expect(result.latestStableRelease).toBe('v3.10.0');
  });

  it('skips a draft beta release in favour of the newest published one', async () => {
    mockReleases([
      release('v3.11.0-beta2', true),
      release('v3.11.0-beta1'),
      release('v3.10.0')
    ]);

    const result = await getLatestConsoleVersion(mockGithub, 'redpanda-data', 'console');

    expect(result.latestBetaRelease).toBe('v3.11.0-beta1');
    expect(result.latestStableRelease).toBe('v3.10.0');
  });

  it('returns a null beta when every beta is a draft', async () => {
    mockReleases([
      release('v3.11.0-beta1', true),
      release('v3.10.0')
    ]);

    const result = await getLatestConsoleVersion(mockGithub, 'redpanda-data', 'console');

    expect(result.latestStableRelease).toBe('v3.10.0');
    expect(result.latestBetaRelease).toBeNull();
  });

  it('returns nulls when every release is a draft', async () => {
    mockReleases([release('v3.11.0', true), release('v3.10.0', true)]);

    const result = await getLatestConsoleVersion(mockGithub, 'redpanda-data', 'console');

    expect(result).toEqual({ latestStableRelease: null, latestBetaRelease: null });
  });

  it('ignores tags that are not valid semver', async () => {
    mockReleases([release('not-a-version'), release('v3.10.0')]);

    const result = await getLatestConsoleVersion(mockGithub, 'redpanda-data', 'console');

    expect(result.latestStableRelease).toBe('v3.10.0');
  });

  it('returns nulls when the API returns no releases', async () => {
    mockReleases([]);

    const result = await getLatestConsoleVersion(mockGithub, 'redpanda-data', 'console');

    expect(result).toEqual({ latestStableRelease: null, latestBetaRelease: null });
  });
});
