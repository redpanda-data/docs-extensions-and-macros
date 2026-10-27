'use strict'

/**
 * The docs taxonomy: the controlled vocabulary in the docs repository at
 * shared/modules/ROOT/attachments/taxonomy.yml, with its JSON Schema
 * taxonomy.schema.json next to it.
 *
 * It is read from the content catalog (the `shared` component's attachments),
 * never merged into page attributes: add-global-attributes only reads
 * modules/ROOT/partials/, and the taxonomy is build data, not page data. The
 * loaded object is shared site-wide on `siteCatalog.taxonomy` and cached per
 * content catalog, so every extension in one build resolves against the same
 * instance.
 *
 * When the file is absent, `getTaxonomy` returns null after one warning and
 * every caller keeps its pre-taxonomy behavior, so DEM and the docs repo can
 * deploy in either order. When the file is present it must be valid: a schema
 * violation, a duplicate ID, a duplicate label across schemes, or a dangling
 * reference fails the build.
 *
 * Everything below the loader is pure, so resolution can be unit tested
 * without Antora.
 */

const yaml = require('js-yaml')

const SCHEMES = Object.freeze(['topic', 'task', 'content-type', 'use-case', 'industry', 'technology', 'deployment'])
const TAXONOMY_COMPONENT = 'shared'
const TAXONOMY_FILENAME = 'taxonomy.yml'
const SCHEMA_FILENAME = 'taxonomy.schema.json'
const SOURCE_PATH = `${TAXONOMY_COMPONENT}/modules/ROOT/attachments/${TAXONOMY_FILENAME}`
// Where the published file lives: the shared component is unversioned, so its
// attachments are served from /shared/_attachments/.
const PUBLIC_URL = `https://docs.redpanda.com/${TAXONOMY_COMPONENT}/_attachments/${TAXONOMY_FILENAME}`

class TaxonomyError extends Error {
  constructor (errors) {
    super(`${SOURCE_PATH} is invalid:\n  - ${errors.join('\n  - ')}`)
    this.name = 'TaxonomyError'
    this.errors = errors
  }
}

