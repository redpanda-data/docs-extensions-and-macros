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
const yaml = require('yaml')
const datasets = require('./attachment-datasets')
const { defineFields } = require('./value-fields')
const { FORMAT_ASCIIDOC, FORMAT_MARKDOWN } = require('./value-descriptions')
const { escapePlaceholderBraces } = require('../tools/redpanda-connect/helpers/renderConnectDescription')
const { annotateVerbatimLines } = require('../tools/redpanda-connect/metadata-utils')
const { normalizeType, isCloudAvailable } = require('../extensions/util/connect-catalog')
const { formatConnectDefault, connectDisplayType } = require('../tools/redpanda-connect/helpers/formatConnectDefault')
const logger = require('@antora/logger')('connectval-macro')

const FORMAT_HUMAN = 'human'
const FORMAT_RAW = 'raw'

// Every field connectval: supports, and whether it belongs to a config
// field (connectval:[inputs/kafka_franz.consumer_group,default]), a
// component (connectval:[inputs/kafka_franz,status]), or both. `cloudHidden`
// marks the fields the reference wraps in ifndef::env-cloud[] ("Requires
// version ... or later"). The `rich` fields are AsciiDoc, or Markdown when the
// data says docs_format: markdown (value-descriptions.js).
const FIELD_SET = defineFields('connectval:', {
  default: { levels: ['field'] },
  type: { levels: ['field'] },
  values: { levels: ['field'] },
  deprecated: { levels: ['field', 'component'] },
  introduced: { levels: ['field', 'component'], cloudHidden: true },
  description: { levels: ['field', 'component'], rich: true },
  summary: { levels: ['field', 'component'], rich: true },
  examples: { levels: ['field'], rich: true },
  advanced: { levels: ['field'] },
  required: { levels: ['field'] },
  secret: { levels: ['field'] },
  interpolated: { levels: ['field'] },
  status: { levels: ['component'] },
  category: { levels: ['component'] },
}, {
  is_interpolated: 'interpolated',
})
const { FIELDS, FIELD_ALIASES } = FIELD_SET

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
const normalizeField = FIELD_SET.normalizeField

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
 * The source format of the dataset's strings: docs_format, asciidoc when the
 * data predates the key.
 */
function docsFormat (data) {
  return data && data.docs_format === FORMAT_MARKDOWN ? FORMAT_MARKDOWN : FORMAT_ASCIIDOC
}

// A Connect string as a rich value. AsciiDoc gets the escaping the generated
// reference applies, so {placeholder} text is not read as an attribute.
function richString (text, format) {
  const value = String(text).trim()
  const source = format === FORMAT_ASCIIDOC ? escapePlaceholderBraces(value) : value
  return { ok: true, text: value, rich: { kind: 'text', text: source, format } }
}

const yesNo = (value, format) => ({ ok: true, text: format === FORMAT_RAW ? String(value) : (value ? 'yes' : 'no') })

// Field types that hold a component (input, processor, ...): the config
// linter never reports those as missing.
const CORE_TYPES = new Set(['input', 'buffer', 'cache', 'processor', 'rate_limit', 'output', 'metrics', 'tracer', 'scanner'])

/**
 * Whether a field must be set, by the rule Connect's config linter applies
 * (benthos internal/docs/format_yaml.go, "field %v is required"): not
 * optional, not deprecated, no default, a scalar with no child fields, and
 * not a component.
 */
function isRequired (field) {
  return field.is_optional !== true && field.is_deprecated !== true && field.default === undefined &&
    field.kind === 'scalar' && !(Array.isArray(field.children) && field.children.length) && !CORE_TYPES.has(field.type)
}

/**
 * A field's examples. Inline, each scalar example renders as code; the block
 * form is a YAML listing with one example per document.
 */
function examplesValue (field) {
  const list = Array.isArray(field.examples) ? field.examples : []
  if (!list.length) return { ok: false, reason: 'missing' }
  const scalar = list.every((e) => e === null || ['number', 'boolean'].includes(typeof e) || (typeof e === 'string' && !e.includes('\n')))
  const blockText = ['[source,yaml]', '----', list.map((e) => yaml.stringify({ [field.name]: e }, { lineWidth: 0 }).trim()).join('\n\n# ---\n\n'), '----'].join('\n')
  // An example that is an object or a multi-line string has no inline form.
  const items = scalar ? list.map((e) => `\`+${String(e)}+\``) : [blockText]
  return { ok: true, text: list.map(String).join(', '), rich: { kind: 'list', items, format: FORMAT_ASCIIDOC, blockText } }
}

/**
 * The value of one field of one Connect config field.
 *
 * @param {object} [opts]
 * @param {string} [opts.docsFormat] - The dataset's docs_format.
 * @returns {{ok: true, text: string, html?: string, rich?: object} | {ok: false, reason: string}}
 */
