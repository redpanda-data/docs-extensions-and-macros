// Standalone module to read Kapa source groups and emit the mapping that tells
// each docs surface which group to scope a query to.
// Usage: generateKapaSourceGroups({ apiKey, projectId, defaultSegment })
//
// WHY THIS EXISTS
// ---------------
// Kapa indexes several separately crawled copies of the Self-Managed docs (one
// per version). Without scoping, a reader on a 25.1 page gets answers drawn from
// any of them: one measured call returned the same architecture page six times at
// six different versions. Source groups fix that at retrieval time, but the group
// UUIDs live in the Kapa dashboard while the version list lives in Antora, so
// something has to join the two. This generator is that join.
//
// The Kapa side is read-only by design: Kapa publishes no endpoint to create a
// group or assign a source to one ("we do not provide an API endpoint for
// uploading or managing sources"). So this reads the state a human created in the
// dashboard and turns it into a committed artifact the build and the browser can
// both consume. It never mutates Kapa.
//
// RESPONSE SHAPES (observed live 2026-09-04, project 97f44223)
// -----------------------------------------------------------
// GET /ingestion/v1/projects/:id/source-groups/
//   { count, next, previous, results: [
//       { id, name, type: 'product'|'version', description, sub_groups: [...], created_at, updated_at }
//   ]}
//
// GET /ingestion/v1/projects/:id/sources/
//   { count, next, previous, results: [
//       { id, name, type: 'scrape'|'openapi'|'custom_qa'|'youtube'|..., source_groups: [...], ... }
//   ]}
//
// Kapa's published OpenAPI schema declares BOTH `sub_groups` and `source_groups`
// as `"type":"string"`. That is a spec bug: live responses return arrays. The
// parsers below accept an array, a single object, a comma-separated string, or
// null, so a schema fix on Kapa's side cannot break us either way.
//
// "GLOBAL" IS NOT A GROUP
// ----------------------
// The dashboard shows a "Global sources" row, and Kapa's own docs call it "a
// special Global group that exists by default" with an ID. Both are misleading.
// The API returns no such group, and an unassigned source reports
// `source_groups: []`. Global is simply "assigned to no group". Assigning a
// source to a version group is what takes it out of the global set; unassigned
// sources stay global and are returned alongside whichever group a query scopes
// to. That is what keeps Agentic Data Plane content reachable from every page.

const { KAPA_API_BASE, kapaAuthHeaders } = require('../../cli-utils/kapa-credentials')

const REQUEST_TIMEOUT_MS = 15000

/**
 * Normalise the fields Kapa mis-declares as strings. Accepts an array, a single
 * object, a comma-separated string of ids, or null/undefined.
 *
 * @param {*} value
 * @returns {Array<object|string>}
 */
function toList (value) {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined || value === '') return []
  if (typeof value === 'string') {
    return value.split(',').map((s) => s.trim()).filter(Boolean)
  }
  if (typeof value === 'object') return [value]
  return []
}

/** Pull an id out of either an object or a bare id string. */
function idOf (entry) {
  if (typeof entry === 'string') return entry
  return entry && typeof entry === 'object' ? entry.id || null : null
}

/**
 * Fetch every page of a Kapa list endpoint.
 *
 * Both ingestion endpoints return count/next/previous but declare NO pagination
 * query parameters, so the only supported way through is to follow `next`. At
 * 22 sources this project fits in one page today; follow the cursor anyway so it
 * does not quietly truncate later.
 *
 * @param {string} url - Absolute first-page URL
 * @param {string} apiKey
 * @param {Function} [fetchImpl] - Injectable for tests
 * @returns {Promise<object[]>} Concatenated results
 */
