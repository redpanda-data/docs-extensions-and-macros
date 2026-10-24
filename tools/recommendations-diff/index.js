'use strict'

/**
 * doc-tools recommendations-diff: which solution recommendations a pull
 * request changes, without building the site and without a model.
 *
 * It reads the scoring inputs a published build wrote
 * (assets/data/doc-concepts.json, extensions/solutions-catalog/recs-index.js)
 * from an origin (default https://docs.redpanda.com; a deploy preview until
 * Solutions go live) and the taxonomy, then reads the changed pages at the
 * merge base and at HEAD locally:
 *
 *   - a Product Docs page: its page-categories, as the page's concepts
 *     (concepts.docConcepts)
 *   - a solution overview (:page-layout: solution, in redpanda-solutions):
 *     its facets and categories, as the solution's concepts
 *     (concepts.solutionConcepts)
 *
 * Both sides are scored with relationships.computeRelatedSolutions, the
 * function the build runs, imported rather than copied, so the PR check and
 * the build never disagree. Everything else (the other solutions, their
 * explicit related docs, relationships.yml, max_related, min_score) comes
 * from the published index, so the diff is only what the PR changes. A
 * changed solution moves the rarity of its concepts, so a solution change is
 * scored against every published doc page; a doc change only against itself.
 *
 * It reports, per doc page, the shown recommendations that appear, disappear,
 * or change rank, with scores and the shared concepts. It always exits 0
 * once its arguments are valid: when the published data cannot be read, the
 * result has status `unavailable` and says why.
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const yaml = require('js-yaml')
const { loadTaxonomyFrom, authoredCategories, SOURCE_PATH } = require('../../extension-utils/taxonomy')
const { isSolutionPage } = require('../../extension-utils/metadata-check')
const { createCategoryMap } = require('../../extension-utils/categories')
const { getDeploymentType } = require('../../extension-utils/deployment-type')
const concepts = require('../../extensions/solutions-catalog/concepts')
const relationships = require('../../extensions/solutions-catalog/relationships')
const recsIndex = require('../../extensions/solutions-catalog/recs-index')
const { EXCLUDED_DOC_COMPONENTS, UMBRELLA_LAYOUTS, ASSET_DIR } = require('../../extensions/solutions-catalog/index')
const { DEFAULT_PLATFORMS } = require('../../extensions/solutions-catalog/collect')

const DEFAULT_ORIGIN = 'https://docs.redpanda.com'
const LEGACY_CATEGORIES_PATH = 'shared/modules/ROOT/partials/valid-categories.yml'
const PAGE_RE = /^(?:(.*)\/)?modules\/([^/]+)\/pages\/(.+\.adoc)$/
const FETCH_TIMEOUT_MS = 30000

const git = (root, args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

/** Changed .adoc files between the merge base with `base` and HEAD, with git's status letter. */
function changedFiles (root, base) {
  const mb = git(root, ['merge-base', base, 'HEAD'])
  if (mb.status !== 0) throw new Error(`git merge-base ${base} HEAD failed: ${(mb.stderr || '').trim()}`)
  const mergeBase = mb.stdout.trim()
  const res = git(root, ['diff', '--name-status', '--no-renames', '--diff-filter=ACMD', `${mergeBase}`, 'HEAD', '--', '*.adoc'])
  if (res.status !== 0) throw new Error(`git diff against ${base} failed: ${(res.stderr || '').trim()}`)
  const files = res.stdout.split('\n').filter(Boolean).map((line) => {
    const [status, file] = line.split('\t')
    return { status, file }
  })
  return { mergeBase, files }
}

/** A file's text at a commit, or null when it is not there. */
function showAt (root, rev, file) {
  const res = git(root, ['show', `${rev}:${file}`])
  return res.status === 0 ? res.stdout : null
}

