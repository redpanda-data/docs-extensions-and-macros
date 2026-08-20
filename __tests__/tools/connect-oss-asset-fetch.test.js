'use strict';

/**
 * Tests for fetching a specific Connect version's schema from its release
 * asset instead of through `rpk connect install --connect-version`.
 *
 * Why this path exists: rpk validates --connect-version with a regex that caps
 * each segment at two digits (validateVersion in rpk/pkg/cli/connect/install.go,
 * still capped as of v26.2.1), so it refuses every version >= 4.100.0. Fetching
 * the plain OSS asset — the same build rpk would have installed — skips that
 * validation and leaves the caller's own Connect installation untouched.
 */

const mockListReleases = jest.fn();
const mockGetReleaseByTag = jest.fn();

jest.mock('../../cli-utils/octokit-client', () => ({
  repos: {
    listReleases: (...args) => mockListReleases(...args),
    getReleaseByTag: (...args) => mockGetReleaseByTag(...args),
  },
  rateLimit: { get: jest.fn() },
}));

const {
  resolveAssetPrefix,
  getLatestVersion,
} = require('../../tools/redpanda-connect/connector-binary-analyzer');

const asset = name => ({ name, browser_download_url: `https://example.invalid/${name}` });

describe('resolveAssetPrefix', () => {
  test('maps each binary flavour to its release asset prefix', () => {
    expect(resolveAssetPrefix('oss')).toBe('redpanda-connect');
    expect(resolveAssetPrefix('cloud')).toBe('redpanda-connect-cloud');
    expect(resolveAssetPrefix('cgo')).toBe('redpanda-connect-cgo');
  });

  test('rejects an unknown flavour and names the valid ones', () => {
    expect(() => resolveAssetPrefix('fips')).toThrow(/Unknown binary type "fips"/);
    expect(() => resolveAssetPrefix('fips')).toThrow(/oss, cloud, cgo/);
  });

  test('rejects a missing flavour rather than silently defaulting', () => {
    expect(() => resolveAssetPrefix(undefined)).toThrow(/Unknown binary type/);
  });

  // The OSS prefix is a prefix of both other prefixes, so any matching has to
  // include the separator or 'oss' would swallow the cloud and cgo assets.
  test('the OSS prefix only matches OSS assets once the separator is included', () => {
    const oss = resolveAssetPrefix('oss');

    expect('redpanda-connect_4.103.1_linux_amd64.tar.gz'.startsWith(`${oss}_`)).toBe(true);
    expect('redpanda-connect-cloud_4.103.1_linux_amd64.tar.gz'.startsWith(`${oss}_`)).toBe(false);
    expect('redpanda-connect-cgo_4.103.1_linux_amd64.tar.gz'.startsWith(`${oss}_`)).toBe(false);
  });

  test('builds the asset name that Connect releases actually publish', () => {
    const name = `${resolveAssetPrefix('oss')}_4.103.1_linux_amd64.tar.gz`;
    expect(name).toBe('redpanda-connect_4.103.1_linux_amd64.tar.gz');
  });
});

describe('getLatestVersion', () => {
  beforeEach(() => {
    mockListReleases.mockReset();
    mockGetReleaseByTag.mockReset();
  });

  test('finds the newest release carrying an OSS asset', async () => {
    mockListReleases.mockResolvedValue({
      data: [
        { tag_name: 'v4.106.0', assets: [asset('redpanda-connect_4.106.0_linux_amd64.tar.gz')] },
      ],
    });

    await expect(getLatestVersion('oss')).resolves.toBe('4.106.0');
  });

  test('does not mistake a cloud-only release for an OSS one', async () => {
    mockListReleases.mockResolvedValue({
      data: [
        { tag_name: 'v4.106.0', assets: [asset('redpanda-connect-cloud_4.106.0_linux_amd64.tar.gz')] },
        { tag_name: 'v4.105.0', assets: [asset('redpanda-connect_4.105.0_linux_amd64.tar.gz')] },
      ],
    });

    // Without the separator in the match, the cloud asset above would win.
    await expect(getLatestVersion('oss')).resolves.toBe('4.105.0');
  });

  test('still resolves cloud and cgo flavours', async () => {
    mockListReleases.mockResolvedValue({
      data: [
        {
          tag_name: 'v4.106.0',
          assets: [
            asset('redpanda-connect_4.106.0_linux_amd64.tar.gz'),
            asset('redpanda-connect-cloud_4.106.0_linux_amd64.tar.gz'),
            asset('redpanda-connect-cgo_4.106.0_linux_amd64.tar.gz'),
          ],
        },
      ],
    });

    await expect(getLatestVersion('cloud')).resolves.toBe('4.106.0');
    await expect(getLatestVersion('cgo')).resolves.toBe('4.106.0');
  });
});
