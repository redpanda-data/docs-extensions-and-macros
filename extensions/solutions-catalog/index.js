'use strict'

/**
 * solutions-catalog: validates the `solutions` component, derives every
 * `page-solution-*` attribute, computes the docs <-> solutions content graph,
 * and publishes the catalog.
 *
 * Register directly before validate-attributes and after unpublish-pages and
 * add-git-dates:
 *
 *   antora:
 *     extensions:
 *       - require: '@redpanda-data/docs-extensions-and-macros/extensions/solutions-catalog/index'
 *         max_related: 3
 *         min_score: 0.3
 *         network_checks: auto
 *
 * Hooks
 *   contentClassified    structural fatals (landing page, overview per module,
 *                        reserved/duplicate module names, relationships.yml parses
 *                        and matches docs-data/solutions-relationships.schema.json)
 *   documentsConverted   collect records, normalize categories, validate (every
 *                        error collected, one throw), apply status (drafts are
 *                        unpublished unless include_drafts), compute
 *                        page-related-solutions for eligible doc pages, write
 *                        page-solution, page-solution-nav, prev/next, step
 *                        index/count, scalar mirrors, and the component attribute
 *                        `solutions-catalog` (set here, not at beforePublish,
 *                        because pages are composed before beforePublish fires)
 *   beforePublish        assets/data/solutions.json, assets/data/solutions-graph.json,
 *                        optional GitHub release check (network_checks)
 *
 * When the build has no `solutions` component every hook is a no-op, so the
 * extension can ship to docs-site before the content source exists.
 */

const { raiseListenerLimit } = require('../util/raise-listener-limit')
const { createCategoryMap, normalizeCategories, parseCategoryList } = require('../../extension-utils/categories')
const { getDeploymentType } = require('../../extension-utils/deployment-type')
const collect = require('./collect')
const validate = require('./validate')
const relationships = require('./relationships')
const outputs = require('./outputs')

const ATTRIBUTE_NAME = 'solutions-catalog'
const ASSET_DIR = 'assets/data'
const CATALOG_FILENAME = 'solutions.json'
const GRAPH_FILENAME = 'solutions-graph.json'

// Components whose pages never receive recommendations.
const EXCLUDED_DOC_COMPONENTS = ['solutions', 'home', 'shared', 'search', 'data-platform', 'self-managed']
// Landing/umbrella layouts and roles: no article body to hang recommendations on.
const UMBRELLA_LAYOUTS = [
  'home', 'component-home-v3', 'data-platform', 'labs-home', 'labs-search', 'search', '404',
  'solutions-home', 'solution', 'solution-step',
]

const DEFAULTS = Object.freeze({
  maxRelated: 3,
  minScore: 0.3,
  networkChecks: 'auto',
  includeDrafts: false,
})

/**
 * Normalize the playbook config. Antora camelCases keys (`max_related` arrives as
 * `maxRelated`), but both spellings are accepted so a hand-built config in tests
 * or a direct require works too.
 */
function resolveConfig (config = {}, env = process.env) {
  const pick = (camel, snake) => (config[camel] !== undefined ? config[camel] : config[snake])
  const maxRelated = Number(pick('maxRelated', 'max_related'))
  const minScore = Number(pick('minScore', 'min_score'))
  const networkChecks = pick('networkChecks', 'network_checks')
  const includeDraftsRaw = pick('includeDrafts', 'include_drafts')
  const envDrafts = env.SOLUTIONS_INCLUDE_DRAFTS
  const includeDrafts = includeDraftsRaw !== undefined
    ? isTrue(includeDraftsRaw)
    : envDrafts !== undefined ? isTrue(envDrafts) : DEFAULTS.includeDrafts
  return {
    maxRelated: Number.isInteger(maxRelated) && maxRelated >= 0 ? maxRelated : DEFAULTS.maxRelated,
    minScore: Number.isFinite(minScore) ? minScore : DEFAULTS.minScore,
    networkChecks: networkChecks === undefined ? DEFAULTS.networkChecks : normalizeTristate(networkChecks),
    includeDrafts,
  }
}

