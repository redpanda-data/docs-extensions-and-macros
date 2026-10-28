'use strict'

/* Values of one Redpanda Connect field from a published connect-<version>.json
 * (rp-connect-docs modules/components/attachments), rendered the way the
 * generated component reference prints them.
 *
 * Shared by the connectval: inline macro (macros/connectval.js) and the
 * check-reference-values report. The *Type*: and *Default*: text comes from
 * the reference generator's own helpers (formatConnectDefault.js), so a
 * value written with the macro is always the value the reference shows.
 *
 * Connect versions are Connect's own (4.x), independent of Redpanda's, so the
 * page's component and version never select the dataset: every page reads the
 * newest connect-<version>.json in the connect component.
 */

const { escapeHtml } = require('./html-utils')
const datasets = require('./attachment-datasets')
const { normalizeType, isCloudAvailable } = require('../extensions/util/connect-catalog')
const { formatConnectDefault, connectDisplayType } = require('../tools/redpanda-connect/helpers/formatConnectDefault')
const logger = require('@antora/logger')('connectval-macro')

const FORMAT_HUMAN = 'human'
const FORMAT_RAW = 'raw'

// Every field connectval: supports. `cloudHidden` marks the fields the
// reference wraps in ifndef::env-cloud[] ("Requires version ... or later").
const FIELDS = {
  default: { cloudHidden: false },
  type: { cloudHidden: false },
  options: { cloudHidden: false },
  deprecated: { cloudHidden: false },
  introduced: { cloudHidden: true },
}

const FIELD_ALIASES = {
  values: 'options',
  annotated_options: 'options',
  is_deprecated: 'deprecated',
  version: 'introduced',
}

// The component a page addresses with component=config: the root fields of a
// pipeline config (input, pipeline, http, logger, ...).
const CONFIG_COMPONENT = 'config'

const $connectRegistry = Symbol('$connectRegistry')
const $connectSeriesGap = Symbol('$connectSeriesGap')

const CONNECT_JSON_RX = /^connect-(\d+\.\d+\.\d+)\.json$/
const CONNECT_COMPONENT = 'connect'

const CONNECT_KIND = {
  name: 'connect',
  module: 'components',
  rx: CONNECT_JSON_RX,
  filePrefix: 'connect-',
  label: 'Connect data',
  regenerate: "'npx doc-tools generate rpcn-connector-docs'",
  borrowWhen: [],
  lenders: [],
  cacheSymbol: $connectRegistry,
  gapSymbol: $connectSeriesGap,
  keyPrefix: 'connect:',
  invalidKey: 'invalid',
  validate: (data) => {
    if (typeof data.version !== 'string') return "has no 'version' string"
    if (!Array.isArray(data.inputs)) return "has no 'inputs' array"
    return true
  },
  notObjectReason: 'is not a JSON object',
  logger,
  text: {
    log: 'connectval macro',
    macro: 'connectval:',
    attachment: 'Connect attachment',
    releaseNoun: 'components',
    effect: (where) => `connectval: values${where} therefore render as placeholders`,
    generateSeries: () => "'npx doc-tools generate rpcn-connector-docs'",
    noData: () =>
      'connectval macro: no connect-<version>.json in connect:components attachments; add the rp-connect-docs content source to the playbook. connectval: values render as placeholders.',
  },
}

const own = (object, key) => Boolean(object) && Object.prototype.hasOwnProperty.call(object, key)

/**
 * The Connect dataset for any page: the newest connect-<version>.json in the
 * connect component's latest version, whatever component the page is in.
 */
function loadConnect (contentCatalog) {
  const component = typeof contentCatalog.getComponent === 'function' ? contentCatalog.getComponent(CONNECT_COMPONENT) : undefined
  const version = (component && component.latest && component.latest.version) || ''
  return datasets.loadDatasetFor(contentCatalog, CONNECT_COMPONENT, version, CONNECT_KIND)
}

/**
 * Every connect-<version>.json in the connect component, newest first.
 */
function connectDatasets (contentCatalog) {
  return datasets.datasetsMatching(contentCatalog, CONNECT_KIND)
    .filter((d) => d.component === CONNECT_COMPONENT)
    .sort((a, b) => datasets.compareTags(b.tag, a.tag))
}

/**
 * Canonical field name, or undefined for a field connectval: does not support.
 */
function normalizeField (field) {
  const key = String(field == null ? '' : field).trim().toLowerCase()
  if (own(FIELDS, key)) return key
  if (own(FIELD_ALIASES, key)) return FIELD_ALIASES[key]
  return undefined
}

/**
 * The dataset's component types, read from the data itself: each top-level
 * array whose elements carry a type maps that normalized type to its key
 * (input -> inputs, rate_limit -> rate-limits, metrics -> metrics).
 */
