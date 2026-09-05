'use strict';

/**
 * The deadline must cover body consumption, not just time-to-headers. Review
 * caught both Kapa fetches clearing their abort timer in a `finally` right
 * after fetch() resolved, then awaiting res.text() / res.json() with nothing
 * armed. A server that sends headers and stalls would hold the scheduled job
 * open indefinitely: not exit 2, not an issue, just silence.
 */
const { fetchWithDeadline } = require('../../tools/kapa-source-groups/fetch-with-deadline');
const { fetchPublishedSegments } = require('../../tools/kapa-source-groups/published-segments');
const { fetchAllPages } = require('../../tools/kapa-source-groups/generate-kapa-source-groups');

// Headers arrive instantly; the body never does unless the signal aborts it.
const stalledBody = (signal) => new Promise((_, reject) => {
  if (signal.aborted) return reject(new Error('aborted'));
  signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});
const stallingFetch = (init) => Promise.resolve({
  ok: true, status: 200, statusText: 'OK',
  text: () => stalledBody(init.signal),
  json: () => stalledBody(init.signal),
});

describe('fetchWithDeadline', () => {
  it('aborts a body read that outlives the deadline', async () => {
    const started = Date.now();
    await expect(
      fetchWithDeadline((url, init) => stallingFetch(init), 'http://x', {}, 30, (r, signal) => r.text())
    ).rejects.toThrow(/aborted/);
    // Bounded by the deadline, not by the body ever arriving.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('returns the body when it arrives in time', async () => {
    const fetchImpl = async () => ({ ok: true, text: async () => 'hello' });
    const { res, body } = await fetchWithDeadline(fetchImpl, 'http://x', {}, 1000, (r) => r.text());
    expect(res.ok).toBe(true);
    expect(body).toBe('hello');
  });

  it('lets the reader skip the body on a non-OK status so the caller can report it', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, statusText: 'Forbidden', json: async () => { throw new Error('should not read'); } });
    const { res, body } = await fetchWithDeadline(fetchImpl, 'http://x', {}, 1000, (r) => (r.ok ? r.json() : null));
    expect(res.status).toBe(403);
    expect(body).toBeNull();
  });

  it('always clears its timer, so a test process is not held open', async () => {
    const spy = jest.spyOn(global, 'clearTimeout');
    await fetchWithDeadline(async () => ({ ok: true, text: async () => '' }), 'http://x', {}, 1000, (r) => r.text());
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('both Kapa fetches are bounded through the body', () => {
  // These use the real callers with the stalling fetch, so the guarantee is on
  // the code the scheduled job runs and not only on the helper.
  const SITEMAP_TIMEOUT_MS = require('../../tools/kapa-source-groups/published-segments').SITEMAP_TIMEOUT_MS;

  it('fetchPublishedSegments gives up on a stalled sitemap body', async () => {
    jest.useFakeTimers();
    try {
      const p = fetchPublishedSegments({ siteUrl: 'https://docs.example', fetchImpl: (url, init) => stallingFetch(init) });
      // Attach the rejection handler BEFORE advancing, or Node reports an
      // unhandled rejection in the gap.
      const outcome = expect(p).rejects.toThrow(/Could not fetch .*aborted/);
      await jest.advanceTimersByTimeAsync(SITEMAP_TIMEOUT_MS + 1);
      await outcome;
    } finally {
      jest.useRealTimers();
    }
  });

  it('fetchAllPages gives up on a stalled Kapa body', async () => {
    jest.useFakeTimers();
    try {
      const p = fetchAllPages('https://api.example/x', 'key', (url, init) => stallingFetch(init));
      const outcome = expect(p).rejects.toThrow(/aborted/);
      await jest.advanceTimersByTimeAsync(60000);
      await outcome;
    } finally {
      jest.useRealTimers();
    }
  });
});
