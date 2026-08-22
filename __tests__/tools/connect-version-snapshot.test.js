'use strict';

/**
 * Tests for loadConnectorDataForVersion, the function that turns a requested
 * Connect version into a connect-<version>.json snapshot.
 *
 * The snapshot it writes is the input to the diff, the drafts, the cloud/cgo
 * augmentation and everything published downstream, so the two properties that
 * matter are which binary it fetches and when it is allowed to skip fetching.
 * The handler writes augmentConnectorData output back over the same file, so a
 * stored snapshot is not necessarily raw binary output and cannot be reused
 * blindly.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// The handler transitively requires the Octokit client (ESM-only under Jest);
// stub it out since these tests never touch GitHub.
jest.mock('../../cli-utils/octokit-client', () => ({}));

const mockDownloadBinary = jest.fn();
const mockGetConnectorList = jest.fn();
const mockGetBinaryCacheDir = jest.fn();

jest.mock('../../tools/redpanda-connect/connector-binary-analyzer', () => ({
  downloadBinary: (...args) => mockDownloadBinary(...args),
  getConnectorList: (...args) => mockGetConnectorList(...args),
  getBinaryCacheDir: (...args) => mockGetBinaryCacheDir(...args),
}));

const {
  loadConnectorDataForVersion,
  snapshotReuseBlocker,
} = require('../../tools/redpanda-connect/rpcn-connector-docs-handler');

const RAW = { version: '4.103.1', inputs: [{ name: 'kafka', config: {} }] };

let dataDir;
let cacheDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-data-'));
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-cache-'));

  mockDownloadBinary.mockReset();
  mockGetConnectorList.mockReset();
  mockGetBinaryCacheDir.mockReset();

  mockGetBinaryCacheDir.mockImplementation(() => cacheDir);
  // Stand in for a real download: drop a file where the binary would land, so
  // a test can tell whether anything deleted it afterwards.
  mockDownloadBinary.mockImplementation(async (type, version, destDir) => {
    const binaryPath = path.join(destDir, `binary-${version}`);
    fs.writeFileSync(binaryPath, 'binary');
    return binaryPath;
  });
  // A real binary reports its own version, and the loader checks it, so derive
  // it from the path the stub download returned.
  mockGetConnectorList.mockImplementation(binaryPath => ({
    ...JSON.parse(JSON.stringify(RAW)),
    version: path.basename(binaryPath).replace('binary-', ''),
  }));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

const writeSnapshot = (version, data) =>
  fs.writeFileSync(path.join(dataDir, `connect-${version}.json`), JSON.stringify(data, null, 2));

const readSnapshot = version =>
  JSON.parse(fs.readFileSync(path.join(dataDir, `connect-${version}.json`), 'utf8'));

describe('loadConnectorDataForVersion - fetching', () => {
  test('fetches the OSS flavour of the requested version', async () => {
    await loadConnectorDataForVersion('4.103.1', dataDir);

    expect(mockDownloadBinary).toHaveBeenCalledTimes(1);
    expect(mockDownloadBinary).toHaveBeenCalledWith('oss', '4.103.1', cacheDir);
  });

  // docs-data is committed by the consuming repo and the auto-docs PR stages
  // untracked files, so a 320 MB binary must never be downloaded into it.
  test('downloads outside the data directory', async () => {
    await loadConnectorDataForVersion('4.103.1', dataDir);

    const [, , destDir] = mockDownloadBinary.mock.calls[0];
    expect(destDir.startsWith(dataDir)).toBe(false);
    expect(fs.readdirSync(dataDir)).toEqual(['connect-4.103.1.json']);
  });

  // The multi-release loop asks for every interior version twice, so the
  // binaries have to survive the call that fetched them.
  test('leaves downloaded binaries in place for the next call to reuse', async () => {
    await loadConnectorDataForVersion('4.103.1', dataDir, { forceFresh: true });
    await loadConnectorDataForVersion('4.104.0', dataDir, { forceFresh: true });

    expect(fs.existsSync(path.join(cacheDir, 'binary-4.103.1'))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, 'binary-4.104.0'))).toBe(true);
  });

  test('writes the snapshot under the requested version and returns it', async () => {
    const data = await loadConnectorDataForVersion('4.103.1', dataDir);

    expect(data).toEqual(RAW);
    expect(readSnapshot('4.103.1')).toEqual(RAW);
  });

  test('leaves no temp file behind', async () => {
    await loadConnectorDataForVersion('4.103.1', dataDir);
    expect(fs.readdirSync(dataDir).filter(f => f.endsWith('.tmp.json'))).toEqual([]);
  });

  test('carries the underlying reason into the thrown error', async () => {
    mockDownloadBinary.mockRejectedValue(new Error('Release v9.9.9 not found'));

    await expect(loadConnectorDataForVersion('9.9.9', dataDir))
      .rejects.toThrow(/Release v9\.9\.9 not found/);
  });

  // The version field is the only provenance the downstream templates get, so a
  // binary that reports a different version means the wrong asset arrived.
  test('refuses a fetched snapshot that reports a different version', async () => {
    mockGetConnectorList.mockReturnValue({ version: '4.104.0', inputs: [] });

    await expect(loadConnectorDataForVersion('4.103.1', dataDir))
      .rejects.toThrow(/reports version 4\.104\.0/);
    expect(fs.existsSync(path.join(dataDir, 'connect-4.103.1.json'))).toBe(false);
  });
});

describe('loadConnectorDataForVersion - reuse', () => {
  test('reuses a raw snapshot for the same version', async () => {
    writeSnapshot('4.103.1', RAW);

    const data = await loadConnectorDataForVersion('4.103.1', dataDir);

    expect(data).toEqual(RAW);
    expect(mockDownloadBinary).not.toHaveBeenCalled();
  });

  test('forceFresh refetches even when a raw snapshot exists', async () => {
    writeSnapshot('4.103.1', RAW);

    await loadConnectorDataForVersion('4.103.1', dataDir, { forceFresh: true });

    expect(mockDownloadBinary).toHaveBeenCalledTimes(1);
  });

  // The handler writes augmentConnectorData output back over this file. Reusing
  // it would re-augment already-augmented data: the cloud-only and cgo-only
  // entries injected by the previous run are not in the new analysis, so they
  // survive with their platform markers reset and a cgo-only connector is
  // published as an ordinary OSS one.
  test('refetches when the stored snapshot has already been augmented', async () => {
    writeSnapshot('4.103.1', {
      version: '4.103.1',
      inputs: [
        { name: 'kafka', config: {}, cloudSupported: true, requiresCgo: false },
        { name: 'zmq4', requiresCgo: true, cloudSupported: false },
        { name: 'snowflake_x', cloudOnly: true, cloudSupported: true },
      ],
    });

    const data = await loadConnectorDataForVersion('4.103.1', dataDir);

    expect(mockDownloadBinary).toHaveBeenCalledTimes(1);
    expect(data.inputs.map(c => c.name)).toEqual(['kafka']);
    expect(readSnapshot('4.103.1').inputs.map(c => c.name)).toEqual(['kafka']);
  });

  test('refetches when a single connector carries a platform marker', async () => {
    writeSnapshot('4.103.1', {
      version: '4.103.1',
      inputs: [{ name: 'kafka', config: {} }],
      caches: [{ name: 'memory', config: {}, cloudSupported: false }],
    });

    await loadConnectorDataForVersion('4.103.1', dataDir);

    expect(mockDownloadBinary).toHaveBeenCalledTimes(1);
  });

  test('refetches when the stored snapshot reports a different version', async () => {
    writeSnapshot('4.103.1', { version: '4.99.0', inputs: [{ name: 'kafka', config: {} }] });

    await loadConnectorDataForVersion('4.103.1', dataDir);

    expect(mockDownloadBinary).toHaveBeenCalledTimes(1);
    expect(readSnapshot('4.103.1').version).toBe('4.103.1');
  });

  test('refetches when the stored snapshot cannot be parsed', async () => {
    fs.writeFileSync(path.join(dataDir, 'connect-4.103.1.json'), '{ truncated');

    await loadConnectorDataForVersion('4.103.1', dataDir);

    expect(mockDownloadBinary).toHaveBeenCalledTimes(1);
    expect(readSnapshot('4.103.1')).toEqual(RAW);
  });
});

describe('snapshotReuseBlocker', () => {
  test('accepts raw binary output for the requested version', () => {
    expect(snapshotReuseBlocker(RAW, '4.103.1')).toBeNull();
  });

  test('accepts a snapshot with no version field', () => {
    expect(snapshotReuseBlocker({ inputs: [{ name: 'kafka' }] }, '4.103.1')).toBeNull();
  });

  test('names augmentation as the reason', () => {
    const augmented = { version: '4.103.1', inputs: [{ name: 'kafka', cloudSupported: true }] };
    expect(snapshotReuseBlocker(augmented, '4.103.1')).toMatch(/augmentation/);
  });

  test('names a version disagreement as the reason', () => {
    expect(snapshotReuseBlocker({ version: '4.99.0' }, '4.103.1')).toMatch(/4\.99\.0/);
  });

  test('rejects something that is not a connector index', () => {
    expect(snapshotReuseBlocker(null, '4.103.1')).toMatch(/not a connector index/);
    expect(snapshotReuseBlocker([], '4.103.1')).toMatch(/not a connector index/);
  });
});
