'use strict'

/* Flags of the Redpanda Operator's `run` command, read from a published
 * operator-flags-<version>.json instead of typed by hand.
 *
 * Shared by the opflag: and opflagval: inline macros (macros/opflag.js) and
 * the check-reference-values report, so prose and the check agree. The data
 * is written by `doc-tools generate operator-flags`, which builds the
 * operator's own `run` command at a release tag and walks every flag it
 * registers, deprecated and hidden ones included, so a default is exactly
 * what that release ships. The docs repo publishes it as
 * modules/reference/attachments/operator-flags-<version>.json:
 *
 *   {schema: 1, operator_version, generated_at, source: {ref},
 *    command: 'run',
 *    flags: [{name, type, default, usage, deprecated?, hidden?}],
 *    global_flags: [...]}
 *
 * Defaults are pflag's DefValue strings, exactly as --help prints them
 * (30m0s, [], ""), never humanized. A page in streaming 26.2 reads the file
 * for operator v26.2.x. Cloud and Agentic Data Plane pages never borrow it:
 * nobody runs the operator there.
 */

const { escapeHtml } = require('./html-utils')
const { formatInlineCode } = require('./inline-code')
const datasets = require('./attachment-datasets')
const { defineFields } = require('./value-fields')
const { FORMAT_ASCIIDOC } = require('./value-descriptions')
const logger = require('@antora/logger')('opflag-macro')

const FORMAT_HUMAN = 'human'
const FORMAT_RAW = 'raw'

// The generated reference page every flag has an anchor on.
const PAGE_MODULE = 'reference'
const PAGE_RELATIVE = 'k-operator-flags.adoc'

const FIELD_SET = defineFields('opflagval:', {
  default: {},
  type: {},
  description: { rich: true },
  deprecated: {},
})
const { FIELDS, FIELD_ALIASES } = FIELD_SET

const $operatorRegistry = Symbol('$operatorFlagsRegistry')
const $operatorSeriesGap = Symbol('$operatorFlagsSeriesGap')

const OPERATOR_FLAGS_JSON_RX = /^operator-flags-(v\d+\.\d+\.\d+(?:-(?:rc|beta)\.?\d+)?)\.json$/

const isFlagList = (list) => Array.isArray(list) && list.every((flag) => flag && typeof flag.name === 'string')

const OPERATOR_FLAGS_KIND = {
  name: 'operator-flags',
  module: PAGE_MODULE,
  rx: OPERATOR_FLAGS_JSON_RX,
  filePrefix: 'operator-flags-',
  label: 'operator flag data',
  regenerate: 'doc-tools generate operator-flags --tag operator/v<version>',
  borrowWhen: [],
  lenders: [],
  cacheSymbol: $operatorRegistry,
  gapSymbol: $operatorSeriesGap,
  keyPrefix: 'opflag:',
  invalidKey: 'invalid',
  validate: (data) => {
    if (data.schema !== 1) {
      return typeof data.schema === 'number' && data.schema > 1
        ? `has schema ${data.schema}, a newer schema than this DEM understands`
        : `has an unrecognized schema (${JSON.stringify(data.schema)})`
    }
    if (!isFlagList(data.flags)) return 'has no flags array'
    if (data.global_flags !== undefined && !isFlagList(data.global_flags)) return 'has a global_flags value that is not a flag array'
    return true
  },
  notObjectReason: 'is not a JSON object',
  logger,
  text: {
    log: 'opflag macro',
    macro: 'opflag:',
    attachment: 'operator flag attachment',
    releaseNoun: 'flags',
    effect: (where) => `opflag: and opflagval: calls${where} therefore render as plain code and placeholders`,
    generateSeries: (series) => `doc-tools generate operator-flags --tag operator/v${series}.<patch>`,
    noData: (component, version) =>
      `opflag macro: no operator-flags-<version>.json attachment found in the reference module of ${component || 'unknown component'}@${version || 'unversioned'}; ` +
      'opflag: renders plain code and opflagval: renders placeholders. Run doc-tools generate operator-flags --tag operator/v<version> in the docs repo.',
  },
}