/** The Antora component name for a page path: the nearest antora.yml above its modules/ directory. */
function componentOf (root, rev, dir) {
  const read = (rel) => (rev ? showAt(root, rev, rel) : (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), 'utf8') : null))
  const parts = dir ? dir.split('/') : []
  for (let i = parts.length; i >= 0; i--) {
    const rel = [...parts.slice(0, i), 'antora.yml'].join('/')
    const text = read(rel)
    if (text === null) continue
    const data = yaml.load(text) || {}
    if (data.name) return String(data.name)
  }
  return null
}

let asciidoctor = null
const headerCache = new Map()

/** The page header, parsed by Asciidoctor as a build does (header only, no includes). */
function header (content) {
  const text = String(content || '')
  if (headerCache.has(text)) return headerCache.get(text)
  asciidoctor = asciidoctor || require('@asciidoctor/core')()
  const doc = asciidoctor.load(text, { parse_header_only: true, safe: 'safe' })
  const parsed = { attributes: doc.getAttributes(), title: String(doc.getDocumentTitle({ sanitize: true }) || '').trim() }
  headerCache.set(text, parsed)
  return parsed
}

const titleOf = (content) => header(content).title
const headerAttributes = (content) => header(content).attributes

const listOf = (value) => String(value || '').split(',').map((v) => v.trim()).filter(Boolean)

/** valid-categories.yml from the checkout or $REDPANDA_DOCS_PATH, for legacy categories the taxonomy lacks. */
function loadCategoryMap (root, env = process.env) {
  for (const base of [root, env.REDPANDA_DOCS_PATH].filter(Boolean)) {
    const file = path.join(path.resolve(base), LEGACY_CATEGORIES_PATH)
    if (!fs.existsSync(file)) continue
    const list = (yaml.load(fs.readFileSync(file, 'utf8')) || {})['page-valid-categories']
    if (Array.isArray(list)) return createCategoryMap(list)
  }
  return null
}

/**
 * Fetch and parse JSON. Returns { json } or { error } for anything that is
 * not the file: a network failure, an HTTP error, a soft 404 HTML page.
 */
async function fetchJson (url, fetchImpl) {
  if (!/^https?:\/\//i.test(url)) {
    try {
      return { json: JSON.parse(fs.readFileSync(path.resolve(url), 'utf8')) }
    } catch (err) {
      return { error: `could not read ${url}: ${err.message}` }
    }
  }
  if (typeof fetchImpl !== 'function') return { error: `cannot fetch ${url}: no fetch in this Node.js` }
  let res
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (err) {
    return { error: `fetching ${url} failed: ${err.message}` }
  }
  if (!res.ok) return { error: `fetching ${url} failed with HTTP ${res.status}` }
  const type = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || ''
  if (/text\/html/i.test(type)) return { error: `${url} is an HTML page, not the published JSON (no Solutions build at this origin?)` }
  try {
    return { json: JSON.parse(await res.text()) }
  } catch (err) {
    return { error: `${url} is not JSON: ${err.message}` }
  }
}

/**
 * A doc page as computeRelatedSolutions reads it, from its source, or null
 * when the page would not get recommendations (an umbrella layout, opted
 * out, an excluded component).
 */
function docFromSource ({ content, key, component, published, taxonomy, categoryMap }) {
  if (content === null || EXCLUDED_DOC_COMPONENTS.includes(component)) return null
  const attrs = headerAttributes(content)
  if (UMBRELLA_LAYOUTS.includes(attrs['page-layout']) || UMBRELLA_LAYOUTS.includes(attrs['page-role'])) return null
  if (attrs['page-exclude-related-solutions'] !== undefined && attrs['page-exclude-related-solutions'] !== 'false') return null
  return {
    key,
    title: (published && published.title) || titleOf(content),
    url: (published && published.url) || '',
    // The deployment comes from component attributes as well as the page, so
    // the published value is the better one when there is one.
    deployment: published ? published.deployment : getDeploymentType(attrs),
    categories: [],
    concepts: concepts.docConcepts(taxonomy, { categories: authoredCategories(attrs), categoryMap }),
  }
}