function fieldValue (field, name, { format = FORMAT_HUMAN, docsFormat: stringFormat = FORMAT_ASCIIDOC } = {}) {
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
    case 'values': {
      const list = optionsOf(field)
      if (!list) return { ok: false, reason: 'missing' }
      if (raw) return { ok: true, text: JSON.stringify(list) }
      return { ok: true, text: list.join(', '), html: list.map((v) => `<code>${escapeHtml(v)}</code>`).join(', ') }
    }
    case 'deprecated':
      return yesNo(field.is_deprecated === true, format)
    case 'introduced':
      return typeof field.version === 'string' && field.version ? { ok: true, text: field.version } : { ok: false, reason: 'missing' }
    case 'description':
      return typeof field.description === 'string' && field.description.trim() ? richString(field.description, stringFormat) : { ok: false, reason: 'missing' }
    case 'summary':
      return typeof field.short_description === 'string' && field.short_description.trim() ? richString(field.short_description, stringFormat) : { ok: false, reason: 'missing' }
    case 'examples':
      return examplesValue(field)
    case 'advanced':
      return yesNo(field.is_advanced === true, format)
    case 'required':
      return yesNo(isRequired(field), format)
    case 'secret':
      return yesNo(field.is_secret === true, format)
    case 'interpolated':
      return yesNo(field.interpolated === true, format)
    default:
      return { ok: false, reason: 'unsupported' }
  }
}

/**
 * The value of one field of a component itself.
 *
 * @returns {{ok: true, text: string, rich?: object} | {ok: false, reason: string}}
 */