function componentTypes (data) {
  const types = {}
  for (const [key, list] of Object.entries(data || {})) {
    if (!Array.isArray(list) || !list.length || key === 'config') continue
    const first = list.find((entry) => entry && typeof entry.type === 'string')
    if (!first) continue
    types[normalizeType(first.type)] = key
  }
  return types
}

/**
 * Resolve <type>/<name> (inputs/kafka_franz, rate-limits/local) or config.
 *
 * @returns {{ok: true, key: string, type: string, entry: object, fields: object[]} |
 *   {ok: false, kind: 'unknown-type'|'unknown-component', message: string, suggestions: string[]}}
 */
function resolveComponent (data, type, name) {
  if (type === CONFIG_COMPONENT && (name === undefined || name === '')) {
    return { ok: true, key: CONFIG_COMPONENT, type: CONFIG_COMPONENT, entry: undefined, fields: Array.isArray(data.config) ? data.config : [] }
  }
  const types = componentTypes(data)
  const normalized = normalizeType(type)
  if (!own(types, normalized)) {
    const suggestions = datasets.suggest(type, Object.values(types).map((k) => k.replace(/-/g, '_')))
    return { ok: false, kind: 'unknown-type', suggestions, message: `'${type}' is not a component type` }
  }
  const key = types[normalized]
  const entry = data[key].find((c) => c && c.name === name)
  if (!entry) {
    const suggestions = datasets.suggest(name, data[key].map((c) => c && c.name).filter(Boolean))
    return { ok: false, kind: 'unknown-component', suggestions, message: `'${name}' is not ${/^[aeiou]/.test(normalized) ? 'an' : 'a'} ${normalized} component` }
  }
  const fields = entry.config && Array.isArray(entry.config.children) ? entry.config.children : []
  return { ok: true, key, type: normalized, entry, fields }
}

// Why a walk cannot go below a field, or undefined when it can. A map with
// children is a map of objects, and the reference documents those children,
// so a path may name them (tools.parameters.properties.type).
function stopReason (field) {
  const hasChildren = Array.isArray(field.children) && field.children.length > 0
  if (field.kind === 'map' && !hasChildren) return 'is a map, whose keys are not in the data'
  if (field.type === 'unknown') return 'has type unknown, whose shape is not in the data'
  if (field.bloblang === true) return 'is a Bloblang mapping'
  if (!Array.isArray(field.children) || !field.children.length) return 'has no child fields'
  return undefined
}

const segmentName = (segment) => String(segment).replace(/\[\]$/, '')

/**
 * Walk a dot-separated field path through config children. An array of
 * objects is addressed without an index (sasl.mechanism), because the data
 * stores one element's children.
 *
 * @returns {{ok: true, field: object} |
 *   {ok: false, kind: 'unknown-field', at: number, message: string, suggestions: string[]}}
 */
function resolveFieldPath (fields, segments) {
  let children = fields
  let field
  for (let i = 0; i < segments.length; i++) {
    const name = segmentName(segments[i])
    if (field) {
      const stop = stopReason(field)
      if (stop) {
        return { ok: false, kind: 'unknown-field', at: i, suggestions: [], message: `'${segments.slice(0, i).join('.')}' ${stop}, so '${segments.slice(0, i + 1).join('.')}' cannot be checked` }
      }
      children = field.children
    }
    const next = (children || []).find((c) => c && segmentName(c.name) === name)
    if (!next) {
      const suggestions = datasets.suggest(name, (children || []).map((c) => c && c.name).filter(Boolean))
      const parent = segments.slice(0, i).join('.')
      return { ok: false, kind: 'unknown-field', at: i, suggestions, message: `'${name}' is not a field${parent ? ` of '${parent}'` : ''}` }
    }
    field = next
  }
  return field ? { ok: true, field } : { ok: false, kind: 'unknown-field', at: 0, suggestions: [], message: 'no field path given' }
}

/**
 * The options of a field: options, else the first element of each
 * annotated_options pair.
 */
function optionsOf (field) {
  if (Array.isArray(field.options) && field.options.length) return field.options.map(String)
  if (Array.isArray(field.annotated_options) && field.annotated_options.length) {
    return field.annotated_options.map((pair) => String(Array.isArray(pair) ? pair[0] : pair))
  }
  return undefined
}

/**
 * The value of one field of one Connect config field.
 *
 * @returns {{ok: true, text: string, html?: string} | {ok: false, reason: string}}
 */