/**
 * A solution as computeRelatedSolutions reads it, from its overview source,
 * with what the overview does not say (explicit related docs, last modified,
 * URL) from the published index. Null when the overview is not there.
 */
function solutionFromSource ({ content, id, published, taxonomy, categoryMap }) {
  if (content === null) return null
  const attrs = headerAttributes(content)
  if (!isSolutionPage(attrs)) return null
  const platforms = listOf(attrs['page-solution-platforms'])
  const record = {
    id,
    categoriesRaw: listOf(attrs['page-categories']),
    useCases: listOf(attrs['page-solution-use-cases']),
    technologies: listOf(attrs['page-solution-technologies']),
    industries: listOf(attrs['page-solution-industries']),
    platforms: platforms.length ? platforms : [...DEFAULT_PLATFORMS],
    platformsAuthored: platforms.length > 0,
  }
  const derived = concepts.solutionConcepts(taxonomy, record, categoryMap)
  const status = String(attrs['page-solution-status'] || '').trim()
  return {
    ...(published || { relatedDocKeys: new Set(), relatedDocTwins: new Map(), lastModified: null, url: '' }),
    id,
    title: titleOf(content) || (published && published.title) || id,
    status,
    // A draft is scored only where the published build included drafts.
    draft: status === 'draft' && Boolean(published && published.draft),
    featured: attrs['page-solution-featured'] !== undefined && attrs['page-solution-featured'] !== 'false',
    platforms: record.platforms,
    categories: [],
    concepts: derived.concepts,
    conceptFacets: derived.facets,
    errors: derived.errors,
  }
}

/** The shown recommendations of one doc, by solution: { rank, score, provenance, shared } */
function shownByDoc (edges) {
  const out = new Map()
  for (const e of edges) {
    if (!e.shown) continue
    if (!out.has(e.doc)) out.set(e.doc, new Map())
    out.get(e.doc).set(e.solution, e)
  }
  return out
}

function edgesByPair (edges) {
  return new Map(edges.map((e) => [`${e.doc} ${e.solution}`, e]))
}

/**
 * Compare two scorings, for the docs in `scope`.
 *
 * @returns {Array<{doc, title, url, appear, disappear, rerank}>} docs with a change only
 */
function diffScorings ({ scope, docsByKey, solutionsById, base, head, taxonomy }) {
  const baseShown = shownByDoc(base.edges)
  const headShown = shownByDoc(head.edges)
  const headEdges = edgesByPair(head.edges)
  const shared = (edge) => {
    if (!edge || !edge.shared) return []
    return [...edge.shared.leaves, ...edge.shared.broader].map((id) => ({ id, label: concepts.conceptLabel(taxonomy, id) }))
  }
  const titleOf = (id) => (solutionsById.get(id) ? solutionsById.get(id).title : id)
  const out = []
  for (const key of [...scope].sort()) {
    const b = baseShown.get(key) || new Map()
    const h = headShown.get(key) || new Map()
    const appear = []
    const disappear = []
    const rerank = []
    for (const [sid, e] of h) {
      if (!b.has(sid)) appear.push({ solution: sid, title: titleOf(sid), rank: e.rank, score: e.score, provenance: e.provenance, shared: shared(e) })
      else if (b.get(sid).rank !== e.rank) {
        const was = b.get(sid)
        rerank.push({ solution: sid, title: titleOf(sid), from: was.rank, to: e.rank, scoreFrom: was.score, scoreTo: e.score, provenance: e.provenance, shared: shared(e) })
      }
    }
    for (const [sid, e] of b) {
      if (h.has(sid)) continue
      const now = headEdges.get(`${key} ${sid}`)
      disappear.push({
        solution: sid,
        title: titleOf(sid),
        rank: e.rank,
        score: e.score,
        scoreNow: now ? now.score : 0,
        provenance: e.provenance,
        shared: shared(e),
        // Why it is not shown now: the build's own reason, or no signal left.
        reason: now ? now.reason : 'no shared concepts left',
      })
    }
    if (!appear.length && !disappear.length && !rerank.length) continue
    const doc = docsByKey.get(key) || {}
    const byRank = (x, y) => (x.rank || x.to) - (y.rank || y.to)
    out.push({ doc: key, title: doc.title || '', url: doc.url || '', appear: appear.sort(byRank), disappear: disappear.sort(byRank), rerank: rerank.sort(byRank) })
  }
  return out
}

