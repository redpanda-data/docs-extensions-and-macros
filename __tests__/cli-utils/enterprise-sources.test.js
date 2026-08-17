const { createSourceFetcher, loadEnterpriseSources, RAW } = require('../../cli-utils/enterprise-sources');

const TOKEN_VARS = [
  'GIT_CREDENTIALS',
  'REDPANDA_GITHUB_TOKEN',
  'ACTIONS_BOT_TOKEN',
  'GITHUB_TOKEN',
  'VBOT_GITHUB_API_TOKEN',
  'GH_TOKEN'
];

const okResponse = (text = 'content') => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () => text,
  body: { cancel: jest.fn().mockResolvedValue(undefined) }
});

const errorResponse = (status = 404, statusText = 'Not Found') => ({
  ok: false,
  status,
  statusText,
  text: async () => '',
  body: { cancel: jest.fn().mockResolvedValue(undefined) }
});

describe('enterprise-sources', () => {
  const savedEnv = {};

  beforeEach(() => {
    for (const name of TOKEN_VARS) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of TOKEN_VARS) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  describe('createSourceFetcher', () => {
    it('sends no Authorization header when no token is available', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(okResponse('body'));
      const { fetchText } = createSourceFetcher({ fetchImpl });

      await expect(fetchText('https://example.test/file')).resolves.toBe('body');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledWith('https://example.test/file', undefined);
    });

    it('attaches an Authorization: Bearer header when a token env var is set', async () => {
      process.env.GITHUB_TOKEN = 'ghp_from_env';
      const fetchImpl = jest.fn().mockResolvedValue(okResponse('body'));
      const { fetchText } = createSourceFetcher({ fetchImpl });

      await expect(fetchText('https://example.test/file')).resolves.toBe('body');
      expect(fetchImpl).toHaveBeenCalledWith('https://example.test/file', {
        headers: { Authorization: 'Bearer ghp_from_env' }
      });
    });

    it('retries a 404 without auth when a token was sent, and uses the retry result', async () => {
      const rejected = errorResponse(404);
      const fetchImpl = jest.fn()
        .mockResolvedValueOnce(rejected)
        .mockResolvedValueOnce(okResponse('public content'));
      const warn = jest.fn();
      const { fetchText, failedSources } = createSourceFetcher({ fetchImpl, warn, token: 'ghp_stale' });

      await expect(fetchText('https://example.test/file', 'some source')).resolves.toBe('public content');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      // First call authenticated, retry stripped of the Authorization header.
      expect(fetchImpl.mock.calls[0]).toEqual(['https://example.test/file', { headers: { Authorization: 'Bearer ghp_stale' } }]);
      expect(fetchImpl.mock.calls[1]).toEqual(['https://example.test/file']);
      expect(failedSources).toHaveLength(0);
      // The unconsumed 404 body is cancelled, and the rejected token is warned about once.
      expect(rejected.body.cancel).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/token was rejected/i);
    });

    it('warns about a rejected token only once across fetches', async () => {
      const fetchImpl = jest.fn(async (url, init) => (init ? errorResponse(404) : okResponse('public')));
      const warn = jest.fn();
      const { fetchText } = createSourceFetcher({ fetchImpl, warn, token: 'ghp_stale' });

      await fetchText('https://example.test/one', 'one');
      await fetchText('https://example.test/two', 'two');
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('reports a rejected token when the tokenless retry also fails', async () => {
      const fetchImpl = jest.fn()
        .mockResolvedValueOnce(errorResponse(404))
        .mockResolvedValueOnce(errorResponse(404));
      const { fetchText, failedSources } = createSourceFetcher({ fetchImpl, token: 'ghp_stale' });

      await expect(fetchText('https://example.test/file', 'some source')).resolves.toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(failedSources).toHaveLength(1);
      expect(failedSources[0].level).toBe('error');
      expect(failedSources[0].message).toMatch(/404 Not Found/);
      expect(failedSources[0].message).toMatch(/token was sent but rejected/i);
      expect(failedSources[0].message).toMatch(/expired or lack access/i);
    });

    it('throws with the rejected-token hint for unnamed sources when the retry also fails', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(errorResponse(404));
      const { fetchText } = createSourceFetcher({ fetchImpl, token: 'ghp_stale' });

      await expect(fetchText('https://example.test/file')).rejects.toThrow(/token was sent but rejected/i);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('includes the private-repo token hint on a tokenless 404', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(errorResponse(404));
      const { fetchText, failedSources } = createSourceFetcher({ fetchImpl });

      await expect(fetchText('https://example.test/file', 'some source')).resolves.toBeUndefined();
      // No token, so no retry.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(failedSources[0].message).toMatch(/set GITHUB_TOKEN \(or REDPANDA_GITHUB_TOKEN \/ ACTIONS_BOT_TOKEN\)/);
    });

    it('does not retry or hint on non-404 failures', async () => {
      const resp = errorResponse(500, 'Internal Server Error');
      const fetchImpl = jest.fn().mockResolvedValue(resp);
      const { fetchText, failedSources } = createSourceFetcher({ fetchImpl, token: 'ghp_valid' });

      await expect(fetchText('https://example.test/file', 'some source')).resolves.toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(failedSources[0].message).toMatch(/500 Internal Server Error/);
      expect(failedSources[0].message).not.toMatch(/token/i);
      // The unconsumed error body is cancelled.
      expect(resp.body.cancel).toHaveBeenCalled();
    });

    it('tolerates responses without a cancellable body', async () => {
      const resp = errorResponse(404);
      delete resp.body;
      const fetchImpl = jest.fn().mockResolvedValue(resp);
      const { fetchText, failedSources } = createSourceFetcher({ fetchImpl });

      await expect(fetchText('https://example.test/file', 'some source')).resolves.toBeUndefined();
      expect(failedSources).toHaveLength(1);
    });
  });

  describe('loadEnterpriseSources', () => {
    const baseOptions = { tag: 'dev', connectRef: 'main', docsRef: 'main' };

    it('fetches all remote sources when nothing is skipped or local', async () => {
      const fetchImpl = jest.fn(async (url) => okResponse(`content of ${url}`));
      const sources = await loadEnterpriseSources(baseOptions, { fetchImpl, token: null });

      const urls = fetchImpl.mock.calls.map(([url]) => url);
      expect(urls).toEqual([
        `${RAW}/redpanda-data/docs/main/shared/modules/ROOT/partials/enterprise-features.yml`,
        `${RAW}/redpanda-data/redpanda/dev/src/v/features/enterprise_features.h`,
        `${RAW}/redpanda-data/redpanda/dev/src/v/config/configuration.h`,
        `${RAW}/redpanda-data/connect/main/internal/plugins/info.csv`,
        `${RAW}/redpanda-data/docs/main/modules/get-started/pages/licensing/disable-enterprise-features.adoc`,
        `${RAW}/redpanda-data/rp-connect-docs/main/antora.yml`
      ]);
      expect(sources.registryYaml).toContain('enterprise-features.yml');
      expect(sources.infoCsv).toContain('info.csv');
      expect(sources.antoraYaml).toContain('antora.yml');
      expect(sources.failedSources).toHaveLength(0);
    });

    it('skips the connect info.csv and rp-connect-docs antora.yml fetches with skipConnect', async () => {
      const fetchImpl = jest.fn(async (url) => okResponse(`content of ${url}`));
      const sources = await loadEnterpriseSources({ ...baseOptions, skipConnect: true }, { fetchImpl, token: null });

      const urls = fetchImpl.mock.calls.map(([url]) => url);
      expect(urls.some((url) => url.includes('rp-connect-docs'))).toBe(false);
      expect(urls.some((url) => url.includes('/redpanda-data/connect/'))).toBe(false);
      expect(urls).toHaveLength(4);
      expect(sources.infoCsv).toBeUndefined();
      expect(sources.antoraYaml).toBeUndefined();
    });

    it('reads local files instead of fetching when paths are given', async () => {
      const fetchImpl = jest.fn(async (url) => okResponse(`content of ${url}`));
      const readLocal = jest.fn((p) => `local ${p}`);
      const options = { ...baseOptions, registry: 'registry.yml', disablePage: 'disable.adoc', antora: 'antora.yml' };
      const sources = await loadEnterpriseSources(options, { fetchImpl, readLocal, token: null });

      const urls = fetchImpl.mock.calls.map(([url]) => url);
      expect(urls).toHaveLength(3); // two core headers + info.csv only
      expect(sources.registryYaml).toBe('local registry.yml');
      expect(sources.disablePage).toBe('local disable.adoc');
      expect(sources.antoraYaml).toBe('local antora.yml');
    });

    it('throws with the token hint when the registry fetch 404s without a token', async () => {
      const fetchImpl = jest.fn(async () => errorResponse(404));
      await expect(loadEnterpriseSources(baseOptions, { fetchImpl, token: null }))
        .rejects.toThrow(/404 Not Found.*set GITHUB_TOKEN/);
    });

    it('collects named-source failures instead of throwing', async () => {
      const fetchImpl = jest.fn(async (url) =>
        url.includes('configuration.h') ? errorResponse(404) : okResponse('content'));
      const sources = await loadEnterpriseSources(baseOptions, { fetchImpl, token: null });

      expect(sources.configurationHeader).toBeUndefined();
      expect(sources.failedSources).toHaveLength(1);
      expect(sources.failedSources[0].message).toMatch(/core configuration\.h/);
    });
  });
});
