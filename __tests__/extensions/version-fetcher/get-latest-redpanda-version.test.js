const getLatestRedpandaVersion = require('../../../extensions/version-fetcher/get-latest-redpanda-version');

// GitHub only returns draft releases to callers whose token has push access to
// the repository, so these cases only reproduce with such a token. A draft
// release has no git tag until it is published, which is what makes it
// dangerous to feed into git.getRef.
const release = (tag_name, draft = false) => ({ tag_name, draft });

describe('getLatestRedpandaVersion', () => {
  let mockGithub;

  beforeEach(() => {
    mockGithub = {
      rest: {
        repos: { listReleases: jest.fn() },
        git: { getRef: jest.fn() }
      }
    };
  });

  const mockReleases = (releases) => {
    mockGithub.rest.repos.listReleases.mockResolvedValue({ data: releases });
  };

  const mockTags = (tags) => {
    mockGithub.rest.git.getRef.mockImplementation(async ({ ref }) => {
      const tag = ref.replace(/^tags\//, '');
      if (!(tag in tags)) {
        const error = new Error('Not Found');
        error.status = 404;
        throw error;
      }
      return { data: { object: { sha: tags[tag] } } };
    });
  };

  it('resolves the latest stable and RC releases', async () => {
    mockReleases([
      release('v26.2.2-rc1'),
      release('v26.2.1'),
      release('v26.1.17')
    ]);
    mockTags({
      'v26.2.2-rc1': 'aaaaaaaaaaaaaaaa',
      'v26.2.1': 'bbbbbbbbbbbbbbbb'
    });

    const result = await getLatestRedpandaVersion(mockGithub, 'redpanda-data', 'redpanda');

    expect(result.latestRedpandaRelease).toEqual({ version: 'v26.2.1', commitHash: 'bbbbbbb' });
    expect(result.latestRcRelease).toEqual({ version: 'v26.2.2-rc1', commitHash: 'aaaaaaa' });
  });

  it('skips a draft RC in favour of the newest published RC', async () => {
    mockReleases([
      release('v26.2.2-rc2', true),
      release('v26.2.2-rc1'),
      release('v26.2.1')
    ]);
    // No tag for the draft, matching what GitHub does until it is published.
    mockTags({
      'v26.2.2-rc1': 'aaaaaaaaaaaaaaaa',
      'v26.2.1': 'bbbbbbbbbbbbbbbb'
    });

    const result = await getLatestRedpandaVersion(mockGithub, 'redpanda-data', 'redpanda');

    expect(result.latestRcRelease).toEqual({ version: 'v26.2.2-rc1', commitHash: 'aaaaaaa' });
    expect(result.latestRedpandaRelease).toEqual({ version: 'v26.2.1', commitHash: 'bbbbbbb' });
    expect(mockGithub.rest.git.getRef).not.toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'tags/v26.2.2-rc2' })
    );
  });

  it('still returns the stable release when every RC is a draft', async () => {
    mockReleases([
      release('v26.2.2-rc2', true),
      release('v26.2.2-rc1', true),
      release('v26.2.1')
    ]);
    mockTags({ 'v26.2.1': 'bbbbbbbbbbbbbbbb' });

    const result = await getLatestRedpandaVersion(mockGithub, 'redpanda-data', 'redpanda');

    expect(result.latestRedpandaRelease).toEqual({ version: 'v26.2.1', commitHash: 'bbbbbbb' });
    expect(result.latestRcRelease).toBeNull();
  });

  it('drops an RC whose tag is missing rather than the whole result', async () => {
    mockReleases([release('v26.2.2-rc1'), release('v26.2.1')]);
    // Published RC, but the tag cannot be resolved for some other reason.
    mockTags({ 'v26.2.1': 'bbbbbbbbbbbbbbbb' });

    const result = await getLatestRedpandaVersion(mockGithub, 'redpanda-data', 'redpanda');

    expect(result.latestRedpandaRelease).toEqual({ version: 'v26.2.1', commitHash: 'bbbbbbb' });
    expect(result.latestRcRelease).toBeNull();
  });

  it('ignores draft stable releases', async () => {
    mockReleases([release('v26.2.2', true), release('v26.2.1')]);
    mockTags({ 'v26.2.1': 'bbbbbbbbbbbbbbbb' });

    const result = await getLatestRedpandaVersion(mockGithub, 'redpanda-data', 'redpanda');

    expect(result.latestRedpandaRelease).toEqual({ version: 'v26.2.1', commitHash: 'bbbbbbb' });
  });

  it('lets a non-404 error from the RC tag lookup propagate', async () => {
    mockReleases([release('v26.2.2-rc1'), release('v26.2.1')]);
    mockGithub.rest.git.getRef.mockImplementation(async ({ ref }) => {
      if (ref === 'tags/v26.2.1') return { data: { object: { sha: 'bbbbbbbbbbbbbbbb' } } };
      const error = new Error('Internal Server Error');
      error.status = 500;
      throw error;
    });

    // retryWithBackoff exhausts its retries, then the module's catch reports
    // the failure as no version data at all.
    const result = await getLatestRedpandaVersion(mockGithub, 'redpanda-data', 'redpanda');

    expect(result).toEqual({ latestRedpandaRelease: null, latestRcRelease: null });
    expect(mockGithub.rest.git.getRef.mock.calls.filter(([{ ref }]) => ref === 'tags/v26.2.2-rc1').length)
      .toBeGreaterThan(1);
  });
});

describe('resolveCommitHash error handling (stable release)', () => {
  // Two failures that look alike and are not. A tag that is not yet pushed
  // answers 404 for good, so retrying is waste and the version must survive
  // without a commit. A rate limit or a 5xx is transient, so it has to get its
  // attempts, and must ALSO leave the version intact once they are exhausted:
  // losing the whole version to a blip is strictly worse than losing a commit
  // hash, which is why the retry lives on the ref lookup rather than around it.
  const releases = [
    { tag_name: 'v26.2.1', prerelease: false, published_at: '2026-08-01T00:00:00Z' },
  ];

  function throwingGitHub (error) {
    const state = { attempts: 0 };
    state.gh = {
      rest: {
        repos: { listReleases: async () => ({ data: releases }) },
        git: { getRef: async () => { state.attempts++; throw error; } },
      },
    };
    return state;
  }

  it('does not retry a 404, and keeps the version', async () => {
    const s = throwingGitHub(Object.assign(new Error('Not Found'), { status: 404 }));
    const result = await getLatestRedpandaVersion(s.gh);
    expect(s.attempts).toBe(1);
    expect(result.latestRedpandaRelease.version).toBe('v26.2.1');
    expect(result.latestRedpandaRelease.commitHash).toBeNull();
  });

  it.each([
    ['a rate limit', Object.assign(new Error('API rate limit exceeded'), { status: 403 })],
    ['a 502', Object.assign(new Error('Bad Gateway'), { status: 502 })],
    ['a connection reset', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
  ])('retries %s and still keeps the version', async (_label, err) => {
    const s = throwingGitHub(err);
    const result = await getLatestRedpandaVersion(s.gh);
    // More than one attempt is the point: swallowing the error immediately gave
    // exactly one, so this is what fails if the guard is widened again.
    expect(s.attempts).toBeGreaterThan(1);
    expect(result.latestRedpandaRelease.version).toBe('v26.2.1');
    expect(result.latestRedpandaRelease.commitHash).toBeNull();
  });
});
