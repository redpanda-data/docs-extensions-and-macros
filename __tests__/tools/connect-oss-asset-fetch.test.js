'use strict';

/**
 * Tests for fetching a specific Connect version's schema from its release
 * asset instead of through `rpk connect install --connect-version`.
 *
 * Why this path exists: rpk validates --connect-version with a regex that caps
 * each segment at two digits (validateVersion in rpk/pkg/cli/connect/install.go),
 * so it refuses every version >= 4.100.0. The cap is lifted in rpk v26.1.15 and
 * on dev, but v26.1.14 and the whole v26.2.x line still carry it, so what can be
 * installed depends on which rpk is on PATH. Fetching the plain OSS asset, the
 * same build rpk would have installed, skips that validation entirely and leaves
 * the caller's own Connect installation untouched.
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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  resolveAssetPrefix,
  getLatestVersion,
  getPlatformInfo,
  getBinaryCacheDir,
  extractBinaryFromTarball,
  downloadBinary,
} = require('../../tools/redpanda-connect/connector-binary-analyzer');

const asset = name => ({ name, browser_download_url: `https://example.invalid/${name}` });

const tempDirs = [];
function tempDir (prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  tempDirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
});

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

});

describe('downloadBinary asset selection', () => {
  beforeEach(() => {
    mockListReleases.mockReset();
    mockGetReleaseByTag.mockReset();
  });

  // The asset name downloadBinary builds is the thing that has to be right, so
  // assert against a release that publishes every OTHER flavour: if the name
  // were built without the separator, or against the wrong prefix, one of these
  // decoys would be accepted as the OSS build.
  test('asks for the OSS asset of the exact version and refuses the other flavours', async () => {
    const { platform, arch } = getPlatformInfo();
    mockGetReleaseByTag.mockResolvedValue({
      data: {
        assets: [
          asset(`redpanda-connect-cloud_4.103.1_${platform}_${arch}.tar.gz`),
          asset(`redpanda-connect-cgo_4.103.1_${platform}_${arch}.tar.gz`),
          // Releases really do publish a fips flavour, which is why matching
          // has to be exact rather than prefix-ish.
          asset(`redpanda-connect-fips_4.103.1_${platform}_${arch}.tar.gz`),
          asset(`redpanda-connect_4.104.0_${platform}_${arch}.tar.gz`),
        ],
      },
    });

    await expect(downloadBinary('oss', '4.103.1', tempDir('oss-asset-')))
      .rejects.toThrow(`redpanda-connect_4.103.1_${platform}_${arch}.tar.gz`);

    expect(mockGetReleaseByTag).toHaveBeenCalledWith(
      expect.objectContaining({ tag: 'v4.103.1' })
    );
  });

  // Sharing one directory for the whole run is what stops the multi-release loop
  // re-downloading each interior version, but it also means nothing deletes the
  // binaries as it goes, so the cache has to be capped: a backfill touches
  // dozens of versions at ~320 MB each.
  test('caps the cache so a long backfill cannot fill the disk', async () => {
    const dir = tempDir('oss-cache-cap-');
    const { platform, arch } = getPlatformInfo();
    const versions = ['4.90.0', '4.91.0', '4.92.0', '4.93.0', '4.94.0', '4.95.0', '4.96.0'];
    const names = versions.map(v => `redpanda-connect-${v}-${platform}-${arch}`);
    names.forEach(n => fs.writeFileSync(path.join(dir, n), 'cached'));

    // A fresh module registry so the cap is measured from an empty cache.
    let analyzer;
    jest.isolateModules(() => {
      analyzer = require('../../tools/redpanda-connect/connector-binary-analyzer');
    });

    for (const version of versions) {
      await analyzer.downloadBinary('oss', version, dir);
    }

    expect(fs.existsSync(path.join(dir, names[0]))).toBe(false);
    names.slice(1).forEach(n => expect(fs.existsSync(path.join(dir, n))).toBe(true));
  });

  test('serves a binary already in the cache without touching the GitHub API', async () => {
    const { platform, arch } = getPlatformInfo();
    const dir = tempDir('oss-cache-hit-');
    const name = `redpanda-connect-4.90.0-${platform}-${arch}`;
    fs.writeFileSync(path.join(dir, name), 'cached');

    await expect(downloadBinary('oss', '4.90.0', dir)).resolves.toBe(path.join(dir, name));
    expect(mockGetReleaseByTag).not.toHaveBeenCalled();
  });
});

describe('getBinaryCacheDir', () => {
  // Binaries are ~320 MB extracted. docs-data is committed by the consuming
  // repo, so a binary landing there gets staged into the auto-docs PR.
  test('lives under the system temp dir, not in the working tree', () => {
    const dir = getBinaryCacheDir();
    expect(fs.realpathSync(dir).startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    expect(fs.realpathSync(dir).startsWith(fs.realpathSync(process.cwd()))).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
  });

  // One directory per process is what lets downloadBinary's skip-if-present
  // check serve the multi-release loop's second request for a version.
  test('is the same directory for every download in the process', () => {
    expect(getBinaryCacheDir()).toBe(getBinaryCacheDir());
  });
});

describe('extractBinaryFromTarball', () => {
  function makeTarball (dir, innerName, contents) {
    const stageDir = fs.mkdtempSync(path.join(dir, 'stage-'));
    fs.writeFileSync(path.join(stageDir, innerName), contents);
    const tarballPath = path.join(dir, 'asset.tar.gz');
    execFileSync('tar', ['-czf', tarballPath, '-C', stageDir, innerName]);
    fs.rmSync(stageDir, { recursive: true, force: true });
    return tarballPath;
  }

  // The archive's inner file name is not the destination name, and the cache
  // directory is shared, so it already holds other flavours and versions whose
  // names also contain 'redpanda-connect'. Extracting into the shared directory
  // and scanning it would pick a neighbour in readdir order: the cgo pass would
  // analyse the previously downloaded cloud binary and every requiresCgo flag
  // would be wrong.
  test('takes the binary from the tarball, not a neighbour in the destination', () => {
    const dir = tempDir('extract-');
    const decoy = path.join(dir, 'aaa-redpanda-connect-decoy');
    fs.writeFileSync(decoy, 'NEIGHBOUR');

    const tarballPath = makeTarball(dir, 'redpanda-connect', 'FROM-TARBALL');
    const destPath = path.join(dir, 'redpanda-connect-4.103.1-linux-amd64');

    expect(extractBinaryFromTarball(tarballPath, destPath)).toBe(destPath);
    expect(fs.readFileSync(destPath, 'utf8')).toBe('FROM-TARBALL');
    expect(fs.readFileSync(decoy, 'utf8')).toBe('NEIGHBOUR');
  });

  test('leaves the binary executable and no extraction directory behind', () => {
    const dir = tempDir('extract-clean-');
    const tarballPath = makeTarball(dir, 'redpanda-connect', 'BINARY');
    const destPath = path.join(dir, 'redpanda-connect-4.103.1-linux-amd64');

    extractBinaryFromTarball(tarballPath, destPath);

    expect(fs.statSync(destPath).mode & 0o111).toBeTruthy();
    expect(fs.readdirSync(dir).filter(f => f.includes('.extract-'))).toEqual([]);
  });

  test('reports a tarball that carries no binary', () => {
    const dir = tempDir('extract-empty-');
    const tarballPath = makeTarball(dir, 'README.md', 'no binary here');
    expect(() => extractBinaryFromTarball(tarballPath, path.join(dir, 'out')))
      .toThrow(/Binary not found after extraction/);
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

  // resolveAssetPrefix's message is actionable; 'Failed to fetch latest
  // version' is not. tools/ is published, so this is what other repos see.
  test('reports an unknown flavour directly, not as a GitHub API failure', async () => {
    await expect(getLatestVersion('fips')).rejects.toThrow(/^Unknown binary type "fips"/);
    expect(mockListReleases).not.toHaveBeenCalled();
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
