// Reads the docs site's own sitemap to find out which version segments are
// actually published.
//
// WHY THIS EXISTS
// ---------------
// The Kapa mapping is checked for drift by regenerating it and comparing against
// the committed file. That catches every Kapa-side change, but it is blind to the
// failure that actually matters: a new docs version being published with no Kapa
// source group behind it.
//
// A new version changes neither side of that comparison. Cutting a v/X.Y branch
// in redpanda-data/docs publishes /streaming/X.Y/ because the playbook globs
// `branches: v/*`, and no file changes in this repo or docs-site. Kapa has no
// write API, so no source or group appears either. Live Kapa and the committed
// mapping stay identical, the drift check says "in sync", and every reader on the
// new version silently falls back to the default segment.
//
// So the check needs a third input: what the site publishes. The sitemap is the
// right source because it reflects what is actually live, rather than what a
// playbook or a branch list intends.

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
 * Compare published segments against the mapping's segments.
 *
 * Direction matters, because the two mismatches need different actions:
 *
 * - published but unmapped: readers on that version are silently getting the
 *   default segment's content. Someone must create the Kapa source and group.
 * - mapped but unpublished: a version was EOL'd or unpublished and its Kapa
 *   source is still being retrieved. Nobody can read those docs, so answers can
 *   cite pages that 404.
 *
 * `beta` is called out separately rather than treated as missing: a prerelease
 * publishes at /streaming/beta/ during a pre-GA cycle and is expected to have no
 * durable group of its own.
 *
 * @param {string[]} published
 * @param {string[]} mapped
 * @returns {{missing: string[], stale: string[], prerelease: string[]}}
 */
function compareSegments (published, mapped) {
  const PRERELEASE = new Set(['beta'])
  const mappedSet = new Set(mapped)
  const publishedSet = new Set(published)

  const missing = []
  const prerelease = []
  for (const seg of published) {
    if (mappedSet.has(seg)) continue
    if (PRERELEASE.has(seg)) prerelease.push(seg)
    else missing.push(seg)
  }
  const stale = mapped.filter((seg) => !publishedSet.has(seg))

  return { missing, stale, prerelease }
}

module.exports = { parsePublishedSegments, fetchPublishedSegments, compareSegments, SITEMAP_TIMEOUT_MS }