function loadOperatorFlagsFor (contentCatalog, component, version) {
  return datasets.loadDatasetFor(contentCatalog, component, version, OPERATOR_FLAGS_KIND)
}

const normalizeField = FIELD_SET.normalizeField

/**
 * A flag as written in prose: `--name`, `--name=value` or `--name value`.
 * The leading dashes are optional, so opflag:[unbind-pvcs-after] and
 * opflag:[unbind-pvcs-after=60s] still read.
 */
function parseFlagText (text) {
  const raw = String(text == null ? '' : text).trim()
  const match = raw.match(/^(-{0,2})([A-Za-z0-9][A-Za-z0-9-]*)(?:([=\s])(.*))?$/)
  if (!match) return { ok: false, raw }
  return { ok: true, raw, name: match[2], value: match[4] !== undefined ? match[4].trim() : undefined, separator: match[3] }
}

/**
 * The flag record and where it lives (the run command or the global flags).
 */
function findFlag (registry, name) {
  const data = registry && registry.data
  if (!data) return undefined
  const local = data.flags.find((flag) => flag.name === name)
  if (local) return { flag: local, global: false }
  const global = (data.global_flags || []).find((flag) => flag.name === name)
  return global ? { flag: global, global: true } : undefined
}

function allFlagNames (registry) {
  const data = registry && registry.data
  if (!data) return []
  return [...data.flags, ...(data.global_flags || [])].map((flag) => flag.name)
}

function describeDataset (registry) {
  return datasets.describeDataset(registry)
}

/**
 * Whether the reference page has an entry for a flag: every flag except one
 * that is only hidden (MarkHidden, never deprecated). Deprecated flags, run
 * and global alike, are listed in the Deprecated flags section. The page
 * renderer and opflag: both use this, so a link always has an anchor.
 */
const isOnPage = (flag) => Boolean(flag) && (!flag.hidden || Boolean(flag.deprecated))

/**
 * The anchor of a flag on the reference page. Flag names are already
 * lowercase and hyphenated, which AsciiDoc accepts as an id.
 */
const flagAnchor = (name) => String(name)

/**
 * The text of a default, as pflag stores it. An empty string reads as "".
 */
function formatDefault (flag) {
  if (!flag || typeof flag.default !== 'string') return { ok: false, reason: 'missing' }
  return { ok: true, text: flag.default === '' ? '""' : flag.default }
}

/**
 * Look up one flag, for both macros and the checker.
 *
 * @returns {{ok: true, flag, global, registry} |
 *           {ok: false, kind: 'no-data'|'bad-flag'|'unknown-flag', message}}
 */
function resolveFlag ({ registry, text, call }) {
  const parsed = parseFlagText(text)
  if (!parsed.ok || !parsed.name) {
    return { ok: false, kind: 'bad-flag', message: `${call}: '${parsed.raw}' is not a flag; write the long flag, as in opflag:[--unbind-pvcs-after].` }
  }
  if (!registry) {
    return { ok: false, kind: 'no-data', parsed, message: `${call}: no operator flag data for this page, so --${parsed.name} cannot be checked.` }
  }
  const found = findFlag(registry, parsed.name)
  if (!found) {
    const near = datasets.suggest(parsed.name, allFlagNames(registry))
    const hint = near.length ? ` Did you mean ${near.map((name) => `--${name}`).join(', ')}?` : ''
    return { ok: false, kind: 'unknown-flag', parsed, message: `${call}: --${parsed.name} is not a flag of redpanda-operator run in ${describeDataset(registry)}.${hint}` }
  }
  return { ok: true, parsed, registry, ...found }
}

/**
 * Why a flag is risky to mention, or undefined: deprecated flags carry their
 * deprecation message, hidden ones are undocumented on purpose.
 */