/**
 * Compute the diff.
 *
 * @param {Object} input
 * @param {string} input.root
 * @param {string} input.base - git ref
 * @param {Object} input.index - parsed doc-concepts.json
 * @param {import('../../extension-utils/taxonomy').Taxonomy} input.taxonomy
 * @param {Object|null} [input.categoryMap]
 */
function diffRecommendations ({ root, base, index, taxonomy, categoryMap = null }) {
  const published = recsIndex.readDocConceptsIndex(index)
  const { mergeBase, files } = changedFiles(root, base)
  const docsByKey = new Map(published.docs.map((d) => [d.key, d]))
  const solutionsById = new Map(published.solutions.map((s) => [s.id, s]))

  const changedDocs = []
  const changedSolutions = []
  const skipped = []
  for (const { status, file } of files) {
    const m = PAGE_RE.exec(file)
    if (!m) continue
    const [, dir = '', module, relative] = m
    const headContent = status === 'D' ? null : (fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : null)
    const baseContent = status === 'A' ? null : showAt(root, mergeBase, file)
    const component = componentOf(root, null, dir) || componentOf(root, mergeBase, dir)
    if (!component) {
      skipped.push({ file, reason: 'no antora.yml above it, so its component is unknown' })
      continue
    }
    const isSolution = [baseContent, headContent].some((c) => c !== null && isSolutionPage(headerAttributes(c)))
    if (isSolution) {
      changedSolutions.push({ file, id: module, baseContent, headContent })
      continue
    }
    if (relative !== 'index.adoc' && component === 'solutions') continue // a solution step page: no facets
    changedDocs.push({ file, key: `${component}:${module}:${relative}`, component, baseContent, headContent })
  }

  // Two worlds: the published one with the changed pages at the merge base,
  // and the same with them at HEAD.
  const world = (side) => {
    const docs = new Map(docsByKey)
    for (const c of changedDocs) {
      const doc = docFromSource({ content: side === 'base' ? c.baseContent : c.headContent, key: c.key, component: c.component, published: docsByKey.get(c.key), taxonomy, categoryMap })
      if (doc) docs.set(c.key, doc)
      else docs.delete(c.key)
    }
    const solutions = new Map(solutionsById)
    for (const c of changedSolutions) {
      const s = solutionFromSource({ content: side === 'base' ? c.baseContent : c.headContent, id: c.id, published: solutionsById.get(c.id), taxonomy, categoryMap })
      if (s) solutions.set(c.id, s)
      else solutions.delete(c.id)
    }
    return { docs, solutions }
  }
  const baseWorld = world('base')
  const headWorld = world('head')

  // A solution change can move any page (rarity is over all solutions); a
  // doc change moves only that page.
  const scope = new Set(changedDocs.map((c) => c.key))
  if (changedSolutions.length) for (const k of new Set([...baseWorld.docs.keys(), ...headWorld.docs.keys()])) scope.add(k)

  const score = (w) => relationships.computeRelatedSolutions({
    docs: [...w.docs.values()].filter((d) => scope.has(d.key)),
    solutions: [...w.solutions.values()],
    relationships: published.relationships,
    categoryMap,
    taxonomy,
    maxRelated: published.settings.maxRelated,
    minScore: published.settings.minScore,
  })
  const baseScore = scope.size ? score(baseWorld) : { edges: [] }
  const headScore = scope.size ? score(headWorld) : { edges: [] }
  const allSolutions = new Map([...baseWorld.solutions, ...headWorld.solutions])
  const allDocs = new Map([...baseWorld.docs, ...headWorld.docs])
  const docs = diffScorings({ scope, docsByKey: allDocs, solutionsById: allSolutions, base: baseScore, head: headScore, taxonomy })

  const solutionErrors = changedSolutions.flatMap((c) => {
    const s = headWorld.solutions.get(c.id)
    return s && s.errors && s.errors.length ? [{ solution: c.id, errors: s.errors }] : []
  })
  return {
    status: 'ok',
    mergeBase,
    index: { generatedAt: published.generatedAt, siteUrl: published.siteUrl, docs: published.docs.length, solutions: published.solutions.length, settings: published.settings },
    changed: {
      docs: changedDocs.map((c) => ({ file: c.file, doc: c.key, inIndex: docsByKey.has(c.key) })),
      solutions: changedSolutions.map((c) => ({ file: c.file, solution: c.id, inIndex: solutionsById.has(c.id) })),
    },
    skipped,
    solutionErrors,
    docs,
    summary: {
      docs: docs.length,
      appear: docs.reduce((n, d) => n + d.appear.length, 0),
      disappear: docs.reduce((n, d) => n + d.disappear.length, 0),
      rerank: docs.reduce((n, d) => n + d.rerank.length, 0),
    },
  }
}

