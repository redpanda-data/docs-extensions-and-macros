'use strict';

/**
 * Tests for reading a release's connector data and Cloud and cgo flags from
 * the connect-<version>.json in its redpanda-connect-docs.tar.gz asset, and
 * for falling back to the binary analysis when the asset has no such file.
 *
 * The fixture is a trimmed copy of real docs_gen output: redpanda-connect#4947
 * at 936f1050, run as
 *   CGO_ENABLED=1 go run -tags x_benthos_extra ./cmd/tools/docs_gen -version 4.115.1 -date 2026-10-20T00:00:00Z
 * keeping a Cloud, a self-hosted-only, a cgo-only, and the cloud-only
 * component, two config objects, and one Bloblang function and method. Its
 * `undocumented` list is empty, as it is for that release.
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
  findReleaseAttachmentWithSource,
  checkUnexpectedFallback,
  reportUndocumentedComponents,
  resolvePlatformAnalysis,
  loadConnectorDataForVersion,
  publishConnectorAttachment,
} = require('../../tools/redpanda-connect/rpcn-connector-docs-handler');
const { generateConnectorDiffJson } = require('../../tools/redpanda-connect/report-delta');
const { generatePRSummary, generateMultiVersionPRSummary } = require('../../tools/redpanda-connect/pr-summary-formatter');

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

describe('undocumented components', () => {
  const ENTRY = { type: 'processors', name: 'x', builds: ['cloud', 'ai'] };
  const withUndocumented = (list) => ({ ...readFixture(), undocumented: list });
  const withoutField = () => {
    const data = readFixture();
    delete data.undocumented;
    return data;
  };
  const summaryFor = (undocumentedComponents) => {
    const attachment = readFixture();
    const diff = generateConnectorDiffJson(attachment, attachment, { oldVersion: '4.115.0', newVersion: VERSION });
    return generatePRSummary({ ...diff, undocumentedComponents });
  };

  test('a listed component is warned about and appears in the PR summary', () => {
    const entries = reportUndocumentedComponents(withUndocumented([ENTRY]));
    expect(entries).toEqual([ENTRY]);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn.mock.calls[0][0]).toMatch(
      /processors\/x ships in the cloud, ai builds but Connect's docs_gen doesn't document it, so it has no docs page\. Add its package to cmd\/tools\/docs_gen\/allcomponents/
    );
    const summary = summaryFor(entries);
    expect(summary).toContain('### Undocumented components');
    expect(summary).toContain('- `processors/x` (builds: cloud, ai)');
  });

  test('an empty list (the 936f1050 output) or an older asset without the field warns about nothing', () => {
    expect(readFixture().undocumented).toEqual([]);
    for (const data of [readFixture(), withoutField()]) {
      expect(reportUndocumentedComponents(data)).toEqual([]);
      expect(summaryFor(reportUndocumentedComponents(data))).not.toContain('Undocumented components');
    }
    expect(reportUndocumentedComponents(null)).toEqual([]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  test('malformed entries are skipped with one warning instead of throwing', () => {
    const entries = reportUndocumentedComponents(withUndocumented([ENTRY, { type: 'inputs' }, 'bogus', { ...ENTRY, builds: [] }]));
    expect(entries).toEqual([ENTRY]);
    const messages = console.warn.mock.calls.map((c) => c[0]);
    expect(messages.filter((m) => /malformed/.test(m))).toEqual([expect.stringContaining('Skipped 3 malformed entries')]);
    expect(messages.filter((m) => /docs_gen/.test(m))).toHaveLength(1);
    expect(() => reportUndocumentedComponents(withUndocumented({ not: 'a list' }))).not.toThrow();
  });

  test('the list is not a component group in the OSS snapshot or the platform data', () => {
    const attachment = withUndocumented([ENTRY]);
    expect(releaseAttachment.ossIndexFromAttachment(attachment)).not.toHaveProperty('undocumented');
    expect(releaseAttachment.binaryAnalysisFromAttachment(attachment).coveredTypes).not.toContain('undocumented');
  });
});

describe('platform data source in the PR summary', () => {
  const PREV = '4.115.0';
  const FILE = releaseAttachment.attachmentPath(VERSION);
  // Stand-in asset loader: version -> attachment, null (no file), or Error.
  const assets = (byVersion) => jest.spyOn(releaseAttachment, 'loadReleaseAttachment')
    .mockImplementation(async (v) => {
      const value = byVersion[v];
      if (value instanceof Error) throw value;
      return value === undefined ? null : value;
    });
  const singleSummary = (extra) => {
    const attachment = readFixture();
    const diff = generateConnectorDiffJson(attachment, attachment, { oldVersion: PREV, newVersion: VERSION });
    return generatePRSummary({ ...diff, ...extra });
  };
  const multiSummary = (extra) => generateMultiVersionPRSummary({
    metadata: { startVersion: '4.114.0', endVersion: VERSION, processedReleases: 2 },
    totalSummary: {},
    ...extra,
  });
  const run = async (byVersion, options = {}) => {
    assets(byVersion);
    const { source } = await findReleaseAttachmentWithSource(VERSION, options);
    const platformFallbackWarning = await checkUnexpectedFallback(source, PREV);
    return { source, platformFallbackWarning };
  };

  test('each reason renders its own source line', async () => {
    const cases = [
      [{ [VERSION]: readFixture() }, {}, 'release-asset', '**Platform data:** release asset'],
      [{}, {}, 'asset-missing-file', `**Platform data:** binaries (the v${VERSION} docs asset has no ${FILE})`],
      [{ [VERSION]: new Error('HTTP 502') }, {}, 'asset-unreadable', `**Platform data:** binaries (couldn't read the v${VERSION} docs asset: HTTP 502)`],
      [{ [VERSION]: readFixture() }, { cloudVersion: '4.114.0', cgoVersion: '4.114.0' }, 'override', `**Platform data:** binaries (Cloud v4.114.0 and cgo v4.114.0 were requested, so the v${VERSION} docs asset's flags don't apply)`],
      [{ [VERSION]: readFixture() }, { cgoVersion: '4.113.0' }, 'override', `**Platform data:** binaries (cgo v4.113.0 was requested, so the v${VERSION} docs asset's flags don't apply)`],
    ];
    for (const [byVersion, options, reason, line] of cases) {
      jest.restoreAllMocks();
      const { source } = await run(byVersion, options);
      expect(source.reason).toBe(reason);
      expect(singleSummary({ platformSource: source })).toContain(line);
      expect(multiSummary({ platformSource: source })).toContain(line);
    }
  });

  test('a multi-release summary lists only the releases whose source differs', () => {
    const at = (version, reason) => ({ reason, version, file: releaseAttachment.attachmentPath(version) });
    const summary = multiSummary({
      platformSource: at(VERSION, 'release-asset'),
      releasePlatformSources: [at('4.114.1', 'asset-missing-file'), at(PREV, 'release-asset')],
    });
    expect(summary).toContain('**Platform data:** release asset');
    expect(summary).toContain('**Platform data (4.114.1):** binaries (the v4.114.1 docs asset has no modules/components/attachments/connect-4.114.1.json)');
    expect(summary).not.toContain(`**Platform data (${PREV})`);
  });

  test.each([
    ['missing from', null],
    ['unreadable in', new Error('HTTP 502')],
  ])('warns when the previous release has the file and it is %s the current one', async (_label, current) => {
    const { platformFallbackWarning } = await run({ [PREV]: readFixture(), [VERSION]: current });
    expect(platformFallbackWarning).toEqual({ version: VERSION, previousVersion: PREV });
    const message = `v${PREV} shipped connect-${PREV}.json but v${VERSION} doesn't, so this run compared binaries instead. Check redpanda-data/connect's release docs step (docs_gen -version).`;
    expect(console.warn).toHaveBeenCalledWith(`Warning: ${message}`);
    for (const summary of [singleSummary({ platformFallbackWarning }), multiSummary({ platformFallbackWarning })]) {
      expect(summary).toContain(`> [!WARNING]\n> ${message}`);
      expect(summary.indexOf('[!WARNING]')).toBeLessThan(summary.indexOf('## Redpanda Connect Documentation Update'));
    }
  });

  test('no warning when neither release has the file (older releases)', async () => {
    const { platformFallbackWarning } = await run({});
    expect(platformFallbackWarning).toBeNull();
    expect(singleSummary({ platformFallbackWarning })).not.toContain('[!WARNING]');
  });

  test('no warning when the current release has the file', async () => {
    const { platformFallbackWarning } = await run({ [PREV]: readFixture(), [VERSION]: readFixture() });
    expect(platformFallbackWarning).toBeNull();
  });

  test('no warning for an override, and the previous asset is never downloaded', async () => {
    const { platformFallbackWarning } = await run({ [PREV]: readFixture(), [VERSION]: readFixture() }, { cgoVersion: '4.114.0' });
    expect(platformFallbackWarning).toBeNull();
    expect(releaseAttachment.loadReleaseAttachment).not.toHaveBeenCalled();
  });

  test('no warning, and no throw, when the previous version is unknown or its asset is unreadable', async () => {
    const load = assets({ [PREV]: new Error('HTTP 503') });
    const source = { reason: 'asset-missing-file', version: VERSION, file: FILE };
    await expect(checkUnexpectedFallback(source, null)).resolves.toBeNull();
    await expect(checkUnexpectedFallback(source, VERSION)).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
    await expect(checkUnexpectedFallback(source, PREV)).resolves.toBeNull();
    expect(logSpy.mock.calls.map((c) => c[0]).join('\n')).toMatch(/could not read the v4\.115\.0 docs asset \(HTTP 503\)/);
    expect(console.warn).not.toHaveBeenCalled();
  });
});
