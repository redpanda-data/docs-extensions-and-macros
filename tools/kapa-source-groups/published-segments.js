// Reads the docs site's own sitemap to find out which version segments are
// actually published.
//
// WHY THIS EXISTS
// ---------------
// `validate kapa-source-groups` compares Kapa's sources and the committed
// mapping, but both of those are blind to the failure that actually matters: a
// new docs version being published with no Kapa source group behind it.
//
// Cutting a v/X.Y branch in redpanda-data/docs publishes /streaming/X.Y/ because
// the playbook globs `branches: v/*`, and no file changes in this repo or
// docs-site. Kapa has no write API, so no source or group appears either. The
// mapping and Kapa still agree with each other, and every reader on the new
// version silently falls back to the default segment.
//
// So the check needs a third input: what the site publishes. The sitemap is the
// right source because it reflects what is actually live, rather than what a
// playbook or a branch list intends.

const { fetchWithDeadline } = require('./fetch-with-deadline')

const SITEMAP_TIMEOUT_MS = 15000

/**
 * Extract the distinct version segments from a streaming sitemap.
 *
 * Parsed with a regex rather than an XML parser on purpose: the only thing wanted
 * is the path segment after /streaming/, this runs in CI where a dependency is
 * cost, and a malformed sitemap should yield "no segments found" (which the
 * caller treats as an error) rather than a parser exception.
 *
 * @param {string} xml - Sitemap XML
 * @returns {string[]} Sorted, de-duplicated version segments
 */
function parsePublishedSegments (xml) {
  const found = new Set()
  for (const m of String(xml || '').matchAll(/\/streaming\/([^/"'<\s]+)\//g)) {
    found.add(m[1])
  }
  return [...found].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
}

/**
 * Fetch the published version segments from a docs site.
 *
 * @param {object} options
 * @param {string} options.siteUrl - Site origin, e.g. https://docs.redpanda.com
 * @param {Function} [options.fetchImpl] - Injectable for tests
 * @returns {Promise<string[]>}
 * @throws {Error} On a non-OK response, a network failure, or an empty result
 */
async function fetchPublishedSegments ({ siteUrl, fetchImpl = globalThis.fetch } = {}) {
  if (!siteUrl) throw new Error('fetchPublishedSegments requires a siteUrl')
  const url = `${String(siteUrl).replace(/\/+$/, '')}/sitemap-streaming.xml`

  let res, body
  try {
    // The deadline covers the body read too; see fetch-with-deadline.js for
    // why clearing the timer after headers alone is not a timeout.
    ;({ res, body } = await fetchWithDeadline(
      fetchImpl, url, {}, SITEMAP_TIMEOUT_MS,
      (r) => (r.ok ? r.text() : null)
    ))
  } catch (err) {
    // A network failure means "could not find out", which the caller must keep
    // distinct from "a version is missing" so a scheduled run does not file an
    // issue every time the site is briefly unreachable.
    throw new Error(`Could not fetch ${url}: ${err.message}`)
  }

  if (!res.ok) throw new Error(`Could not fetch ${url}: ${res.status} ${res.statusText}`)

  const segments = parsePublishedSegments(body)
  if (segments.length === 0) {
    // An empty sitemap and a moved sitemap look identical, and treating either as
    // "nothing is published" would report every mapped segment as stale.
    throw new Error(`No /streaming/<version>/ URLs found in ${url}. The sitemap may have moved or changed shape.`)
  }
  return segments
}

/**
 * URL segments that publish without a durable version behind them.
 *
 * docs-site sets `latest_prerelease_version_segment: 'beta'`, so a branch with
 * `prerelease: true` publishes at /streaming/beta/ for the whole pre-GA cycle
 * (26.2's ran 2026-06-11 to 2026-07-28). No Kapa group is expected for it, and
 * a check that reported it as missing would file the same false issue every
 * Monday of every beta.
 */
const PRERELEASE_SEGMENTS = new Set(['beta'])

/** @param {string} segment */
function isPrereleaseSegment (segment) {
  return PRERELEASE_SEGMENTS.has(segment)
}

module.exports = { parsePublishedSegments, fetchPublishedSegments, isPrereleaseSegment, PRERELEASE_SEGMENTS, SITEMAP_TIMEOUT_MS }