/** Case-insensitive, whitespace-collapsed lookup key. NFKC folds no-break spaces. */
function normalizeKey (value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Compile a JSON Schema (draft 2020-12) with the same Ajv setup as the rest of DEM. */
function compileSchema (schema) {
  const Ajv2020 = require('ajv/dist/2020')
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  return ajv.compile(schema)
}

class Taxonomy {
  /**
   * @param {Object} data - the parsed taxonomy.yml
   * @throws {TaxonomyError} on duplicate IDs or labels and dangling references
   */
  constructor (data) {
    this.schemaVersion = data['schema-version']
    this.schemes = new Map()
    this.concepts = new Map()
    this._labels = new Map() // normalized label -> { id, via }
    this._ids = new Map() // normalized id -> id
    this._narrower = new Map()
    this._replacing = new Map() // live id -> deprecated ids that list it in replacedBy, file order
    const errors = []

    for (const scheme of data.schemes || []) {
      if (this.schemes.has(scheme.id)) errors.push(`scheme ${scheme.id} is defined more than once`)
      const { concepts, ...meta } = scheme
      this.schemes.set(scheme.id, { ...meta, conceptIds: [] })
      for (const raw of concepts || []) {
        const concept = {
          id: raw.id,
          scheme: scheme.id,
          prefLabel: raw.prefLabel,
          altLabels: raw.altLabels || [],
          definition: raw.definition || '',
          broader: raw.broader || null,
          related: raw.related || [],
          implies: raw.implies || [],
          deprecated: raw.deprecated === true,
          replacedBy: raw.replacedBy || [],
        }
        if (raw.kind) concept.kind = raw.kind
        if (raw.component) concept.component = raw.component
        if (this.concepts.has(concept.id)) {
          errors.push(`concept ID ${concept.id} is defined more than once (in ${this.concepts.get(concept.id).scheme} and ${scheme.id})`)
          continue
        }
        this.concepts.set(concept.id, concept)
        this._ids.set(normalizeKey(concept.id), concept.id)
        this.schemes.get(scheme.id).conceptIds.push(concept.id)
        const own = new Set()
        for (const [label, via] of [[concept.prefLabel, 'prefLabel'], ...concept.altLabels.map((l) => [l, 'altLabel'])]) {
          const key = normalizeKey(label)
          if (!key) continue
          if (own.has(key)) continue // a concept may repeat its own label in another case
          own.add(key)
          const taken = this._labels.get(key)
          if (taken) {
            const other = this.concepts.get(taken.id)
            errors.push(`label "${label}" of ${scheme.id}/${concept.id} duplicates the ${taken.via} "${taken.label}" of ${other.scheme}/${other.id}; labels and altLabels must be unique across all schemes`)
            continue
          }
          this._labels.set(key, { id: concept.id, via, label })
        }
      }
    }

    for (const concept of this.concepts.values()) {
      const where = `${concept.scheme}/${concept.id}`
      const ref = (id, field) => {
        if (!this.concepts.has(id)) {
          errors.push(`${where}: ${field} names ${id}, which is not a concept`)
          return null
        }
        return this.concepts.get(id)
      }
      if (concept.broader) {
        const parent = ref(concept.broader, 'broader')
        if (parent) {
          if (parent.scheme !== concept.scheme) errors.push(`${where}: broader ${parent.id} is in the ${parent.scheme} scheme; broader must stay in the same scheme`)
          if (parent.broader) errors.push(`${where}: broader ${parent.id} has its own broader concept; hierarchies have two levels at most`)
          if (parent.deprecated && !concept.deprecated) errors.push(`${where}: broader ${parent.id} is deprecated`)
          if (!this._narrower.has(parent.id)) this._narrower.set(parent.id, [])
          this._narrower.get(parent.id).push(concept.id)
        }
      }
      for (const id of concept.related) ref(id, 'related')
      for (const id of concept.implies) {
        const target = ref(id, 'implies')
        if (target && target.scheme === concept.scheme) errors.push(`${where}: implies ${id} in the same scheme; use broader instead`)
        if (target && target.deprecated) errors.push(`${where}: implies ${id}, which is deprecated`)
      }
      if (concept.deprecated) {
        for (const id of concept.replacedBy) {
          const target = ref(id, 'replacedBy')
          if (target && target.deprecated) errors.push(`${where}: replacedBy ${id}, which is itself deprecated; point at the live concept`)
          if (target) {
            if (!this._replacing.has(id)) this._replacing.set(id, [])
            this._replacing.get(id).push(concept.id)
          }
        }
      } else if (concept.replacedBy.length) {
        errors.push(`${where}: replacedBy is set but the concept is not deprecated`)
      }
    }

    // An ID that reads like another concept's label in the same scheme would
    // make lookups by ID and by label disagree.
    for (const concept of this.concepts.values()) {
      const taken = this._labels.get(normalizeKey(concept.id))
      if (!taken || taken.id === concept.id) continue
      const other = this.concepts.get(taken.id)
      if (other.scheme === concept.scheme) errors.push(`${concept.scheme}/${concept.id}: the ID equals the ${taken.via} "${taken.label}" of ${other.id} in the same scheme`)
    }

    if (errors.length) throw new TaxonomyError(errors)
  }

  /** @returns {Object|undefined} the concept with this exact ID */
  get (id) {
    return this.concepts.get(id)
  }

  /** prefLabel of an ID, or the ID itself when unknown. */
  label (id) {
    const concept = this.concepts.get(id)
    return concept ? concept.prefLabel : id
  }

  /** IDs of the concepts whose broader is this one. */
  narrower (id) {
    return this._narrower.get(id) || []
  }

  /** IDs of the concepts in a scheme, in file order. */
  conceptIds (scheme, { includeDeprecated = false } = {}) {
    const entry = this.schemes.get(scheme)
    if (!entry) return []
    return entry.conceptIds.filter((id) => includeDeprecated || !this.concepts.get(id).deprecated)
  }

  /**
   * Find the concept a value names, by ID or by label.
   *
   * @param {string} value
   * @param {Object} [options]
   * @param {Array<string>} [options.schemes] - only accept concepts in these schemes
   * @param {'label'|'id'} [options.prefer='label'] - which to try first. Authored
   *   labels (page-categories, technologies) prefer labels; ID-valued attributes
   *   (page-topic-type, platforms) prefer IDs.
   * @returns {{concept: Object, via: 'id'|'prefLabel'|'altLabel'}|null}
   */
  lookup (value, { schemes, prefer = 'label' } = {}) {
    const key = normalizeKey(value)
    if (!key) return null
    const allowed = (concept) => !schemes || schemes.includes(concept.scheme)
    const byLabel = () => {
      const hit = this._labels.get(key)
      const concept = hit && this.concepts.get(hit.id)
      return concept && allowed(concept) ? { concept, via: hit.via } : null
    }
    const byId = () => {
      const id = this._ids.get(key)
      const concept = id && this.concepts.get(id)
      return concept && allowed(concept) ? { concept, via: 'id' } : null
    }
    return prefer === 'id' ? (byId() || byLabel()) : (byLabel() || byId())
  }

  /**
   * Resolve a value to the live concept IDs it stands for. A deprecated concept
   * resolves to its replacedBy (possibly empty).
   *
   * @returns {{value: string, concept: Object, via: string, deprecated: boolean, ids: Array<string>}|null}
   *   null when the value names no concept
   */
  resolve (value, options) {
    const hit = this.lookup(value, options)
    if (!hit) return null
    const { concept, via } = hit
    return {
      value,
      concept,
      via,
      deprecated: concept.deprecated,
      ids: concept.deprecated ? [...concept.replacedBy] : [concept.id],
    }
  }

  /**
   * Add what a set of directly assigned concepts implies: every broader
   * ancestor and every `implies` target (and its ancestors). Direct always wins
   * over implied for the same ID.
   *
   * @param {Iterable<string>} directIds
   * @returns {Map<string, 'direct'|'implied'>} in insertion order
   */
  expand (directIds) {
    const out = new Map()
    for (const id of directIds) if (this.concepts.has(id)) out.set(id, 'direct')
    const imply = (id) => {
      if (!out.has(id)) out.set(id, 'implied')
    }
    for (const id of [...out.keys()]) {
      const concept = this.concepts.get(id)
      if (concept.broader) imply(concept.broader)
      for (const target of concept.implies) {
        imply(target)
        const t = this.concepts.get(target)
        if (t && t.broader) imply(t.broader)
      }
    }
    return out
  }

  /**
   * Classify a list of authored values (for example `page-categories`).
   *
   * @param {Array<string>} values
   * @param {Object} [options] - passed to `lookup`
   * @returns {{concepts: Map<string, 'direct'|'implied'>, resolved: Array<Object>, deprecated: Array<Object>, unknown: Array<string>}}
   */
  classify (values, options) {
    const direct = []
    const resolved = []
    const deprecated = []
    const unknown = []
    for (const value of values || []) {
      const r = this.resolve(value, options)
      if (!r) {
        unknown.push(value)
        continue
      }
      resolved.push(r)
      if (r.deprecated) deprecated.push({ value, id: r.concept.id, replacedBy: r.ids })
      direct.push(...r.ids)
    }
    return { concepts: this.expand(direct), resolved, deprecated, unknown }
  }

  /**
   * Group concept IDs by scheme.
   *
   * @param {Map<string, string>|Iterable<string>} concepts
   * @returns {Object<string, Array<string>>} one (possibly empty) array per scheme
   */
  byScheme (concepts) {
    const out = {}
    for (const scheme of SCHEMES) out[scheme] = []
    const ids = concepts instanceof Map ? concepts.keys() : concepts
    for (const id of ids) {
      const concept = this.concepts.get(id)
      if (concept && out[concept.scheme]) out[concept.scheme].push(id)
    }
    return out
  }

  /**
   * The technology concepts whose `component` is this Antora component.
   * A page in the `connect` component is about Redpanda Connect.
   */
  technologiesForComponent (componentName) {
    if (!componentName) return []
    return this.conceptIds('technology').filter((id) => this.concepts.get(id).component === componentName)
  }

  /**
   * A label for this concept that the legacy valid-categories list accepts, so
   * a page authored with new labels still emits the old `categories` values.
   * Tries the concept's own labels, then the deprecated concepts it replaces,
   * in file order.
   *
   * @param {string} id
   * @param {(label: string) => boolean} isLegacy
   * @returns {string|null}
   */
  legacyLabel (id, isLegacy) {
    const concept = this.concepts.get(id)
    if (!concept) return null
    for (const label of [concept.prefLabel, ...concept.altLabels]) if (isLegacy(label)) return label
    for (const oldId of this._replacing.get(id) || []) {
      const old = this.concepts.get(oldId)
      for (const label of [old.prefLabel, ...old.altLabels]) if (isLegacy(label)) return label
    }
    return null
  }

  /** Plain JSON for publishing: concept ID -> public fields. */
  toJSON () {
    return {
      schemaVersion: this.schemaVersion,
      concepts: [...this.concepts.values()],
    }
  }
}

/**
 * Parse and validate taxonomy.yml.
 *
 * @param {string|Buffer} text
 * @param {Object} [options]
 * @param {Object} [options.schema] - taxonomy.schema.json, parsed. Without it only
 *   the structural checks in the Taxonomy constructor run.
 * @returns {Taxonomy}
 * @throws {TaxonomyError}
 */
function parseTaxonomy (text, { schema } = {}) {
  let data
  try {
    data = yaml.load(String(text || ''), { schema: yaml.CORE_SCHEMA })
  } catch (err) {
    throw new TaxonomyError([`YAML does not parse: ${err.message}`])
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TaxonomyError(['the file is empty or not a mapping'])
  if (schema) {
    const check = compileSchema(schema)
    if (!check(data)) {
      throw new TaxonomyError((check.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}${e.params && e.params.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`))
    }
  }
  return new Taxonomy(data)
}

/** The shared component's attachment with this relative path, or undefined. */
function findSharedAttachment (contentCatalog, relative) {
  if (!contentCatalog || typeof contentCatalog.findBy !== 'function') return undefined
  return contentCatalog
    .findBy({ component: TAXONOMY_COMPONENT, family: 'attachment' })
    .find((file) => file.src && file.src.module === 'ROOT' && file.src.relative === relative)
}

const cache = new WeakMap()
const silentLogger = { info () {}, warn () {}, debug () {}, error () {} }

/**
 * Load the taxonomy from the content catalog once per build.
 *
 * @param {Object} contentCatalog
 * @param {Object} [options]
 * @param {Object} [options.logger]
 * @returns {Taxonomy|null} null when taxonomy.yml is not in the shared component
 * @throws {TaxonomyError} when it is present and invalid
 */
function loadTaxonomy (contentCatalog, { logger = silentLogger } = {}) {
  if (contentCatalog && cache.has(contentCatalog)) return cache.get(contentCatalog)
  const file = findSharedAttachment(contentCatalog, TAXONOMY_FILENAME)
  let taxonomy = null
  if (!file) {
    logger.warn(`taxonomy: ${SOURCE_PATH} not found; categories are checked against valid-categories.yml only and no taxonomy facets are emitted`)
  } else {
    const schemaFile = findSharedAttachment(contentCatalog, SCHEMA_FILENAME)
    let schema
    if (schemaFile) {
      try {
        schema = JSON.parse(schemaFile.contents.toString('utf8'))
      } catch (err) {
        throw new TaxonomyError([`${SCHEMA_FILENAME} is not valid JSON: ${err.message}`])
      }
    } else {
      logger.warn(`taxonomy: ${SCHEMA_FILENAME} not found next to ${TAXONOMY_FILENAME}; only the structural checks run`)
    }
    taxonomy = parseTaxonomy(file.contents, { schema })
    logger.info(`taxonomy: loaded ${taxonomy.concepts.size} concepts in ${taxonomy.schemes.size} schemes from ${SOURCE_PATH}`)
  }
  if (contentCatalog) cache.set(contentCatalog, taxonomy)
  return taxonomy
}

/**
 * The site-wide taxonomy: `siteCatalog.taxonomy` when an earlier extension has
 * loaded it, otherwise loaded now and stored there.
 *
 * @param {{contentCatalog: Object, siteCatalog?: Object, logger?: Object}} vars
 * @returns {Taxonomy|null}
 */
function getTaxonomy ({ contentCatalog, siteCatalog, logger } = {}) {
  if (siteCatalog && siteCatalog.taxonomy !== undefined) return siteCatalog.taxonomy
  const taxonomy = loadTaxonomy(contentCatalog, { logger })
  if (siteCatalog) siteCatalog.taxonomy = taxonomy
  return taxonomy
}

const isUrl = (s) => /^https?:\/\//i.test(String(s))
const siblingOf = (source, name) => (isUrl(source) ? new URL(name, source).toString() : require('path').join(require('path').dirname(source), name))

/** Read a local file or fetch a URL; null when it does not exist (ENOENT or 404). */
async function readSource (source, fetchImpl) {
  if (isUrl(source)) {
    if (typeof fetchImpl !== 'function') throw new Error(`cannot fetch ${source}: no fetch in this Node.js`)
    const res = await fetchImpl(source)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`fetching ${source} failed with HTTP ${res.status}`)
    // A host that answers a missing file with an HTML page (a soft 404) has
    // not served the file.
    const type = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || ''
    if (/text\/html/i.test(type)) return null
    return res.text()
  }
  try {
    return require('fs').readFileSync(source, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/**
 * Load the taxonomy outside Antora, for doc-tools and agents.
 *
 * With `source` (a path or URL), only that is read. Otherwise the first that
 * exists of:
 *   1. <root>/shared/modules/ROOT/attachments/taxonomy.yml (root is the docs repo checkout)
 *   2. $REDPANDA_DOCS_PATH/shared/modules/ROOT/attachments/taxonomy.yml (a docs checkout elsewhere)
 *   3. the published file, https://docs.redpanda.com/shared/_attachments/taxonomy.yml
 * taxonomy.schema.json is read from beside whichever was used.
 *
 * @param {Object} [options]
 * @param {string} [options.source]
 * @param {string} [options.root=process.cwd()]
 * @param {Object} [options.env=process.env]
 * @param {Function} [options.fetch=globalThis.fetch]
 * @returns {Promise<{taxonomy: Taxonomy, source: string, schemaSource: string|null, warnings: string[]}>}
 * @throws {TaxonomyError} when the file is invalid; Error when none is found
 */
async function loadTaxonomyFrom ({ source, root = process.cwd(), env = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
  const path = require('path')
  const candidates = source
    ? [isUrl(source) ? source : path.resolve(root, source)]
    : [
        path.join(root, SOURCE_PATH),
        ...(env.REDPANDA_DOCS_PATH ? [path.join(path.resolve(env.REDPANDA_DOCS_PATH), SOURCE_PATH)] : []),
        PUBLIC_URL,
      ]
  const tried = []
  for (const candidate of candidates) {
    const text = await readSource(candidate, fetchImpl)
    tried.push(candidate)
    if (text === null) continue
    const warnings = []
    const schemaSource = siblingOf(candidate, SCHEMA_FILENAME)
    const schemaText = await readSource(schemaSource, fetchImpl)
    let schema
    if (schemaText === null) {
      warnings.push(`${SCHEMA_FILENAME} not found beside ${candidate}; only the structural checks ran`)
    } else {
      try {
        schema = JSON.parse(schemaText)
      } catch (err) {
        throw new TaxonomyError([`${schemaSource} is not valid JSON: ${err.message}`])
      }
    }
    return { taxonomy: parseTaxonomy(text, { schema }), source: candidate, schemaSource: schema ? schemaSource : null, warnings }
  }
  throw new Error(`no ${TAXONOMY_FILENAME} found; tried ${tried.join(', ')}`)
}

/**
 * Search facets for a page from its authored categories, its deployment type,
 * and its component. Implied concepts are included: a page tagged Replication
 * is also under High Availability for a reader filtering on it.
 *
 * @param {Taxonomy} taxonomy
 * @param {Object} input
 * @param {Array<string>} [input.categories] - authored page-categories values
 * @param {string} [input.deployment] - from the env-* attributes (Kubernetes, Linux, Docker, Redpanda Cloud)
 * @param {string} [input.component] - Antora component name
 * @returns {{topics: string[], topicIds: string[], useCases: string[], useCaseIds: string[], technologies: string[], technologyIds: string[], deployment: string[], deploymentIds: string[]}}
 */
function pageFacets (taxonomy, { categories = [], deployment = '', component = '' } = {}) {
  const { concepts } = taxonomy.classify(categories)
  const direct = [...concepts.keys()]
  const deploymentHit = deployment ? taxonomy.resolve(deployment, { schemes: ['deployment'] }) : null
  if (deploymentHit) direct.push(...deploymentHit.ids)
  direct.push(...taxonomy.technologiesForComponent(component))
  const grouped = taxonomy.byScheme(taxonomy.expand(direct))
  const labels = (ids) => ids.map((id) => taxonomy.label(id))
  return {
    topics: labels(grouped.topic),
    topicIds: grouped.topic,
    useCases: labels(grouped['use-case']),
    useCaseIds: grouped['use-case'],
    technologies: labels(grouped.technology),
    technologyIds: grouped.technology,
    deployment: labels(grouped.deployment),
    deploymentIds: grouped.deployment,
  }
}

/**
 * The authored categories of a page. validate-attributes rewrites
 * page-categories to the legacy list (parents added), and keeps what the
 * author wrote in page-categories-authored, which is what the taxonomy
 * resolves: the added legacy parents (Deployment under Iceberg, for example)
 * are exactly the relations the taxonomy corrects.
 */
function authoredCategories (attributes) {
  if (!attributes) return []
  const raw = attributes['page-categories-authored'] !== undefined ? attributes['page-categories-authored'] : attributes['page-categories']
  if (Array.isArray(raw)) return raw.map((c) => String(c).trim()).filter(Boolean)
  if (typeof raw !== 'string') return []
  return raw.split(',').map((c) => c.trim()).filter(Boolean)
}

module.exports = {
  SCHEMES,
  TAXONOMY_FILENAME,
  SCHEMA_FILENAME,
  SOURCE_PATH,
  PUBLIC_URL,
  Taxonomy,
  TaxonomyError,
  normalizeKey,
  parseTaxonomy,
  loadTaxonomy,
  loadTaxonomyFrom,
  getTaxonomy,
  pageFacets,
  authoredCategories,
  findSharedAttachment,
}
