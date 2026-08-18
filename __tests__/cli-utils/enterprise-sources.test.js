const { createSourceFetcher, loadEnterpriseSources, RAW } = require('../../cli-utils/enterprise-sources');

const TOKEN_VARS = [
  'GIT_CREDENTIALS',
  'REDPANDA_GITHUB_TOKEN',
  'ACTIONS_BOT_TOKEN',
  'GITHUB_TOKEN',
  'VBOT_GITHUB_API_TOKEN',
  'GH_TOKEN'
];

// A URL inside a repo the fetcher knows to be private, and one it treats as
// public. Credential hints must only ever be attached to the former.
const PRIVATE_URL = `${RAW}/redpanda-data/docs/main/shared/modules/ROOT/partials/enterprise-features.yml`;
const PUBLIC_URL = `${RAW}/redpanda-data/redpanda/dev/src/v/config/configuration.h`;

// Tests inject a no-op sleep so transient-retry paths run instantly.
const noSleep = jest.fn().mockResolvedValue(undefined);

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
    noSleep.mockClear();
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
      const { fetchText } = createSourceFetcher({ fetchImpl, sleep: noSleep });

      await expect(fetchText(PUBLIC_URL)).resolves.toBe('body');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledWith(PUBLIC_URL, undefined);
    });

    it('attaches an Authorization: Bearer header when a token env var is set', async () => {
      process.env.GITHUB_TOKEN = 'ghp_from_env';
      const fetchImpl = jest.fn().mockResolvedValue(okResponse('body'));
      const { fetchText } = createSourceFetcher({ fetchImpl, sleep: noSleep });

      await expect(fetchText(PUBLIC_URL)).resolves.toBe('body');
      expect(fetchImpl).toHaveBeenCalledWith(PUBLIC_URL, {
        headers: { Authorization: 'Bearer ghp_from_env' }
      });
    });

    it('retries a 404 without auth when a token was sent, and uses the retry result', async () => {
      const rejected = errorResponse(404);
      const fetchImpl = jest.fn()
        .mockResolvedValueOnce(rejected)
        .mockResolvedValueOnce(okResponse('public content'));
      const warn = jest.fn();
      const { fetchText, failedSources } = createSourceFetcher({ fetchImpl, warn, token: 'ghp_stale', sleep: noSleep });

      await expect(fetchText(PUBLIC_URL, 'some source')).resolves.toBe('public content');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      // First call authenticated, retry stripped of the Authorization header.
      expect(fetchImpl.mock.calls[0]).toEqual([PUBLIC_URL, { headers: { Authorization: 'Bearer ghp_stale' } }]);
      expect(fetchImpl.mock.calls[1]).toEqual([PUBLIC_URL, undefined]);
      expect(failedSources).toHaveLength(0);
      // The unconsumed 404 body is cancelled, and the rejected token is warned about once.
      expect(rejected.body.cancel).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/token was rejected/i);
    });

    it('warns about a rejected token only once across fetches', async () => {
      const fetchImpl = jest.fn(async (url, init) => (init ? errorResponse(404) : okResponse('public')));
      const warn = jest.fn();
      const { fetchText } = createSourceFetcher({ fetchImpl, warn, token: 'ghp_stale', sleep: noSleep });

      await fetchText(`${PUBLIC_URL}?one`, 'one');
      await fetchText(`${PUBLIC_URL}?two`, 'two');
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('reports a rejected token on a PRIVATE source when the tokenless retry also fails', async () => {
      const fetchImpl = jest.fn()
        .mockResolvedValueOnce(errorResponse(404))
        .mockResolvedValueOnce(errorResponse(404));
      const { fetchText, failedSources } = createSourceFetcher({ fetchImpl, token: 'ghp_stale', sleep: noSleep });

      await expect(fetchText(PRIVATE_URL, 'some source')).resolves.toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(failedSources).toHaveLength(1);
      expect(failedSources[0].level).toBe('error');
      expect(failedSources[0].message).toMatch(/404 Not Found/);
      expect(failedSources[0].message).toMatch(/token was sent but rejected/i);
      expect(failedSources[0].message).toMatch(/expired or not grant access/i);
    });

    it('adds no credential hint to a 404 on a PUBLIC source, with or without a token', async () => {
      // With a token: 404 -> tokenless retry -> still 404 -> plain 404, no hint.
      let fetchImpl = jest.fn().mockResolvedValue(errorResponse(404));
      let fetcher = createSourceFetcher({ fetchImpl, token: 'ghp_stale', sleep: noSleep });
      await expect(fetcher.fetchText(PUBLIC_URL, 'core configuration.h')).resolves.toBeUndefined();
      expect(fetcher.failedSources[0].message).toMatch(/404 Not Found\. The related checks did not run\.$/);

      // Without a token: same plain 404 — a public file that 404s is missing,
      // not unauthenticated, and suggesting credentials would mislead.
      fetchImpl = jest.fn().mockResolvedValue(errorResponse(404));
      fetcher = createSourceFetcher({ fetchImpl, token: null, sleep: noSleep });
      await expect(fetcher.fetchText(PUBLIC_URL, 'core configuration.h')).resolves.toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetcher.failedSources[0].message).not.toMatch(/token|credential|GIT_CREDENTIALS/i);
    });

    it('throws with the rejected-token hint for unnamed PRIVATE sources when the retry also fails', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(errorResponse(404));
      const { fetchText } = createSourceFetcher({ fetchImpl, token: 'ghp_stale', sleep: noSleep });

      await expect(fetchText(PRIVATE_URL)).rejects.toThrow(/token was sent but rejected/i);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('includes the private-repo token hint on a tokenless 404 of a PRIVATE source', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(errorResponse(404));
      const { fetchText, failedSources } = createSourceFetcher({ fetchImpl, token: null, sleep: noSleep });

      await expect(fetchText(PRIVATE_URL, 'some source')).resolves.toBeUndefined();
      // No token, so no tokenless retry.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(failedSources[0].message).toMatch(/set GIT_CREDENTIALS \(or GITHUB_TOKEN \/ REDPANDA_GITHUB_TOKEN \/ ACTIONS_BOT_TOKEN\)/);
    });

    it('retries transient 429/5xx responses and succeeds when the blip clears', async () => {
      const throttled = errorResponse(429, 'Too Many Requests');
      const fetchImpl = jest.fn()
        .mockResolvedValueOnce(throttled)
        .mockResolvedValueOnce(okResponse('recovered'));
      const { fetchText, failedSources } = createSourceFetcher({ fetchImpl, token: null, sleep: noSleep });

      await expect(fetchText(PUBLIC_URL, 'core configuration.h')).resolves.toBe('recovered');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(noSleep).toHaveBeenCalledWith(2000);
      expect(throttled.body.cancel).toHaveBeenCalled();
      expect(failedSources).toHaveLength(0);
    });

    it('retries network errors and succeeds when the blip clears', async () => {
      const fetchImpl = jest.fn()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce(okResponse('recovered'));
      const { fetchText, failedSources } = createSourceFetcher({ fetchImpl, token: null, sleep: noSleep });

      await expect(fetchText(PUBLIC_URL, 'core configuration.h')).resolves.toBe('recovered');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(failedSources).toHaveLength(0);
    });

    it('reports a persistent 5xx as an error finding after exhausting retries, with no credential hint', async () => {
      const fetchImpl = jest.fn(() => Promise.resolve(errorResponse(503, 'Service Unavailable')));
      const { fetchText, failedSources } = createSourceFetcher({ fetchImpl, token: 'ghp_valid', sleep: noSleep });

      await expect(fetchText(PUBLIC_URL, 'some source')).resolves.toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(failedSources[0].message).toMatch(/503 Service Unavailable/);
      expect(failedSources[0].message).not.toMatch(/token|credential/i);
    });

    it('reports a persistent network error as an error finding instead of crashing', async () => {
      const fetchImpl = jest.fn(() => Promise.reject(new Error('getaddrinfo ENOTFOUND')));
      const { fetchText, failedSources } = createSourceFetcher({ fetchImpl, token: null, sleep: noSleep });

      await expect(fetchText(PUBLIC_URL, 'some source')).resolves.toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(failedSources[0].message).toMatch(/getaddrinfo ENOTFOUND/);
      expect(failedSources[0].message).toMatch(/The related checks did not run/);
    });

    it('throws on a persistent network error for unnamed sources', async () => {
      const fetchImpl = jest.fn(() => Promise.reject(new Error('socket hang up')));
      const { fetchText } = createSourceFetcher({ fetchImpl, token: null, sleep: noSleep });

      await expect(fetchText(PRIVATE_URL)).rejects.toThrow(/socket hang up/);
    });

    it('does not treat a definitive 404 as transient (no retry loop)', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(errorResponse(404));
      const { fetchText } = createSourceFetcher({ fetchImpl, token: null, sleep: noSleep });

      await fetchText(PUBLIC_URL, 'some source');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(noSleep).not.toHaveBeenCalled();
    });

    it('tolerates responses without a cancellable body', async () => {
      const resp = errorResponse(404);
      delete resp.body;
      const fetchImpl = jest.fn().mockResolvedValue(resp);
      const { fetchText, failedSources } = createSourceFetcher({ fetchImpl, token: null, sleep: noSleep });

      await expect(fetchText(PUBLIC_URL, 'some source')).resolves.toBeUndefined();
      expect(failedSources).toHaveLength(1);
    });
  });

  describe('loadEnterpriseSources', () => {
    const baseOptions = { tag: 'dev', connectRef: 'main', docsRef: 'main' };

    it('fetches all remote sources and never touches rp-connect-docs', async () => {
      const fetchImpl = jest.fn(async (url) => okResponse(`content of ${url}`));
      const sources = await loadEnterpriseSources(baseOptions, { fetchImpl, token: null, sleep: noSleep });

      const urls = fetchImpl.mock.calls.map(([url]) => url);
      expect(urls).toEqual([
        `${RAW}/redpanda-data/docs/main/shared/modules/ROOT/partials/enterprise-features.yml`,
        `${RAW}/redpanda-data/redpanda/dev/src/v/features/enterprise_features.h`,
        `${RAW}/redpanda-data/redpanda/dev/src/v/config/configuration.h`,
        `${RAW}/redpanda-data/connect/main/internal/plugins/info.csv`,
        `${RAW}/redpanda-data/docs/main/modules/get-started/pages/licensing/disable-enterprise-features.adoc`
      ]);
      // The retired antora.yml source must not resurface: rp-connect-docs#485
      // removed the list it carried, so fetching it would buy a cross-repo
      // credential requirement for a comparison against nothing.
      expect(urls.some((url) => url.includes('rp-connect-docs'))).toBe(false);
      expect(sources.registryYaml).toContain('enterprise-features.yml');
      expect(sources.infoCsv).toContain('info.csv');
      expect(sources).not.toHaveProperty('antoraYaml');
      expect(sources.failedSources).toHaveLength(0);
    });

    it('skips the connect info.csv fetch with skipConnect', async () => {
      const fetchImpl = jest.fn(async (url) => okResponse(`content of ${url}`));
      const sources = await loadEnterpriseSources({ ...baseOptions, skipConnect: true }, { fetchImpl, token: null, sleep: noSleep });

      const urls = fetchImpl.mock.calls.map(([url]) => url);
      expect(urls.some((url) => url.includes('rp-connect-docs'))).toBe(false);
      expect(urls.some((url) => url.includes('/redpanda-data/connect/'))).toBe(false);
      expect(urls).toHaveLength(4);
      expect(sources.infoCsv).toBeUndefined();
    });

    it('reads local files instead of fetching when paths are given', async () => {
      const fetchImpl = jest.fn(async (url) => okResponse(`content of ${url}`));
      const readLocal = jest.fn((p) => `local ${p}`);
      const options = { ...baseOptions, registry: 'registry.yml', disablePage: 'disable.adoc' };
      const sources = await loadEnterpriseSources(options, { fetchImpl, readLocal, token: null, sleep: noSleep });

      const urls = fetchImpl.mock.calls.map(([url]) => url);
      expect(urls).toHaveLength(3); // two core headers + info.csv only
      expect(sources.registryYaml).toBe('local registry.yml');
      expect(sources.disablePage).toBe('local disable.adoc');
    });

    it("resolves connectRef 'latest' to the newest release tag before fetching info.csv", async () => {
      const fetchImpl = jest.fn(async (url) =>
        url.includes('api.github.com')
          ? okResponse(JSON.stringify({ tag_name: 'v4.65.0' }))
          : okResponse(`content of ${url}`));
      const sources = await loadEnterpriseSources({ ...baseOptions, connectRef: 'latest' }, { fetchImpl, token: null, sleep: noSleep });

      const urls = fetchImpl.mock.calls.map(([url]) => url);
      expect(urls).toContain('https://api.github.com/repos/redpanda-data/connect/releases/latest');
      expect(urls).toContain(`${RAW}/redpanda-data/connect/v4.65.0/internal/plugins/info.csv`);
      // The registry documents released state, so main must not be the baseline.
      expect(urls.some((url) => url.includes('/redpanda-data/connect/main/'))).toBe(false);
      expect(sources.connectRef).toBe('v4.65.0');
      expect(sources.infoCsv).toContain('info.csv');
    });

    it('an explicit --connect-ref bypasses release resolution', async () => {
      const fetchImpl = jest.fn(async (url) => okResponse(`content of ${url}`));
      const sources = await loadEnterpriseSources({ ...baseOptions, connectRef: 'v4.60.0' }, { fetchImpl, token: null, sleep: noSleep });

      const urls = fetchImpl.mock.calls.map(([url]) => url);
      expect(urls.some((url) => url.includes('api.github.com'))).toBe(false);
      expect(urls).toContain(`${RAW}/redpanda-data/connect/v4.60.0/internal/plugins/info.csv`);
      expect(sources.connectRef).toBe('v4.60.0');
    });

    it('falls back to the latest documented connect version when the GitHub API fails', async () => {
      const antoraYaml = 'name: ROOT\nasciidoc:\n  attributes:\n    latest-connect-version: 4.105.0\n';
      const fetchImpl = jest.fn(async (url) => {
        if (url.includes('api.github.com')) return errorResponse(503, 'Service Unavailable');
        if (url.includes('rp-connect-docs')) return okResponse(antoraYaml);
        return okResponse(`content of ${url}`);
      });
      const warn = jest.fn();
      const sources = await loadEnterpriseSources({ ...baseOptions, connectRef: 'latest' }, { fetchImpl, token: null, sleep: noSleep, warn });

      expect(sources.connectRef).toBe('v4.105.0');
      expect(sources.infoCsv).toContain('info.csv');
      const urls = fetchImpl.mock.calls.map(([url]) => url);
      expect(urls).toContain(`${RAW}/redpanda-data/rp-connect-docs/main/antora.yml`);
      expect(urls).toContain(`${RAW}/redpanda-data/connect/v4.105.0/internal/plugins/info.csv`);
      expect(warn.mock.calls.some(([msg]) => /falling back to the latest documented connect version/.test(msg))).toBe(true);
      expect(sources.failedSources).toHaveLength(0);
    });

    it('falls back too when the release response has no tag_name, and tolerates a v-prefixed attribute', async () => {
      const antoraYaml = 'asciidoc:\n  attributes:\n    latest-connect-version: v4.104.0\n';
      const fetchImpl = jest.fn(async (url) => {
        if (url.includes('api.github.com')) return okResponse('{}');
        if (url.includes('rp-connect-docs')) return okResponse(antoraYaml);
        return okResponse(`content of ${url}`);
      });
      const warn = jest.fn();
      const sources = await loadEnterpriseSources({ ...baseOptions, connectRef: 'latest' }, { fetchImpl, token: null, sleep: noSleep, warn });

      expect(sources.connectRef).toBe('v4.104.0');
      expect(warn.mock.calls.some(([msg]) => /no tag_name/.test(msg))).toBe(true);
    });

    it('reports an error finding and skips info.csv when both resolution routes fail', async () => {
      const fetchImpl = jest.fn(async (url) => {
        if (url.includes('api.github.com')) return errorResponse(503, 'Service Unavailable');
        if (url.includes('rp-connect-docs')) return errorResponse(404);
        return okResponse('content');
      });
      const warn = jest.fn();
      const sources = await loadEnterpriseSources({ ...baseOptions, connectRef: 'latest' }, { fetchImpl, token: null, sleep: noSleep, warn });

      expect(sources.infoCsv).toBeUndefined();
      expect(sources.failedSources.some((f) => f.message.includes('latest documented connect version'))).toBe(true);
      const urls = fetchImpl.mock.calls.map(([url]) => url);
      expect(urls.some((url) => url.includes('/internal/plugins/info.csv'))).toBe(false);
    });

    it('reports an error finding when the fallback antora.yml lacks latest-connect-version', async () => {
      const fetchImpl = jest.fn(async (url) => {
        if (url.includes('api.github.com')) return errorResponse(503, 'Service Unavailable');
        if (url.includes('rp-connect-docs')) return okResponse('name: ROOT\n');
        return okResponse('content');
      });
      const warn = jest.fn();
      const sources = await loadEnterpriseSources({ ...baseOptions, connectRef: 'latest' }, { fetchImpl, token: null, sleep: noSleep, warn });

      expect(sources.infoCsv).toBeUndefined();
      expect(sources.failedSources.some((f) => f.message.includes('no latest-connect-version attribute'))).toBe(true);
    });

    it('does not resolve or fetch anything connect-related with skipConnect', async () => {
      const fetchImpl = jest.fn(async (url) => okResponse(`content of ${url}`));
      await loadEnterpriseSources({ ...baseOptions, connectRef: 'latest', skipConnect: true }, { fetchImpl, token: null, sleep: noSleep });

      const urls = fetchImpl.mock.calls.map(([url]) => url);
      expect(urls.some((url) => url.includes('api.github.com') || url.includes('/redpanda-data/connect/'))).toBe(false);
    });

    it('throws with the token hint when the registry fetch 404s without a token', async () => {
      const fetchImpl = jest.fn(async () => errorResponse(404));
      await expect(loadEnterpriseSources(baseOptions, { fetchImpl, token: null, sleep: noSleep }))
        .rejects.toThrow(/404 Not Found.*set GIT_CREDENTIALS/);
    });

    it('collects named-source failures instead of throwing', async () => {
      const fetchImpl = jest.fn(async (url) =>
        url.includes('configuration.h') ? errorResponse(404) : okResponse('content'));
      const sources = await loadEnterpriseSources(baseOptions, { fetchImpl, token: null, sleep: noSleep });

      expect(sources.configurationHeader).toBeUndefined();
      expect(sources.failedSources).toHaveLength(1);
      expect(sources.failedSources[0].message).toMatch(/core configuration\.h/);
    });
  });
});