function isTrue (value) {
  return value === true || String(value).trim().toLowerCase() === 'true'
}

function normalizeTristate (value) {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return 'auto'
}

/** Decide whether to hit GitHub for the release check. */
function shouldRunNetworkChecks (setting, env = process.env, hasToken) {
  if (setting === true) return true
  if (setting === false) return false
  if (!env.CI) return false
  if (typeof hasToken === 'function') return hasToken()
  try {
    return require('../../cli-utils/github-token').hasGitHubToken()
  } catch {
    return false
  }
}

/**
 * Doc pages that may receive page-related-solutions: published family pages in
 * the latest version of a product component, not a landing layout, not opted out.
 */
function eligibleDocPages (contentCatalog) {
  const latest = new Map()
  for (const c of contentCatalog.getComponents() || []) {
    latest.set(c.name, c.latest ? c.latest.version : (c.versions && c.versions[0] && c.versions[0].version))
  }
  return contentCatalog.findBy({ family: 'page' }).filter((page) => {
    if (!page.out || !page.src || !page.asciidoc) return false
    if (EXCLUDED_DOC_COMPONENTS.includes(page.src.component)) return false
    if (latest.get(page.src.component) !== page.src.version) return false
    const attrs = page.asciidoc.attributes || {}
    if (UMBRELLA_LAYOUTS.includes(attrs['page-layout']) || UMBRELLA_LAYOUTS.includes(attrs['page-role'])) return false
    if (attrs['page-exclude-related-solutions'] !== undefined && attrs['page-exclude-related-solutions'] !== 'false') return false
    return true
  })
}

/**
 * Add URLs to siteCatalog.unpublishedPages without duplicating them. Called at
 * documentsConverted, navigationBuilt, and beforePublish, so the list survives
 * unpublish-pages resetting the array if a playbook registers it later than
 * this extension.
 */
function ensureUnpublished (siteCatalog, urls) {
  if (!siteCatalog || !urls.length) return
  if (!Array.isArray(siteCatalog.unpublishedPages)) siteCatalog.unpublishedPages = []
  for (const url of urls) {
    if (!siteCatalog.unpublishedPages.includes(url)) siteCatalog.unpublishedPages.push(url)
  }
}

/** Every file of a module that Antora would publish: pages, attachments, images, aliases. */
function modulePublishables (contentCatalog, { component, version, module }) {
  const files = []
  for (const family of ['page', 'attachment', 'image', 'alias']) {
    files.push(...contentCatalog.findBy({ component, version, module, family }))
  }
  return files
}

function makeResolver (contentCatalog) {
  return (spec) => {
    if (typeof contentCatalog.resolveResource !== 'function') return null
    try {
      return contentCatalog.resolveResource(spec, {}, 'page', ['page']) || null
    } catch {
      return null
    }
  }
}

function addAttributeToComponents (contentCatalog, name, value, logger) {
  const components = contentCatalog.getComponents() || []
  components.forEach((component) => {
    (component.versions || []).forEach((version) => {
      if (!version.asciidoc) version.asciidoc = { attributes: {} }
      if (!version.asciidoc.attributes) version.asciidoc.attributes = {}
      version.asciidoc.attributes[name] = value
    })
  })
  logger.debug(`Set component attribute "${name}" on ${components.length} components`)
}

/**
 * Verify the release `<slug>/<version>` carries `<slug>-<version>.zip`. Purely
 * informational: the release workflow creates both after the merge that changes
 * the version, so a missing release is expected on the PR that bumps it.
 */