function cautionOf (flag) {
  if (flag.deprecated) return { kind: 'deprecated-flag', text: `--${flag.name} is deprecated: ${flag.deprecated}` }
  if (flag.hidden) return { kind: 'hidden-flag', text: `--${flag.name} is hidden from redpanda-operator run --help` }
  return undefined
}

/**
 * One field of a flag.
 *
 * @returns {{ok: true, text?, rich?, field} | {ok: false, kind, field, message}}
 */
function fieldValue (flag, requested, { format = FORMAT_HUMAN, call } = {}) {
  const resolved = FIELD_SET.resolveField(requested)
  if (!resolved) return { ok: false, kind: 'unsupported-field', field: requested, message: FIELD_SET.unsupportedMessage(call, requested) }
  const field = resolved.name
  if (field === 'default') {
    const value = formatDefault(flag)
    return value.ok ? { ok: true, field, text: value.text } : { ok: false, kind: 'missing-field', field, message: `${call}: --${flag.name} records no default.` }
  }
  if (field === 'type') return { ok: true, field, text: String(flag.type) }
  if (field === 'deprecated') {
    const value = Boolean(flag.deprecated)
    return { ok: true, field, text: format === FORMAT_RAW ? String(value) : (value ? 'yes' : 'no') }
  }
  // description
  const text = String(flag.usage || '').trim()
  if (!text) return { ok: false, kind: 'missing-field', field, message: `${call}: --${flag.name} has no help text.` }
  // Formatted as the reference page formats it. Usage strings carry no
  // backticks (pflag reads the first span as the --help value placeholder),
  // so code values are put in inline code here.
  return { ok: true, field, rich: { format: FORMAT_ASCIIDOC, text: formatInlineCode(text) } }
}

/**
 * The reference page that documents the flags, for the page's own
 * component version only: a 26.2 page never links the 26.3 flag list.
 */
function pickFlagPage (contentCatalog, { component, version }) {
  if (!contentCatalog || typeof contentCatalog.getById !== 'function') return undefined
  const file = contentCatalog.getById({ component, version, module: PAGE_MODULE, family: 'page', relative: PAGE_RELATIVE })
  if (!file) return undefined
  return { file, id: `${version ? `${version}@` : ''}${component}:${PAGE_MODULE}:${PAGE_RELATIVE}` }
}

const LINK_ROLE = 'operator-flag'
const VALUE_ROLE = 'operator-flag-value'
const UNKNOWN_VALUE_ROLE = 'operator-flag-value-unknown'

function buildFlagContent ({ display, name, plain = false }) {
  if (plain) return `<code>${escapeHtml(display)}</code>`
  return `<code class="${LINK_ROLE}" data-operator-flag="${escapeHtml(name)}">${escapeHtml(display)}</code>`
}

function buildValueContent ({ name, field, text, html, unknown = false }) {
  const attrs = `data-operator-flag="${escapeHtml(name)}" data-field="${escapeHtml(field)}"`
  if (unknown) return `<span class="${VALUE_ROLE} ${UNKNOWN_VALUE_ROLE}" ${attrs}>${escapeHtml(`<unknown ${field}>`)}</span>`
  return `<span class="${VALUE_ROLE}" ${attrs}>${html !== undefined ? html : `<code>${escapeHtml(text)}</code>`}</span>`
}

module.exports = {
  FIELD_SET,
  FIELDS,
  FIELD_ALIASES,
  FORMAT_HUMAN,
  FORMAT_RAW,
  PAGE_MODULE,
  PAGE_RELATIVE,
  OPERATOR_FLAGS_KIND,
  OPERATOR_FLAGS_JSON_RX,
  loadOperatorFlagsFor,
  normalizeField,
  parseFlagText,
  findFlag,
  allFlagNames,
  describeDataset,
  flagAnchor,
  formatDefault,
  isOnPage,
  resolveFlag,
  cautionOf,
  fieldValue,
  pickFlagPage,
  buildFlagContent,
  buildValueContent,
}