const sharedText = (shared) => (shared && shared.length ? shared.map((s) => s.label).join(', ') : 'no shared concepts (explicit or editorial)')

function formatText (result) {
  if (result.status !== 'ok') return `recommendations-diff: skipped: ${result.reason}`
  const out = []
  for (const d of result.docs) {
    out.push(`DOC     ${d.doc}${d.title ? ` (${d.title})` : ''}`)
    for (const a of d.appear) out.push(`  +     ${a.solution} rank ${a.rank}, score ${a.score} (${a.provenance}): ${sharedText(a.shared)}`)
    for (const r of d.disappear) out.push(`  -     ${r.solution} was rank ${r.rank}, score ${r.score}; now ${r.scoreNow}: ${r.reason}`)
    for (const r of d.rerank) out.push(`  ~     ${r.solution} rank ${r.from} -> ${r.to}, score ${r.scoreFrom} -> ${r.scoreTo}: ${sharedText(r.shared)}`)
  }
  for (const e of result.solutionErrors) out.push(`NOTE    ${e.solution}: the build would fail on this overview: ${e.errors.join('; ')}`)
  for (const s of result.skipped) out.push(`NOTE    ${s.file}: ${s.reason}`)
  if (out.length) out.push('')
  const c = result.changed
  out.push(`recommendations-diff: ${c.docs.length} changed doc page(s), ${c.solutions.length} changed solution(s) against ${result.index.siteUrl || 'the published index'} (${result.index.generatedAt}): ${result.summary.appear} appear, ${result.summary.disappear} disappear, ${result.summary.rerank} rerank on ${result.summary.docs} page(s)`)
  return out.join('\n')
}