async function checkReleases (records, logger, octokitClient) {
  let octokit = octokitClient
  if (!octokit) {
    try {
      octokit = require('../../cli-utils/octokit-client')
    } catch (err) {
      logger.warn(`solutions-catalog: release check skipped, Octokit unavailable: ${err.message}`)
      return
    }
  }
  for (const record of records) {
    if (record.status !== 'published' || !record.repo || !record.tag) continue
    const [owner, repo] = record.repo.split('/')
    try {
      const { data } = await octokit.rest.repos.getReleaseByTag({ owner, repo, tag: record.tag })
      const assets = (data && data.assets) || []
      if (!assets.some((a) => a.name === record.asset)) {
        logger.warn(`solutions-catalog: release ${record.repo}@${record.tag} exists but has no asset ${record.asset}; the download will 503 until it is uploaded`)
      }
    } catch (err) {
      if (err && err.status === 404) {
        logger.warn(`solutions-catalog: release ${record.repo}@${record.tag} not published yet; it appears after the next merge to main`)
      } else {
        logger.warn(`solutions-catalog: could not check release ${record.repo}@${record.tag}: ${err.message}`)
      }
    }
  }
}

module.exports.register = function ({ config = {} } = {}) {
  raiseListenerLimit(this)
  const logger = this.getLogger('solutions-catalog-extension')
  const settings = resolveConfig(config)
  const state = {
    relationshipsData: null,
    catalog: null,
    graph: null,
    records: [],
    draftUrls: [],
  }
  let validator = null
  const getValidator = () => (validator = validator || relationships.createRelationshipsValidator())

  this.on('contentClassified', ({ contentCatalog }) => {
    const collected = collect.collectSolutions(contentCatalog)
    if (!collected) {
      logger.debug('No solutions component in this build; solutions-catalog is idle')
      return
    }
    const errors = validate.validateStructure(collected)

    if (collected.relationshipsFile) {
      try {
        state.relationshipsData = relationships.parseRelationships(collected.relationshipsFile.contents)
        const check = getValidator()
        if (!check(state.relationshipsData)) {
          for (const e of check.errors || []) errors.push(`relationships.yml${e.instancePath || ''} ${e.message}`)
        }
      } catch (err) {
        errors.push(`relationships.yml could not be parsed: ${err.message}`)
      }
    } else {
      logger.warn('solutions-catalog: ROOT/partials/relationships.yml not found; building with no editorial relationships')
      state.relationshipsData = { relationships: [] }
    }

    if (errors.length) throw new Error(validate.formatErrors(errors))
  })

  this.on('documentsConverted', ({ contentCatalog, siteCatalog, playbook }) => {
    const collected = collect.collectSolutions(contentCatalog)
    if (!collected) return

    const validCategories = siteCatalog && siteCatalog.attributeFile && siteCatalog.attributeFile['page-valid-categories']
    const categoryMap = validCategories ? createCategoryMap(validCategories) : null
    if (!categoryMap) logger.warn('solutions-catalog: page-valid-categories is unavailable; category validation and category edges are skipped')

    const resolveDoc = makeResolver(contentCatalog)
    const solutionIds = new Set(collected.solutions.map((s) => s.id))
    const errors = []
    const warnings = []

    if (collected.landing) {
      const landingLayout = collected.landing.asciidoc && collected.landing.asciidoc.attributes['page-layout']
      if (landingLayout !== collect.LAYOUTS.home) errors.push(`solutions: ROOT/pages/index.adoc must set :page-layout: ${collect.LAYOUTS.home} (found "${landingLayout || ''}")`)
    }

    for (const record of collected.solutions) {
      const result = validate.validateSolution(record, { categoryMap, resolveDoc, solutionIds })
      errors.push(...result.errors)
      warnings.push(...result.warnings)
    }

    const rel = validate.validateRelationships(state.relationshipsData || { relationships: [] }, {
      validate: getValidator(), solutionIds, resolveDoc, keyOf: collect.pageKey,
    })
    errors.push(...rel.errors)
    warnings.push(...rel.warnings)

    if (errors.length) throw new Error(validate.formatErrors(errors))
    warnings.forEach((w) => logger.warn(`solutions-catalog: ${w}`))
    if (rel.pendingCount) logger.info(`solutions-catalog: ${rel.pendingCount} pending relationship${rel.pendingCount === 1 ? '' : 's'} awaiting review (ignored by the build)`)

    // Status: drafts vanish unless include_drafts. When included they behave as
    // published for every output (catalog, JSON, graph, recommendations, nav)
    // so a preview shows the real landing page; `status` stays 'draft' and the
    // record carries `draft: true` so the UI can show a Draft chip. Deprecated
    // solutions publish but are never recommended.
    const active = []
    let draftsBuilt = 0
    for (const record of collected.solutions) {
      record.draft = record.status === 'draft'
      if (record.status === 'draft' && !settings.includeDrafts) {
        // The whole module goes: pages, their aliases, and the attachments and
        // images only those pages reference.
        const files = modulePublishables(contentCatalog, { component: collect.COMPONENT, version: collected.version, module: record.module })
        for (const file of files) {
          if (file.pub && file.pub.url && (file.src.family === 'page' || file.src.family === 'alias')) state.draftUrls.push(file.pub.url)
          delete file.out
        }
        ensureUnpublished(siteCatalog, state.draftUrls)
        logger.info(`solutions-catalog: ${record.id} is a draft; unpublished with its attachments, images, and aliases (set SOLUTIONS_INCLUDE_DRAFTS=true to build it)`)
        continue
      }
      if (record.status === 'draft') draftsBuilt++
      active.push(record)
    }
    if (draftsBuilt) logger.warn(`solutions-catalog: building ${draftsBuilt} draft solution${draftsBuilt === 1 ? '' : 's'} because include_drafts is on`)
    if (!active.some((r) => (r.status === 'published' || r.draft) && r.featured)) logger.warn('solutions-catalog: no published solution is featured')

    // Explicit related docs, resolved to keys and display items. A rejected
    // relationship wins over an authored explicit link in both directions: the
    // doc gets no recommendation and the overview drops the doc from
    // relatedDocs. Authors see a warning so the disagreement gets resolved in
    // one place rather than silently.
    const rejectedPairs = new Set(rel.entries.filter((e) => e.status === 'rejected').map((e) => `${e.solutionId} ${e.docKey}`))
    const activeById = new Map(active.map((r) => [r.id, r]))
    for (const record of active) {
      record.relatedDocKeys = new Set()
      record.relatedDocs = []
      for (const ref of record.relatedDocRefs) {
        const page = resolveDoc(collect.stripVersion(ref))
        if (!page) continue
        const key = collect.pageKey(page)
        if (rejectedPairs.has(`${record.id} ${key}`)) {
          logger.warn(`solutions-catalog: ${record.id}: page-solution-related-docs lists ${key} but relationships.yml rejects the pair; the rejection wins and the link is dropped`)
          continue
        }
        record.relatedDocKeys.add(key)
        record.relatedDocs.push({ id: key, title: collect.plainTitle(page.asciidoc && page.asciidoc.doctitle), url: page.pub && page.pub.url, provenance: 'explicit' })
      }
      record.relatedSolutions = record.relatedSolutionIds
        .map((id) => activeById.get(id))
        .filter(Boolean)
        .map((r) => ({ id: r.id, title: r.title, url: r.url }))
    }

    // Recommendations on Product Docs pages
    const docs = eligibleDocPages(contentCatalog).map((page) => {
      const attrs = page.asciidoc.attributes || {}
      const raw = parseCategoryList(attrs['page-categories'])
      const categories = categoryMap ? normalizeCategories(raw, categoryMap).categories : raw
      return { key: collect.pageKey(page), page, url: page.pub && page.pub.url, categories, deployment: getDeploymentType(attrs) }
    })
    const graphInput = categoryMap ? docs : docs.map((d) => ({ ...d, categories: [] }))
    const { related, edges } = relationships.computeRelatedSolutions({
      docs: graphInput,
      solutions: active,
      relationships: rel.entries,
      categoryMap,
      maxRelated: settings.maxRelated,
      minScore: settings.minScore,
    })
    let decorated = 0
    for (const doc of docs) {
      const items = related.get(doc.key)
      if (!items || !items.length) continue
      doc.page.asciidoc.attributes['page-related-solutions'] = JSON.stringify(items)
      decorated++
    }

    // Page attributes and the catalog
    const homeUrl = collected.landing && collected.landing.pub && collected.landing.pub.url
    const publicRecords = []
    for (const record of active) {
      const steps = outputs.buildSteps(record)
      const publicRecord = outputs.buildPublicRecord(record, { steps, relatedDocs: record.relatedDocs, relatedSolutions: record.relatedSolutions })
      const nav = outputs.buildNav(publicRecord, { homeUrl })
      outputs.applyPageAttributes(record, publicRecord, nav)
      publicRecords.push(publicRecord)
    }

    const siteUrl = (playbook && playbook.site && playbook.site.url) || ''
    const generatedAt = new Date().toISOString()
    state.records = active
    state.catalog = outputs.buildCatalog(publicRecords, { siteUrl, generatedAt })
    state.graph = outputs.buildGraph(edges, { siteUrl, generatedAt, maxRelated: settings.maxRelated, minScore: settings.minScore })
    addAttributeToComponents(contentCatalog, ATTRIBUTE_NAME, JSON.stringify(state.catalog), logger)

    logger.info(`solutions-catalog: ${state.catalog.solutions.length} solution${state.catalog.solutions.length === 1 ? '' : 's'} in the catalog, ${edges.length} graph edges, ${decorated} doc pages decorated with page-related-solutions`)
  })

  this.on('navigationBuilt', ({ siteCatalog }) => {
    ensureUnpublished(siteCatalog, state.draftUrls)
  })

  this.on('beforePublish', async ({ siteCatalog, playbook }) => {
    ensureUnpublished(siteCatalog, state.draftUrls)
    if (!state.catalog) return
    const siteUrl = (playbook && playbook.site && playbook.site.url) || ''
    if (siteUrl && !state.catalog.siteUrl) {
      state.catalog.siteUrl = siteUrl
      state.graph.siteUrl = siteUrl
    }
    siteCatalog.addFile({ contents: outputs.toJsonBuffer(state.catalog), out: { path: `${ASSET_DIR}/${CATALOG_FILENAME}` } })
    siteCatalog.addFile({ contents: outputs.toJsonBuffer(state.graph), out: { path: `${ASSET_DIR}/${GRAPH_FILENAME}` } })
    logger.info(`solutions-catalog: published ${ASSET_DIR}/${CATALOG_FILENAME} and ${ASSET_DIR}/${GRAPH_FILENAME}`)

    if (shouldRunNetworkChecks(settings.networkChecks)) {
      await checkReleases(state.records, logger)
    }
  })
}

module.exports.ATTRIBUTE_NAME = ATTRIBUTE_NAME
module.exports.ASSET_DIR = ASSET_DIR
module.exports.CATALOG_FILENAME = CATALOG_FILENAME
module.exports.GRAPH_FILENAME = GRAPH_FILENAME
module.exports.EXCLUDED_DOC_COMPONENTS = EXCLUDED_DOC_COMPONENTS
module.exports.UMBRELLA_LAYOUTS = UMBRELLA_LAYOUTS
module.exports.DEFAULTS = DEFAULTS
module.exports.resolveConfig = resolveConfig
module.exports.shouldRunNetworkChecks = shouldRunNetworkChecks
module.exports.eligibleDocPages = eligibleDocPages
module.exports.checkReleases = checkReleases
module.exports.ensureUnpublished = ensureUnpublished