function fieldValue (field, name, { format = FORMAT_HUMAN } = {}) {
  const canonical = normalizeField(name)
  const raw = format === FORMAT_RAW
  switch (canonical) {
    case 'default': {
      const formatted = formatConnectDefault(field)
      if (!formatted.ok) return formatted
      // An empty default whose description names the real one, such as
      // gcp_spanner_cdc.metadata_table: the reference prints "", which
      // says nothing true. Never parse it out of the description.
      if (field.default === '' && /\(default:?\s/i.test(String(field.description || ''))) return { ok: false, reason: 'description-default' }
      return formatted
    }
    case 'type':
      return { ok: true, text: String(connectDisplayType(field)) }
    case 'options': {
      const list = optionsOf(field)
      if (!list) return { ok: false, reason: 'missing' }
      if (raw) return { ok: true, text: JSON.stringify(list) }
      return { ok: true, text: list.join(', '), html: list.map((v) => `<code>${escapeHtml(v)}</code>`).join(', ') }
    }
    case 'deprecated': {
      const value = field.is_deprecated === true
      return { ok: true, text: raw ? String(value) : (value ? 'yes' : 'no') }
    }
    case 'introduced':
      return typeof field.version === 'string' && field.version ? { ok: true, text: field.version } : { ok: false, reason: 'missing' }
    default:
      return { ok: false, reason: 'unsupported' }
  }
}

/**
 * Parse component= into {type, name}: inputs/kafka_franz, or config.
 */
function parseComponent (component) {
  const text = String(component == null ? '' : component).trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim()
  if (text === CONFIG_COMPONENT) return { type: CONFIG_COMPONENT, name: '' }
  const slash = text.indexOf('/')
  if (slash <= 0) return undefined
  return { type: text.slice(0, slash).trim(), name: text.slice(slash + 1).trim() }
}

/**
 * Whether a component is available in Cloud, and from which source:
 * translated csvData rows first (they count GPU-only components as
 * available), then the dataset's own cloudSupported.
 *
 * @returns {{available: boolean|undefined, source: string}}
 */
function cloudAvailability ({ registry, type, name, entry, csvRows }) {
  if (Array.isArray(csvRows)) {
    const row = csvRows.find((r) => r && (r.connector || r.name) === name && normalizeType(r.type) === normalizeType(type))
    if (row) return { available: isCloudAvailable(row), source: 'csvData' }
  }
  if (entry && typeof entry.cloudSupported === 'boolean') {
    return { available: entry.cloudSupported, source: `${datasets.describeDataset(registry).split(' from ')[0]} cloudSupported` }
  }
  return { available: undefined, source: 'none' }
}

/**
 * Resolve one connectval: call to its value, or to the reason there is none.
 *
 * @param {object} opts
 * @param {object} [opts.registry] - From loadConnect.
 * @param {string} opts.component - component= as written.
 * @param {string} opts.path - The target field path.
 * @param {string} [opts.field]
 * @param {string} [opts.format]
 * @param {boolean} [opts.cloud] - Whether the page renders for Cloud.
 * @param {object[]} [opts.csvRows] - Translated csvData rows, when the build has them.
 * @param {string} [opts.filePath]
 * @returns {{ok: true, text: string, html?: string, field: string, registry: object, warnings: object[]} |
 *   {ok: false, kind: string, message: string, field: string, registry?: object, suggestions?: string[], warnings?: object[]}}
 *   warnings are warn-only notices for a value that still renders
 *   (deprecated-field, cloud-unknown).
 */
function resolveConnectValue ({ registry, component, path: target, field: requested = 'default', format = FORMAT_HUMAN, cloud = false, csvRows, filePath }) {
  const fieldName = normalizeField(requested)
  const rawTarget = String(target == null ? '' : target).trim()
  const componentAttr = component !== undefined && component !== null && String(component).trim() !== '' ? `,component=${String(component).trim()}` : ''
  const call = `connectval:${rawTarget}[${requested}${componentAttr}]${filePath ? ` in ${filePath}` : ''}`
  const field = fieldName || requested
  if (!fieldName) {
    return { ok: false, kind: 'unsupported-field', field, message: `${call}: '${requested}' is not a field connectval: supports. Supported fields: ${Object.keys(FIELDS).join(', ')}.` }
  }
  if (!registry) {
    return { ok: false, kind: 'no-data', field, message: `${call}: this page has no Connect data to read '${field}' from (see the connectval macro warning), so it renders <unknown ${field}>.` }
  }
  const dataset = datasets.describeDataset(registry)
  const parsed = parseComponent(component)
  if (!parsed) {
    return { ok: false, kind: 'unknown-component', field, registry, message: `${call}: component= must be <type>/<name>, such as inputs/kafka_franz, or config for the root fields.` }
  }
  const resolved = resolveComponent(registry.data, parsed.type, parsed.name)
  if (!resolved.ok) {
    const hint = resolved.suggestions.length ? ` Did you mean: ${resolved.suggestions.join(', ')}?` : ''
    return { ok: false, kind: resolved.kind, field, registry, suggestions: resolved.suggestions, message: `${call}: ${resolved.message} in ${dataset}.${hint}` }
  }
  const segments = rawTarget.split('.').filter(Boolean)
  const walked = resolveFieldPath(resolved.fields, segments)
  if (!walked.ok) {
    const hint = walked.suggestions.length ? ` Did you mean: ${walked.suggestions.join(', ')}?` : ''
    const owner = resolved.key === CONFIG_COMPONENT ? 'the root config' : `${parsed.type}/${parsed.name}`
    return { ok: false, kind: 'unknown-field', field, registry, suggestions: walked.suggestions, message: `${call}: ${walked.message} in ${owner} (${dataset}).${hint}` }
  }
  const warnings = []
  if (cloud && resolved.key !== CONFIG_COMPONENT) {
    const availability = cloudAvailability({ registry, type: resolved.type, name: parsed.name, entry: resolved.entry, csvRows })
    if (availability.available === false) {
      return { ok: false, kind: 'unavailable', field, registry, message: `${call}: the ${resolved.type} '${parsed.name}' is not available in Cloud (${availability.source}), so no value is shown on this Cloud page.` }
    }
    if (availability.available === undefined) {
      warnings.push({ kind: 'cloud-unknown', message: `${call}: neither csvData nor ${dataset} says whether the ${resolved.type} '${parsed.name}' is available in Cloud, so the value renders unchecked.` })
    }
  }
  if (cloud && FIELDS[fieldName].cloudHidden) {
    return { ok: false, kind: 'cloud-hidden', field, registry, message: `${call}: the Connect reference does not state '${field}' for Cloud (it renders "Requires version" only outside env-cloud), so this Cloud page renders <unknown ${field}>. Put the sentence in an ifndef::env-cloud[] block.` }
  }
  const entryField = walked.field
  if (entryField.is_deprecated === true) {
    warnings.push({ kind: 'deprecated-field', message: `${call}: '${rawTarget}' is deprecated in ${dataset}; the Connect reference does not list deprecated fields.` })
  }
  const value = fieldValue(entryField, fieldName, { format })
  if (!value.ok) {
    const messages = {
      missing: fieldName === 'introduced'
        ? `'${rawTarget}' has no introduced version recorded in ${dataset}, so it renders <unknown ${field}>.`
        : `'${rawTarget}' has no ${field} in ${dataset}, so it renders <unknown ${field}>.`,
      complex: `the ${field} of '${rawTarget}' in ${dataset} is an object or list, which the reference prints as a YAML block, so it renders <unknown ${field}>. Link the reference instead.`,
      imprecise: `the ${field} of '${rawTarget}' in ${dataset} is an integer larger than JavaScript represents exactly, so it renders <unknown ${field}>. State the value in prose by hand.`,
      'description-default': `'${rawTarget}' has an empty default in ${dataset}, and its description states the real one, which the build does not parse, so it renders <unknown ${field}>. State the default in prose by hand.`,
    }
    const kind = value.reason === 'missing' ? 'missing-field' : value.reason === 'complex' ? 'complex-default' : value.reason
    return { ok: false, kind, field, registry, warnings, message: `${call}: ${messages[value.reason] || messages.missing}` }
  }
  return { ok: true, field: fieldName, registry, text: value.text, html: value.html, warnings, componentKey: resolved.key, componentType: resolved.type, fieldEntry: entryField, entry: resolved.entry }
}

const VALUE_ROLE = 'connect-value'
const UNKNOWN_VALUE_ROLE = 'connect-value-unknown'

/**
 * The HTML for one connectval: instance.
 */
function buildConnectvalContent ({ component, path, field, text, html, unknown = false }) {
  const attrs = `data-connect-component="${escapeHtml(component)}" data-connect-field="${escapeHtml(path)}" data-field="${escapeHtml(field)}"`
  if (unknown) return `<span class="${VALUE_ROLE} ${UNKNOWN_VALUE_ROLE}" ${attrs}>${escapeHtml(`<unknown ${field}>`)}</span>`
  return `<span class="${VALUE_ROLE}" ${attrs}>${html !== undefined ? html : escapeHtml(text)}</span>`
}

module.exports = {
  FIELDS,
  FIELD_ALIASES,
  FORMAT_HUMAN,
  FORMAT_RAW,
  CONFIG_COMPONENT,
  CONNECT_COMPONENT,
  CONNECT_KIND,
  CONNECT_JSON_RX,
  loadConnect,
  connectDatasets,
  normalizeField,
  componentTypes,
  resolveComponent,
  resolveFieldPath,
  stopReason,
  optionsOf,
  fieldValue,
  parseComponent,
  cloudAvailability,
  resolveConnectValue,
  buildConnectvalContent,
}