const md = (s) => String(s).replace(/([|`[\]<>\\*_])/g, '\\$1')

/** The job summary section. */
function formatSummary (result) {
  const out = ['### Solution recommendations', '']
  if (result.status !== 'ok') {
    out.push(`Not checked: ${md(result.reason)}`, '')
    return out.join('\n')
  }
  const c = result.changed
  if (!c.docs.length && !c.solutions.length) {
    out.push('No changed Product Docs pages or solution overviews.', '')
    return out.join('\n')
  }
  const src = `\`${result.index.siteUrl || 'the published index'}\` (built ${result.index.generatedAt}, min score ${result.index.settings.minScore}, at most ${result.index.settings.maxRelated} per page)`
  if (!result.docs.length) {
    out.push(`No change to the recommendations shown on any page. Checked ${c.docs.length} changed doc page(s) and ${c.solutions.length} changed solution(s) against ${src}.`, '')
  } else {
    out.push(`${result.summary.appear} appear, ${result.summary.disappear} disappear, and ${result.summary.rerank} change rank on ${result.summary.docs} page(s), against ${src}.`, '')
    out.push('| Page | Change | Solution | Rank | Score | Shared concepts or reason |', '|---|---|---|---|---|---|')
    for (const d of result.docs) {
      const page = `\`${d.doc}\``
      for (const a of d.appear) out.push(`| ${page} | appears | ${md(a.title)} (\`${a.solution}\`) | ${a.rank} | ${a.score} | ${md(sharedText(a.shared))} |`)
      for (const r of d.disappear) out.push(`| ${page} | disappears | ${md(r.title)} (\`${r.solution}\`) | was ${r.rank} | ${r.score} to ${r.scoreNow} | ${md(r.reason)} |`)
      for (const r of d.rerank) out.push(`| ${page} | reranks | ${md(r.title)} (\`${r.solution}\`) | ${r.from} to ${r.to} | ${r.scoreFrom} to ${r.scoreTo} | ${md(sharedText(r.shared))} |`)
    }
    out.push('')
  }
  for (const e of result.solutionErrors) out.push(`- \`${e.solution}\`: the build would fail on this overview: ${md(e.errors.join('; '))}`)
  if (result.solutionErrors.length) out.push('')
  return out.join('\n')
}

/**
 * @param {Object} options - commander options: changed, origin, index, taxonomy, root, format, output, summary
 * @param {Object} [deps] - { fetch } for tests
 */
async function runCli (options = {}, { fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!options.changed) {
    console.error('recommendations-diff: --changed <base> is required')
    process.exitCode = 2
    return null
  }
  if (options.format && !['text', 'json'].includes(options.format)) {
    console.error(`recommendations-diff: --format must be text or json, got ${options.format}`)
    process.exitCode = 2
    return null
  }
  const root = path.resolve(options.root || process.cwd())
  const origin = String(options.origin || process.env.DOC_TOOLS_RECOMMENDATIONS_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '')
  const indexSource = options.index || `${origin}/${ASSET_DIR}/${recsIndex.INDEX_FILENAME}`
  let result
  const unavailable = (reason) => ({ status: 'unavailable', reason, origin, index: indexSource })
  const fetched = await fetchJson(indexSource, fetchImpl)
  if (fetched.error) {
    result = unavailable(fetched.error)
  } else {
    let taxonomy = null
    try {
      // The taxonomy the index was built with: the origin's, unless the
      // checkout (or $REDPANDA_DOCS_PATH) has one or --taxonomy names one.
      const local = fs.existsSync(path.join(root, SOURCE_PATH)) || process.env.REDPANDA_DOCS_PATH
      const source = options.taxonomy || (local ? undefined : `${origin}/${SOURCE_PATH.replace('/modules/ROOT/attachments/', '/_attachments/')}`)
      taxonomy = (await loadTaxonomyFrom({ source, root, fetch: fetchImpl })).taxonomy
    } catch (err) {
      result = unavailable(`could not load the taxonomy: ${err.message}`)
    }
    if (taxonomy) {
      try {
        result = { origin, ...diffRecommendations({ root, base: options.changed, index: fetched.json, taxonomy, categoryMap: loadCategoryMap(root) }) }
      } catch (err) {
        if (/^git /.test(err.message)) {
          console.error(`recommendations-diff: ${err.message}`)
          process.exitCode = 2
          return null
        }
        result = unavailable(err.message)
      }
    }
  }
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true })
    fs.writeFileSync(path.resolve(options.output), JSON.stringify(result, null, 2) + '\n')
  }
  if (options.summary) fs.appendFileSync(path.resolve(options.summary), formatSummary(result) + '\n')
  console.log(options.format === 'json' ? JSON.stringify(result, null, 2) : formatText(result))
  process.exitCode = 0
  return result
}

module.exports = {
  DEFAULT_ORIGIN,
  changedFiles,
  componentOf,
  docFromSource,
  solutionFromSource,
  diffScorings,
  diffRecommendations,
  fetchJson,
  formatText,
  formatSummary,
  runCli,
}
