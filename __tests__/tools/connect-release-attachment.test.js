'use strict';

/**
 * Tests for reading a release's connector data and Cloud and cgo flags from
 * the connect-<version>.json in its redpanda-connect-docs.tar.gz asset, and
 * for falling back to the binary analysis when the asset has no such file.
 *
 * The fixture is a trimmed copy of real docs_gen output: redpanda-connect#4947
 * at 6210ac06, run as
 *   CGO_ENABLED=1 go run -tags x_benthos_extra ./cmd/tools/docs_gen -version 4.115.1 -date 2026-10-20T00:00:00Z
 * keeping a Cloud, a self-hosted-only, a cgo-only, and the cloud-only
 * component, two config objects, and one Bloblang function and method.
 */

jest.mock('../../cli-utils/octokit-client', () => ({}));

const mockAnalyzeAllBinaries = jest.fn();
const mockDownloadBinary = jest.fn();
const mockGetConnectorList = jest.fn();

jest.mock('../../tools/redpanda-connect/connector-binary-analyzer', () => ({
  analyzeAllBinaries: (...args) => mockAnalyzeAllBinaries(...args),
  downloadBinary: (...args) => mockDownloadBinary(...args),
  getConnectorList: (...args) => mockGetConnectorList(...args),
  getBinaryCacheDir: () => require('os').tmpdir(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const tar = require('tar');

const releaseAttachment = require('../../tools/redpanda-connect/release-attachment');
const {
  augmentConnectorData,
  findReleaseAttachment,
  resolvePlatformAnalysis,
  loadConnectorDataForVersion,
  publishConnectorAttachment,
} = require('../../tools/redpanda-connect/rpcn-connector-docs-handler');
const { generateConnectorDiffJson } = require('../../tools/redpanda-connect/report-delta');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'connect-release-attachment', 'connect-4.115.1.json');
const VERSION = '4.115.1';
const readFixture = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const keys = (list) => list.map((c) => `${c.type}:${c.name}`).sort();

const tempDirs = [];
function tempDir () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-attachment-'));
  tempDirs.push(dir);
  return dir;
}

// A docs asset whose modules/ tree has the given files, as a gzipped tar.
function docsAsset (files) {
  const root = tempDir();
  for (const [rel, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), contents);
  }
  const out = path.join(tempDir(), 'redpanda-connect-docs.tar.gz');
  tar.c({ gzip: true, sync: true, file: out, cwd: root, portable: true }, ['modules']);
  return fs.readFileSync(out);
}

// fetch stand-in for the public release download URL.
const serving = (archive) => jest.fn(async () => (archive
  ? { ok: true, status: 200, arrayBuffer: async () => archive }
  : { ok: false, status: 404, statusText: 'Not Found' }));

const PARTIAL = { 'modules/components/partials/fields/inputs/generate.adoc': '// fields\n' };

let logSpy;
beforeEach(() => {
  releaseAttachment.clearAttachmentCache();
  mockAnalyzeAllBinaries.mockReset();
  mockDownloadBinary.mockReset();
  mockGetConnectorList.mockReset();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

afterAll(() => {
  tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe('loadReleaseAttachment', () => {
  test('reads connect-<version>.json from the release docs asset', async () => {
    const fetchImpl = serving(docsAsset({ ...PARTIAL, [releaseAttachment.attachmentPath(VERSION)]: fs.readFileSync(FIXTURE) }));
    const data = await releaseAttachment.loadReleaseAttachment(VERSION, { fetchImpl, token: null });
    expect(data).toEqual(readFixture());
    expect(fetchImpl.mock.calls[0][0]).toBe('https://github.com/redpanda-data/connect/releases/download/v4.115.1/redpanda-connect-docs.tar.gz');
  });

  test('returns null for an asset with no attachment (v4.115.x and older)', async () => {
    const fetchImpl = serving(docsAsset(PARTIAL));
    await expect(releaseAttachment.loadReleaseAttachment(VERSION, { fetchImpl, token: null })).resolves.toBeNull();
  });

  test('returns null for a release with no docs asset', async () => {
    await expect(releaseAttachment.loadReleaseAttachment(VERSION, { fetchImpl: serving(null), token: null })).resolves.toBeNull();
  });

  test('downloads each version once per process', async () => {
    const fetchImpl = serving(docsAsset({ [releaseAttachment.attachmentPath(VERSION)]: fs.readFileSync(FIXTURE) }));
    await releaseAttachment.loadReleaseAttachment(VERSION, { fetchImpl, token: null });
    await releaseAttachment.loadReleaseAttachment(VERSION, { fetchImpl, token: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('rejects an attachment for another version or without platform flags', async () => {
    const other = { ...readFixture(), version: '4.115.0' };
    const fetchImpl = serving(docsAsset({ [releaseAttachment.attachmentPath(VERSION)]: JSON.stringify(other) }));
    await expect(releaseAttachment.loadReleaseAttachment(VERSION, { fetchImpl, token: null })).rejects.toThrow(/reports version 4\.115\.0/);

    const unflagged = releaseAttachment.ossIndexFromAttachment(readFixture());
    expect(() => releaseAttachment.validateAttachment(unflagged, VERSION)).toThrow(/without cloudSupported and requiresCgo/);
  });
});

describe('platform data from the attachment', () => {
  test('has the shape and contents analyzeAllBinaries() returns', () => {
    const ba = releaseAttachment.binaryAnalysisFromAttachment(readFixture());
    expect(ba.ossVersion).toBe(VERSION);
    expect(keys(ba.comparison.inCloud)).toEqual([
      'caches:memory', 'config:http', 'config:shutdown_delay', 'inputs:generate', 'outputs:drop', 'processors:noop',
    ]);
    expect(keys(ba.comparison.notInCloud)).toEqual(['caches:file', 'inputs:beanstalkd', 'outputs:beanstalkd', 'processors:command']);
    expect(keys(ba.comparison.cloudOnly)).toEqual(['processors:a2a_message']);
    expect(keys(ba.cgoOnly)).toEqual(['inputs:zmq4', 'outputs:zmq4', 'processors:ffi']);
    // Full schema, as the binary analysis carries for the components it adds.
    expect(ba.cgoOnly.find((c) => c.name === 'ffi').config).toBeDefined();
    expect(ba.comparison.cloudOnly[0].config).toBeDefined();
    // Bloblang carries no platform flags in the attachment.
    expect(ba.coveredTypes).not.toContain('bloblang-functions');
    expect(ba.coveredTypes).toContain('config');
  });

  test('the OSS snapshot drops the cgo-only and cloud-only components and every flag', () => {
    const oss = releaseAttachment.ossIndexFromAttachment(readFixture());
    expect(oss.inputs.map((c) => c.name).sort()).toEqual(['beanstalkd', 'generate']);
    expect(oss.processors.map((c) => c.name).sort()).toEqual(['command', 'noop']);
    expect(JSON.stringify(oss)).not.toMatch(/"(cloudSupported|requiresCgo|cloudOnly)"/);
    expect(oss['bloblang-functions']).toEqual(readFixture()['bloblang-functions']);
  });

  test('augmenting the OSS snapshot reproduces every flag in the attachment', () => {
    const attachment = readFixture();
    const { augmentedData } = augmentConnectorData(
      releaseAttachment.ossIndexFromAttachment(attachment),
      releaseAttachment.binaryAnalysisFromAttachment(attachment)
    );
    const flags = (data) => Object.fromEntries(['inputs', 'outputs', 'processors', 'caches', 'config'].flatMap((type) =>
      data[type].map((c) => [`${type}:${c.name}`, [c.cloudSupported, c.requiresCgo, c.cloudOnly === true]])));
    expect(flags(augmentedData)).toEqual(flags(attachment));
  });
});

describe('choosing between the attachment and the binaries', () => {
  test('a release with the attachment skips the binary analysis', async () => {
    jest.spyOn(releaseAttachment, 'loadReleaseAttachment').mockResolvedValue(readFixture());
    const attachment = await findReleaseAttachment(VERSION, {});
    const ba = await resolvePlatformAnalysis(VERSION, { attachment, dataDir: tempDir() });
    expect(mockAnalyzeAllBinaries).not.toHaveBeenCalled();
    expect(ba.source).toBe('release-asset');
    expect(keys(ba.comparison.cloudOnly)).toEqual(['processors:a2a_message']);
  });

  test('a release without the attachment is analyzed from the binaries', async () => {
    jest.spyOn(releaseAttachment, 'loadReleaseAttachment').mockResolvedValue(null);
    const fromBinaries = { ossVersion: VERSION, comparison: { inCloud: [], notInCloud: [], cloudOnly: [] }, cgoOnly: [], cgoIndex: {} };
    mockAnalyzeAllBinaries.mockResolvedValue(fromBinaries);
    const dataDir = tempDir();
    const attachment = await findReleaseAttachment(VERSION, {});
    const options = { skipCloud: false, skipCgo: false, cgoVersion: null };
    const ba = await resolvePlatformAnalysis(VERSION, { attachment, cloudVersion: '4.115.0', dataDir, analysisOptions: options });
    expect(attachment).toBeNull();
    expect(mockAnalyzeAllBinaries).toHaveBeenCalledWith(VERSION, '4.115.0', dataDir, options);
    expect(ba).toBe(fromBinaries);
  });

  test('an unreadable asset falls back to the binaries', async () => {
    jest.spyOn(releaseAttachment, 'loadReleaseAttachment').mockRejectedValue(new Error('HTTP 502'));
    await expect(findReleaseAttachment(VERSION, {})).resolves.toBeNull();
  });

  test('an explicit --cloud-version or --cgo-version uses the binaries', async () => {
    const load = jest.spyOn(releaseAttachment, 'loadReleaseAttachment').mockResolvedValue(readFixture());
    await expect(findReleaseAttachment(VERSION, { cloudVersion: '4.114.0' })).resolves.toBeNull();
    await expect(findReleaseAttachment(VERSION, { cgoVersion: '4.114.0' })).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  test('the connector snapshot comes from the attachment without downloading a binary', async () => {
    const dataDir = tempDir();
    const data = await loadConnectorDataForVersion(VERSION, dataDir, { forceFresh: true, attachment: readFixture() });
    expect(mockDownloadBinary).not.toHaveBeenCalled();
    expect(data).toEqual(releaseAttachment.ossIndexFromAttachment(readFixture()));
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, `connect-${VERSION}.json`), 'utf8'))).toEqual(data);
  });
});

describe('publishConnectorAttachment', () => {
  const setup = () => {
    const root = tempDir();
    const dir = path.join(root, 'modules', 'components', 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'connect-4.115.0.json'), '{}');
    return { root, dir };
  };

  test('writes nothing when the data came from the release asset, and keeps older files', () => {
    const { root, dir } = setup();
    const written = publishConnectorAttachment({ newIndex: readFixture(), newVersion: VERSION, fromReleaseAsset: true, root });
    expect(written).toBeNull();
    expect(fs.readdirSync(dir)).toEqual(['connect-4.115.0.json']);
  });

  test('control: binary-analyzed data replaces the older file', () => {
    const { root, dir } = setup();
    publishConnectorAttachment({ newIndex: readFixture(), newVersion: VERSION, fromReleaseAsset: false, root });
    expect(fs.readdirSync(dir)).toEqual([`connect-${VERSION}.json`]);
  });

  test('still writes when overrides have to be merged in', () => {
    const { root, dir } = setup();
    const overrides = path.join(root, 'overrides.json');
    fs.writeFileSync(overrides, '{}');
    publishConnectorAttachment({ newIndex: readFixture(), newVersion: VERSION, overrides, fromReleaseAsset: true, root });
    expect(fs.readdirSync(dir)).toEqual([`connect-${VERSION}.json`]);
  });
});

describe('diff against an older binary analysis', () => {
  test('Bloblang the attachment does not flag is not reported as removed from Cloud', () => {
    const attachment = readFixture();
    const ba = releaseAttachment.binaryAnalysisFromAttachment(attachment);
    const oldBa = {
      comparison: {
        inCloud: [...ba.comparison.inCloud, { type: 'bloblang-functions', name: 'now', status: 'stable' }, { type: 'inputs', name: 'gone', status: 'stable' }],
      },
      cgoOnly: ba.cgoOnly,
    };
    const diff = generateConnectorDiffJson(attachment, attachment, { oldVersion: '4.115.0', newVersion: VERSION, binaryAnalysis: ba, oldBinaryAnalysis: oldBa });
    expect(diff.binaryAnalysis.changes.cloud.removed).toEqual([{ type: 'inputs', name: 'gone', status: 'stable' }]);
  });
});
