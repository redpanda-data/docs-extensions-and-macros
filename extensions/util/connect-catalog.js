'use strict'

// Shared Redpanda Connect catalog helpers.
//
// The connect repo publishes its reference content (partials and examples)
// through a content source that modify-connect-tag-playbook pins to the latest
// release tag. Catalog data (support level, deprecation, Cloud availability)
// must come from the same ref, or the badges and catalog drift from the
// reference content as soon as connect's main branch changes a flag before a
// release. This module carries that ref between the extensions and turns the
// generated partials/platforms/catalog.json into rows shaped like the
// translated info.csv rows the macros already consume.

// Matches the GitHub URL (with or without .git) and a local clone whose
// directory is named connect, which is how the source looks in local builds.
function isConnectSource (url) {
  return typeof url === 'string' && /(^|[/:])(redpanda-data\/)?connect(\.git)?\/?$/.test(url)
}

function isConnectOrigin (origin) {
  return !!origin && (isConnectSource(origin.url) || isConnectSource(origin.worktree))
}

// The connect ref that modify-connect-tag-playbook resolved for this build.
// Module state, because both extensions run in the same Antora process and
// Antora gives extensions no other channel that survives from contextStarted
// to contentClassified without mutating the playbook.
let resolvedConnectRef = null

function setResolvedConnectRef (ref) {
  resolvedConnectRef = ref || null
}

function getResolvedConnectRef () {
  return resolvedConnectRef
}

// The GitHub owner and repo of a connect origin URL, so a playbook that
// previews a fork reads that fork's info.csv. Null for non-GitHub URLs.
function githubRepoOf (url) {
  const m = String(url || '').match(/github\.com[/:]([^/]+)\/([^/]+?)(\.git)?\/?$/)
  return m ? { owner: m[1], repo: m[2] } : null
}

// The ref of the connect content source as Antora aggregated it. Only refs
// that exist on the remote count: a tag, or a branch fetched from the remote.
// A branch of a local clone may exist only on disk, so it is not used.
function connectOriginRef (contentCatalog) {
  if (!contentCatalog || typeof contentCatalog.findBy !== 'function') return null
  for (const file of contentCatalog.findBy({ component: 'connect' })) {
    const origin = file.src && file.src.origin
    if (!isConnectOrigin(origin)) continue
    const repo = githubRepoOf(origin.url)
    if (origin.tag || origin.reftype === 'tag') {
      return { ref: origin.tag || origin.refname, ...(repo || {}) }
    }
    if (!origin.worktree && (origin.branch || origin.refname)) {
      return { ref: origin.branch || origin.refname, ...(repo || {}) }
    }
  }
  return null
}

const CATALOG_RELATIVE = 'platforms/catalog.json'

// The generated catalog.json in the content catalog, preferring the copy
// from the connect content source over one another source provides.
function findConnectCatalogFile (contentCatalog) {
  if (!contentCatalog || typeof contentCatalog.findBy !== 'function') return null
  const candidates = contentCatalog
    .findBy({ component: 'connect', module: 'components', family: 'partial' })
    .filter((f) => f.src && f.src.relative === CATALOG_RELATIVE)
  return candidates.find((f) => isConnectOrigin(f.src.origin)) || candidates[0] || null
}

// Page directories and data rows name some types differently: pages live in
// metrics/ and rate_limits/, while info.csv and the schema say metric and
// rate_limit. Normalize to the singular data form for lookups.
function normalizeType (type) {
  const t = String(type || '').trim().toLowerCase().replace(/-/g, '_')
  return t.endsWith('s') ? t.slice(0, -1) : t
}

const PAGE_TYPE_DIRS = ['inputs', 'outputs', 'processors', 'caches', 'rate_limits', 'buffers', 'metrics', 'tracers', 'scanners']

// The component type of a connector page from its path, for example
// inputs/kafka.adoc -> input. Null for pages outside the type directories.
function typeFromRelative (relative) {
  const m = String(relative || '').match(/(?:^|\/)([a-z_]+)\/[^/]+\.adoc$/)
  return m && PAGE_TYPE_DIRS.includes(m[1]) ? normalizeType(m[1]) : null
}

const yn = (value) => (value === true || String(value || '').trim().toLowerCase() === 'y' ? 'y' : 'n')

// Converts catalog.json entries into rows with the raw info.csv column names,
// so they go through the same translation as rows parsed from info.csv. The
// catalog adds status, categories, cgo_only, and the full commercial name list.
function catalogEntriesToCsvRows (entries) {
  if (!Array.isArray(entries)) throw new Error('catalog.json is not a JSON array')
  return entries
    .filter((e) => e && e.name && e.type)
    .map((e) => {
      const commercialNames = Array.isArray(e.commercial_names) ? e.commercial_names.filter(Boolean) : []
      const status = String(e.status || '').trim().toLowerCase()
      return {
        name: e.name,
        type: e.type,
        commercial_name: commercialNames[0] || e.name,
        commercial_names: commercialNames,
        support: e.support || '',
        deprecated: status === 'deprecated' ? 'y' : 'n',
        cloud: yn(e.cloud),
        cloud_with_gpu: yn(e.cloud_ai),
        status,
        version: e.version || '',
        categories: Array.isArray(e.categories) ? e.categories : [],
        cgo_only: yn(e.cgo_only),
        summary: e.summary || ''
      }
    })
}

// Cloud availability of a translated row. Cloud has two pipeline flavors:
// standard (info.csv `cloud`) and GPU (info.csv `cloud_with_gpu`, catalog
// `cloud_ai`). A component in either one has a Cloud page.
function isCloudAvailable (row) {
  return !!row && (row.is_cloud_supported === 'y' || row.cloud_ai === 'y')
}

// gpu_only: only in GPU pipelines (for example the ollama processors).
// no_gpu: in standard pipelines but not in GPU pipelines (for example jira).
function gpuFlags (cloud, cloudAi) {
  return {
    gpu_only: cloud !== 'y' && cloudAi === 'y' ? 'y' : 'n',
    no_gpu: cloud === 'y' && cloudAi !== 'y' ? 'y' : 'n'
  }
}

module.exports = {
  CATALOG_RELATIVE,
  isConnectSource,
  isConnectOrigin,
  setResolvedConnectRef,
  getResolvedConnectRef,
  githubRepoOf,
  connectOriginRef,
  findConnectCatalogFile,
  normalizeType,
  typeFromRelative,
  catalogEntriesToCsvRows,
  isCloudAvailable,
  gpuFlags
}
