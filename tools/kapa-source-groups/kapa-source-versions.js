/**
 * Which streaming docs versions Kapa has a source for.
 *
 * Kapa names one crawl per published version, `Documentation (24.2)`,
 * `Documentation (current)`, and so on. The sources endpoint exposes no URL,
 * only the name, so the version is read from the name. That convention is the
 * contract this check depends on: a crawl named anything else is invisible to it
 * and reported as missing, which is the right direction to be wrong in.
 *
 * A source that exists but sits in no group is reported separately. Unassigned
 * sources are GLOBAL in Kapa, returned for every query on every version, so a
 * `Documentation (26.2)` left unassigned would leak 26.2 content into 24.2
 * readers' answers with no error anywhere.
 */

const { KAPA_API_BASE } = require('../../cli-utils/kapa-credentials')
const { fetchAllPages, toList, idOf } = require('./generate-kapa-source-groups.js')

const SOURCE_NAME_RE = /^Documentation \(([^)]+)\)$/

/**
 * @param {string} name - A Kapa source name
 * @returns {string|null} The version segment, or null when the name is not a docs crawl
 */
function versionFromSourceName (name) {
  const m = typeof name === 'string' ? name.match(SOURCE_NAME_RE) : null
  if (!m) return null
  const v = m[1].trim()
  // Cloud and RPCN crawls use the same naming but are not streaming versions.
  return /^(\d+\.\d+|current)$/.test(v) ? v : null
}

/**
 * Classify a list of Kapa source objects.
 *
 * @param {Array<{name: string, source_groups?: unknown}>} sources
 * @returns {{covered: Set<string>, unassigned: Set<string>}}
 *   covered: versions with a source that is in at least one group
 *   unassigned: versions with a source that is in no group (global)
 */
function classifySources (sources) {
  const covered = new Set()
  const unassigned = new Set()
  for (const s of sources || []) {
    const v = versionFromSourceName(s && s.name)
    if (!v) continue
    const inGroup = toList(s.source_groups).some((g) => Boolean(idOf(g)))
    if (inGroup) covered.add(v)
    else unassigned.add(v)
  }
  // A version with two sources, one grouped and one not, is covered: the
  // grouped one scopes correctly. The stray global is still worth a report,
  // but it is a generator concern (it lists global_sources), not a gap here.
  for (const v of covered) unassigned.delete(v)
  return { covered, unassigned }
}

/**
 * @param {{apiKey: string, projectId: string, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{covered: Set<string>, unassigned: Set<string>}>}
 */
async function fetchKapaSourceVersions ({ apiKey, projectId, fetchImpl }) {
  if (!apiKey) throw new Error('fetchKapaSourceVersions requires an apiKey')
  if (!projectId) throw new Error('fetchKapaSourceVersions requires a projectId')
  const url = `${KAPA_API_BASE}/ingestion/v1/projects/${projectId}/sources/`
  const sources = await fetchAllPages(url, apiKey, fetchImpl)
  return classifySources(sources)
}

module.exports = { versionFromSourceName, classifySources, fetchKapaSourceVersions, SOURCE_NAME_RE }