async function fetchAllPages (url, apiKey, fetchImpl = globalThis.fetch) {
  const out = []
  let next = url
  let guard = 0

  while (next) {
    if (++guard > 50) throw new Error(`Kapa pagination did not terminate after ${guard - 1} pages: ${url}`)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let res
    try {
      res = await fetchImpl(next, { headers: kapaAuthHeaders(apiKey), signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      // 401/403 is the overwhelmingly likely failure and deserves its own hint:
      // a wrong-project key returns 403, not an empty list.
      const hint = res.status === 401 || res.status === 403
        ? ' Check that KAPA_API_KEY is valid and belongs to the project in KAPA_PROJECT_ID.'
        : ''
      throw new Error(`Kapa API request failed: ${res.status} ${res.statusText} for ${next}.${hint}`)
    }

    const body = await res.json()
    if (!Array.isArray(body?.results)) {
      throw new Error(`Kapa API returned an unexpected shape for ${next}: no results array.`)
    }
    out.push(...body.results)
    next = body.next || null
  }

  return out
}

/**
 * Flatten the group tree into parent + children.
 *
 * Kapa's hierarchy is two levels and is expressed top-down: a group carries
 * `sub_groups`, and there is no parent_id/parent/level field anywhere in the
 * schema. So children are only discoverable by descending from parents.
 *
 * @param {object[]} groups - `results` from the source-groups endpoint
 * @returns {{parents: object[], childrenByParentId: Map<string, object[]>}}
 */
function flattenGroups (groups) {
  const parents = []
  const childrenByParentId = new Map()

  for (const group of groups) {
    const subs = toList(group.sub_groups).filter((s) => typeof s === 'object')
    parents.push(group)
    childrenByParentId.set(group.id, subs)
  }

  return { parents, childrenByParentId }
}

/**
 * Build the segment -> group mapping.
 *
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} options.projectId
 * @param {string} [options.defaultSegment='current'] - Segment used for pages with no version
 * @param {string} [options.parentGroupName] - Restrict to one parent by name (default: the only parent that has children)
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<string>} Pretty-printed JSON, newline-terminated
 */
async function generateKapaSourceGroups ({
  apiKey,
  projectId,
  defaultSegment = 'current',
  parentGroupName,
  fetchImpl,
} = {}) {
  if (!apiKey) throw new Error('generateKapaSourceGroups requires an apiKey')
  if (!projectId) throw new Error('generateKapaSourceGroups requires a projectId')

  const base = `${KAPA_API_BASE}/ingestion/v1/projects/${encodeURIComponent(projectId)}`
  const [groups, sources] = await Promise.all([
    fetchAllPages(`${base}/source-groups/`, apiKey, fetchImpl),
    fetchAllPages(`${base}/sources/`, apiKey, fetchImpl),
  ])

  if (groups.length === 0) {
    // An empty list looks identical to "the dashboard work has not been done
    // yet". Refuse rather than writing an empty mapping that would make every
    // consumer silently fall back to unscoped retrieval.
    throw new Error(
      'Kapa returned no source groups. Create the parent group and its version sub groups in the ' +
      'Kapa dashboard (Sources > Manage groups) before running this generator.'
    )
  }

  const { parents, childrenByParentId } = flattenGroups(groups)

  const candidates = parentGroupName
    ? parents.filter((p) => p.name === parentGroupName)
    : parents.filter((p) => (childrenByParentId.get(p.id) || []).length > 0)

  if (candidates.length === 0) {
    const names = parents.map((p) => `"${p.name}"`).join(', ')
    throw new Error(
      parentGroupName
        ? `No source group named "${parentGroupName}". Groups present: ${names}.`
        : 'No source group has any sub groups, so there are no version groups to map. ' +
          `Add version sub groups under a parent in the Kapa dashboard. Groups present: ${names}.`
    )
  }
  if (candidates.length > 1) {
    const names = candidates.map((p) => `"${p.name}"`).join(', ')
    throw new Error(
      `Ambiguous parent group: ${names} all have sub groups. Pass --parent-group to choose one.`
    )
  }

  const parent = candidates[0]
  const children = childrenByParentId.get(parent.id) || []

  // Which sources are assigned to each group. A version group with no sources
  // is worse than no group at all: scoping to it returns only the global set, so
  // the reader silently gets no version-specific content. Surface it.
  const sourcesByGroupId = new Map()
  for (const source of sources) {
    for (const entry of toList(source.source_groups)) {
      const gid = idOf(entry)
      if (!gid) continue
      if (!sourcesByGroupId.has(gid)) sourcesByGroupId.set(gid, [])
      sourcesByGroupId.get(gid).push({ id: source.id, name: source.name })
    }
  }

  const segments = {}
  const empty = []
  for (const child of children) {
    const assigned = (sourcesByGroupId.get(child.id) || [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
    if (assigned.length === 0) empty.push(child.name)
    segments[child.name] = {
      group_id: child.id,
      group_name: child.name,
      // Sorted so a reordering upstream cannot produce a docs diff.
      source_ids: assigned.map((s) => s.id).sort(),
      source_names: assigned.map((s) => s.name),
    }
  }

  if (!segments[defaultSegment]) {
    throw new Error(
      `Default segment "${defaultSegment}" is not one of the version groups ` +
      `(${Object.keys(segments).sort().join(', ') || 'none'}). Pages with no version would have ` +
      'nothing to scope to, so this must be fixed before the mapping is usable.'
    )
  }

  if (empty.length) {
    throw new Error(
      `These version groups have no sources assigned: ${empty.sort().join(', ')}. ` +
      'Scoping a query to an empty group returns only global sources, so the reader would get no ' +
      'version-specific content at all. Assign each Documentation (X) source to its group in the ' +
      'Kapa dashboard (Sources > Configure), then re-run.'
    )
  }

  // Sources deliberately left unassigned. These are the global set: always
  // returned alongside whichever group a query scopes to. Recorded because the
  // whole design depends on it (Agentic Data Plane must stay reachable from
  // every page), so a future reader can see it was a choice, not an oversight.
  const globalSources = sources
    .filter((s) => toList(s.source_groups).length === 0)
    .map((s) => s.name)
    .sort((a, b) => a.localeCompare(b))

  // Keys sorted throughout: this file is diff-checked in CI, so a stable order
  // is what makes "no changes" mean "nothing changed upstream". Note there is
  // deliberately no generated-at timestamp -- that is exactly what stops
  // cloud-regions from being diff-checkable.
  const mapping = {
    project_id: projectId,
    parent_group: { id: parent.id, name: parent.name, type: parent.type || null },
    default_segment: defaultSegment,
    segments: Object.fromEntries(
      Object.keys(segments).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((k) => [k, segments[k]])
    ),
    global_sources: globalSources,
  }

  return `${JSON.stringify(mapping, null, 2)}\n`
}

module.exports = {
  generateKapaSourceGroups,
  // Exported for unit tests.
  toList,
  idOf,
  flattenGroups,
  fetchAllPages,
}
