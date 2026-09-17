/**
 * fetch() with a deadline that covers the WHOLE exchange, body included.
 *
 * The obvious shape, `try { res = await fetch(url, { signal }) } finally
 * { clearTimeout(timer) }` and then `await res.text()`, only bounds the time to
 * headers. fetch resolves as soon as headers arrive, the timer is cleared, and a
 * server that then stalls mid-body holds the caller forever. For a scheduled
 * check that is a job that never finishes rather than one that exits 2, so
 * nobody is told and the next run queues behind it.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} init - Merged with the abort signal
 * @param {number} timeoutMs
 * @param {(res: Response, signal: AbortSignal) => Promise<*>} read
 *   Consumes the body while the timer is still armed. Return null for a
 *   response you do not want to read (a non-OK status, say) so the caller can
 *   inspect res.status first.
 * @returns {Promise<{res: Response, body: *}>}
 */
async function fetchWithDeadline (fetchImpl, url, init, timeoutMs, read) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal })
    const body = await read(res, controller.signal)
    return { res, body }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { fetchWithDeadline }