function componentFieldValue (entry, name, { format = FORMAT_HUMAN, docsFormat: stringFormat = FORMAT_ASCIIDOC } = {}) {
  if (!entry) return { ok: false, reason: 'missing' }
  switch (normalizeField(name)) {
    case 'status':
      return typeof entry.status === 'string' && entry.status ? { ok: true, text: entry.status } : { ok: false, reason: 'missing' }
    case 'deprecated':
      return yesNo(entry.status === 'deprecated', format)
    case 'introduced':
      return typeof entry.version === 'string' && entry.version ? { ok: true, text: entry.version } : { ok: false, reason: 'missing' }
    case 'category':
      return Array.isArray(entry.categories) && entry.categories.length
        ? { ok: true, text: format === FORMAT_RAW ? JSON.stringify(entry.categories) : entry.categories.join(', ') }
        : { ok: false, reason: 'missing' }
    case 'description':
      return typeof entry.description === 'string' && entry.description.trim() ? richString(entry.description, stringFormat) : { ok: false, reason: 'missing' }
    case 'summary':
      return typeof entry.summary === 'string' && entry.summary.trim() ? richString(entry.summary, stringFormat) : { ok: false, reason: 'missing' }
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
 * Split the bracket form's first attribute into component= and the field
 * path: inputs/kafka_franz.consumer_group, inputs/kafka_franz (the component
 * itself), or config.pipeline.threads (a root field). Component names have
 * no dots, so the first dot after the type ends the name.
 *
 * @returns {{component: string, path: string}}
 */
function parseFieldTarget (text) {
  const value = String(text == null ? '' : text).trim()
  if (value === CONFIG_COMPONENT || value.startsWith(`${CONFIG_COMPONENT}.`)) {
    return { component: CONFIG_COMPONENT, path: value.slice(CONFIG_COMPONENT.length + 1) }
  }
  const slash = value.indexOf('/')
  const dot = slash === -1 ? -1 : value.indexOf('.', slash)
  return dot === -1 ? { component: value, path: '' } : { component: value.slice(0, dot), path: value.slice(dot + 1) }
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
 * @param {string} opts.path - The field path; empty for a field of the
 *   component itself (status, summary, ...).
 * @param {string} [opts.field]
 * @param {string} [opts.format]
 * @param {boolean} [opts.cloud] - Whether the page renders for Cloud.
 * @param {object[]} [opts.csvRows] - Translated csvData rows, when the build has them.
 * @param {string} [opts.filePath]
 * @param {string} [opts.macro] - The call as written, for messages, when it
 *   is the bracket form connectval:[inputs/kafka_franz.consumer_group].
 * @returns {{ok: true, text: string, html?: string, rich?: object, field: string, invert: boolean, registry: object, warnings: object[], home?: string} |
 *   {ok: false, kind: string, message: string, field: string, registry?: object, suggestions?: string[], warnings?: object[]}}
 *   warnings are warn-only notices for a value that still renders
 *   (deprecated-field, cloud-unknown). home is the component's page in
 *   connect:components (inputs/kafka_franz.adoc), where its strings were
 *   written to render.
 */
function resolveConnectValue ({ registry, component, path: target, field: requested = 'default', format = FORMAT_HUMAN, cloud = false, csvRows, filePath, macro }) {
  const resolvedField = FIELD_SET.resolveField(requested)
  const fieldName = resolvedField && resolvedField.name
  const invert = Boolean(resolvedField && resolvedField.invert)
  const rawTarget = String(target == null ? '' : target).trim()
  const componentAttr = component !== undefined && component !== null && String(component).trim() !== '' ? `,component=${String(component).trim()}` : ''
  const call = `${macro || `connectval:${rawTarget}[${requested}${componentAttr}]`}${filePath ? ` in ${filePath}` : ''}`
  const field = fieldName || requested
  const level = rawTarget ? 'field' : 'component'
  if (!fieldName) {
    return { ok: false, kind: 'unsupported-field', field, message: FIELD_SET.unsupportedMessage(call, requested) }
  }
  if (!FIELDS[fieldName].levels.includes(level)) {
    const hint = level === 'component'
      ? ` Name a field after the component, as in connectval:[inputs/kafka_franz.consumer_group,${fieldName}].`
      : ` Name the component alone, as in connectval:[inputs/kafka_franz,${fieldName}].`
    return { ok: false, kind: 'unsupported-field', field, message: `${call}: ${fieldName} is a field of a ${level === 'component' ? 'config field' : 'component'}, not of a ${level === 'component' ? 'component' : 'config field'}.${hint}` }
  }
  if (!registry) {
    return { ok: false, kind: 'no-data', field, message: `${call}: this page has no Connect data to read '${field}' from (see the connectval macro warning), so it renders <unknown ${field}>.` }
  }
  const dataset = datasets.describeDataset(registry)
  const parsed = parseComponent(component)
  if (!parsed) {
    return { ok: false, kind: 'unknown-component', field, registry, message: `${call}: ${macro ? 'the brackets must start with <type>/<name>, such as inputs/kafka_franz.consumer_group, or config for the root fields' : 'component= must be <type>/<name>, such as inputs/kafka_franz, or config for the root fields'}.` }
  }
  const resolved = resolveComponent(registry.data, parsed.type, parsed.name)
  if (!resolved.ok) {
    const hint = resolved.suggestions.length ? ` Did you mean: ${resolved.suggestions.join(', ')}?` : ''
    return { ok: false, kind: resolved.kind, field, registry, suggestions: resolved.suggestions, message: `${call}: ${resolved.message} in ${dataset}.${hint}` }
  }
  const owner = resolved.key === CONFIG_COMPONENT ? 'the root config' : `${parsed.type}/${parsed.name}`
  let entryField
  if (level === 'field') {
    const segments = rawTarget.split('.').filter(Boolean)
    const walked = resolveFieldPath(resolved.fields, segments)
    if (!walked.ok) {
      const hint = walked.suggestions.length ? ` Did you mean: ${walked.suggestions.join(', ')}?` : ''
      return { ok: false, kind: 'unknown-field', field, registry, suggestions: walked.suggestions, message: `${call}: ${walked.message} in ${owner} (${dataset}).${hint}` }
    }
    entryField = walked.field
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
  if (entryField && entryField.is_deprecated === true) {
    warnings.push({ kind: 'deprecated-field', message: `${call}: '${rawTarget}' is deprecated in ${dataset}; the Connect reference does not list deprecated fields.` })
  }
  const options = { format, docsFormat: docsFormat(registry.data) }
  const value = level === 'field' ? fieldValue(entryField, fieldName, options) : componentFieldValue(resolved.entry, fieldName, options)
  const subject = level === 'field' ? `'${rawTarget}'` : resolved.key === CONFIG_COMPONENT ? 'the root config' : `the ${resolved.type} '${parsed.name}'`
  if (!value.ok) {
    const messages = {
      missing: fieldName === 'introduced'
        ? `${subject} has no introduced version recorded in ${dataset}, so it renders <unknown ${field}>.`
        : `${subject} has no ${field} in ${dataset}, so it renders <unknown ${field}>.`,
      complex: `the ${field} of ${subject} in ${dataset} is an object or list, which the reference prints as a YAML block, so it renders <unknown ${field}>. Link the reference instead.`,
      imprecise: `the ${field} of ${subject} in ${dataset} is an integer larger than JavaScript represents exactly, so it renders <unknown ${field}>. State the value in prose by hand.`,
      'description-default': `${subject} has an empty default in ${dataset}, and its description states the real one, which the build does not parse, so it renders <unknown ${field}>. State the default in prose by hand.`,
    }
    const kind = value.reason === 'missing' ? 'missing-field' : value.reason === 'complex' ? 'complex-default' : value.reason
    return { ok: false, kind, field, registry, warnings, message: `${call}: ${messages[value.reason] || messages.missing}` }
  }
  const text = invert ? ({ yes: 'no', no: 'yes', true: 'false', false: 'true' })[value.text] || value.text : value.text
  const home = resolved.key === CONFIG_COMPONENT ? undefined : `${resolved.key.replace(/-/g, '_')}/${parsed.name}.adoc`
  return { ok: true, field: fieldName, invert, registry, text, html: value.html, rich: value.rich, warnings, home, call, componentKey: resolved.key, componentType: resolved.type, fieldEntry: entryField, entry: resolved.entry }
}

/**
 * Rewrite the links in a Connect string for the page it renders on. The
 * strings are written for the component's own page in connect:components:
 * <<id>> is an anchor on that page, and an xref with no component
 * (xref:components:inputs/broker.adoc, xref:guides:bloblang/about.adoc, or a
 * bare page) is relative to the connect component. On any other page those
 * links break, so:
 *
 *   on the component's own page   nothing changes.
 *   elsewhere in connect          <<id>> links the component page's anchor,
 *                                 and a bare page gets its components module.
 *   on a Cloud page               the links stay relative to the page's own
 *                                 component, where Cloud's stubs alias the
 *                                 connect paths (components:inputs/x.adoc).
 *   on any other page             the links are qualified with connect:.
 *
 * When the build can resolve pages, a target that does not exist for the
 * rendering page renders as its label, unlinked, and is returned in
 * unlinked: a Cloud reader is never sent to the self-managed docs.
 *
 * The Bloblang strings are written the same way for the functions or methods
 * page, so they pass that page as home and guides as homeModule.
 *
 * @param {string} text - AsciiDoc.
 * @param {object} opts
 * @param {string} [opts.home] - The component's page, inputs/kafka_franz.adoc.
 * @param {string} [opts.homeModule] - The module of home and of a bare page.
 * @param {object} [opts.src] - The rendering page's src (component, version, module, relative).
 * @param {boolean} [opts.cloud]
 * @param {object} [opts.contentCatalog]
 * @returns {{text: string, unlinked: string[]}}
 */
function relocateConnectRefs (text, { home, homeModule = 'components', src = {}, cloud = false, contentCatalog } = {}) {
  const onConnect = src.component === CONNECT_COMPONENT
  const onHome = onConnect && src.module === homeModule && Boolean(home) && src.relative === home
  const canResolve = Boolean(contentCatalog) && typeof contentCatalog.resolvePage === 'function'
  const context = { component: src.component, version: src.version, module: src.module }
  const unlinked = []
  const link = (spec, fragment, label) => {
    const target = onConnect || cloud ? spec : `${CONNECT_COMPONENT}:${spec}`
    if (canResolve && !contentCatalog.resolvePage(target, context)) {
      unlinked.push(`${CONNECT_COMPONENT}:${spec}`)
      return label || `\`${spec.replace(/^.*[/:]/, '').replace(/\.adoc$/, '')}\``
    }
    return `xref:${target}${fragment ? `#${fragment}` : ''}[${label}]`
  }
  const lines = annotateVerbatimLines(text).map(({ line, verbatim }) => {
    if (verbatim) return line
    return line
      .replace(/<<([^,>\s]+)(?:,\s*([^>]*?))?>>/g, (match, id, label) => {
        if (onHome || !home) return match
        return link(`${homeModule}:${home}`, id, label != null && label !== '' ? label : `\`${id}\``)
      })
      .replace(/xref:([^[\s]+)\[([^\]]*)\]/g, (match, target, label) => {
        const [resource, fragment] = target.split('#')
        // A version or a component already says where it points.
        if (resource.includes('@') || resource.split(':').length > 2) return match
        if (onConnect && (resource.includes(':') || src.module === homeModule)) return match
        return link(resource.includes(':') ? resource : `${homeModule}:${resource}`, fragment, label)
      })
  })
  return { text: lines.join('\n'), unlinked }
}

const VALUE_ROLE = 'connect-value'
const UNKNOWN_VALUE_ROLE = 'connect-value-unknown'

/**
 * The HTML for one connectval: instance.
 */
function buildConnectvalContent ({ component, path, field, text, html, unknown = false }) {
  const pathAttr = path ? ` data-connect-field="${escapeHtml(path)}"` : ''
  const attrs = `data-connect-component="${escapeHtml(component)}"${pathAttr} data-field="${escapeHtml(field)}"`
  if (unknown) return `<span class="${VALUE_ROLE} ${UNKNOWN_VALUE_ROLE}" ${attrs}>${escapeHtml(`<unknown ${field}>`)}</span>`
  return `<span class="${VALUE_ROLE}" ${attrs}>${html !== undefined ? html : escapeHtml(text)}</span>`
}

module.exports = {
  FIELD_SET,
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
  componentFieldValue,
  isRequired,
  docsFormat,
  parseComponent,
  parseFieldTarget,
  cloudAvailability,
  resolveConnectValue,
  relocateConnectRefs,
  buildConnectvalContent,
}
