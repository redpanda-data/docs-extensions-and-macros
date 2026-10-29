'use strict'

/* Bloblang functions and methods from the published Connect data: the
 * bloblang-functions and bloblang-methods lists of connect-<version>.json,
 * the file connectval: reads. Shared by the blobl: link macro, the bloblval:
 * value macro and check-reference-values.
 *
 * A call is written as Bloblang calls it: a function as now() or
 * counter(min), a method with its leading dot, as .uppercase() or
 * .replace_all(old). A name inside the parentheses is a named parameter. A
 * bare name (now) works when only one kind has it; bytes is both a function
 * and a method, so it needs the parentheses or the dot.
 *
 * Three methods (contains, length and slice) are in two categories, each with
 * its own description and examples, and the methods page lists each copy
 * under its category. category= picks one; without it, the first copy on the
 * page.
 */

const { escapeHtml } = require('./html-utils')
const datasets = require('./attachment-datasets')
const { defineFields } = require('./value-fields')
const { FORMAT_ASCIIDOC, FORMAT_MARKDOWN, markdownToAsciidoc } = require('./value-descriptions')
const connectValues = require('./connect-values')

const FUNCTION = 'function'
const METHOD = 'method'
const PARAMETER = 'parameter'
const LISTS = { [FUNCTION]: 'bloblang-functions', [METHOD]: 'bloblang-methods' }

// Every field bloblval: supports, and whether it belongs to a function or
// method (bloblval:[now(),status]) or to one of its parameters
// (bloblval:[counter(min),default]). `cloudHidden` marks what the reference
// wraps in ifndef::env-cloud[] ("Introduced in version ...").
const FIELD_SET = defineFields('bloblval:', {
  default: { levels: [PARAMETER] },
  type: { levels: [PARAMETER] },
  description: { levels: [FUNCTION, METHOD, PARAMETER], rich: true },
  required: { levels: [PARAMETER] },
  examples: { levels: [FUNCTION, METHOD], rich: true },
  introduced: { levels: [FUNCTION, METHOD], cloudHidden: true },
  deprecated: { levels: [FUNCTION, METHOD] },
  status: { levels: [FUNCTION, METHOD] },
  category: { levels: [FUNCTION, METHOD] },
  impure: { levels: [FUNCTION, METHOD] },
}, {
  is_impure: 'impure',
})
const { FIELDS } = FIELD_SET

const FORMAT_HUMAN = connectValues.FORMAT_HUMAN
const FORMAT_RAW = connectValues.FORMAT_RAW

// The methods page groups methods under category headings: General first,
// Deprecated last, the others in alphabetical order. That is the order of
// the published bloblang/methods.adoc partial, which a build reads instead
// when it has it (methodCategoryOrder).
const FIRST_CATEGORY = 'general'
const LAST_CATEGORY = 'deprecated'

const own = (object, key) => Boolean(object) && Object.prototype.hasOwnProperty.call(object, key)
const list = (data, kind) => (data && Array.isArray(data[LISTS[kind]]) ? data[LISTS[kind]] : undefined)
const categoryKey = (name) => String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * Parse a call as written: .uppercase(), counter(min), now.
 *
 * @returns {{ok: true, kind?: string, name: string, param?: string, parens: boolean, typed: string} | {ok: false}}
 */
function parseCall (text) {
  const typed = String(text == null ? '' : text).trim()
  const m = typed.match(/^(\.)?([A-Za-z_]\w*)\s*(\(\s*([A-Za-z_]\w*)?\s*\))?$/)
  if (!m) return { ok: false, typed }
  const kind = m[1] ? METHOD : m[3] ? FUNCTION : undefined
  return { ok: true, kind, name: m[2], param: m[4], parens: Boolean(m[3]), typed }
}

/**
 * How a function or method is written, with its parentheses: now(), .uppercase().
 */
const callText = (kind, name, param) => `${kind === METHOD ? '.' : ''}${name}(${param || ''})`

/**
 * The categories of an entry, as the reference names them.
 */
function categoriesOf (kind, entry) {
  if (kind === METHOD) return (Array.isArray(entry.categories) ? entry.categories : []).map((c) => c && c.Category).filter(Boolean)
  return typeof entry.category === 'string' && entry.category ? [entry.category] : []
}

/**
 * The order of the category headings on the methods page, as category keys:
 * from the published partial's == headings when the build has it, otherwise
 * General first, Deprecated last and the rest alphabetical.
 */
function methodCategoryOrder (data, partialText) {
  if (partialText) {
    const headings = String(partialText).split('\n').map((l) => l.match(/^==\s+(\S.*?)\s*$/)).filter(Boolean).map((m) => categoryKey(m[1]))
    if (headings.length) return headings
  }
  const names = new Set()
  for (const entry of list(data, METHOD) || []) for (const c of categoriesOf(METHOD, entry)) names.add(categoryKey(c))
  const rank = (key) => (key === FIRST_CATEGORY ? 0 : key === LAST_CATEGORY ? 2 : 1)
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/**
 * The copy of a method a call means: the category named, or the first copy
 * on the page. index is the copy's position on the page (0 for the first),
 * which numbers its anchor.
 *
 * @returns {{ok: true, category?: object, index: number} | {ok: false, message: string}}
 */
function pickCategory (kind, entry, requested, order) {
  if (kind !== METHOD) {
    if (requested === undefined) return { ok: true, index: 0 }
    const cats = categoriesOf(kind, entry)
    return cats.some((c) => categoryKey(c) === categoryKey(requested))
      ? { ok: true, index: 0 }
      : { ok: false, message: `'${entry.name}' is in ${cats.length ? `the category ${cats[0]}` : 'no category'}, not '${requested}'` }
  }
  const copies = (Array.isArray(entry.categories) ? entry.categories : [])
    .filter((c) => c && c.Category)
    .map((c) => ({ c, at: order.indexOf(categoryKey(c.Category)) }))
    .sort((a, b) => (a.at === -1 ? Infinity : a.at) - (b.at === -1 ? Infinity : b.at))
  if (!copies.length) return { ok: true, index: 0 }
  if (requested === undefined) return { ok: true, category: copies[0].c, index: 0 }
  const index = copies.findIndex((x) => categoryKey(x.c.Category) === categoryKey(requested))
  if (index === -1) return { ok: false, message: `'${entry.name}' is not in the category '${requested}'; it is in ${copies.map((x) => x.c.Category).join(' and ')}` }
  return { ok: true, category: copies[index].c, index }
}

/**
 * Resolve a parsed call to its function or method, and parameter.
 *
 * @returns {{ok: true, kind: string, entry: object, param?: object} |
 *   {ok: false, kind: string, message: string, suggestions: string[]}}
 *   kind on failure: no-bloblang, unknown-function, unknown-method,
 *   ambiguous-name, hidden or unknown-parameter.
 */
function resolveCall (data, parsed) {
  const functions = list(data, FUNCTION)
  const methods = list(data, METHOD)
  if (!functions && !methods) return { ok: false, kind: 'no-bloblang', suggestions: [], message: 'has no Bloblang functions or methods' }
  const find = (kind) => ((kind === FUNCTION ? functions : methods) || []).find((e) => e && e.name === parsed.name)
  let kind = parsed.kind
  if (!kind) {
    const both = [FUNCTION, METHOD].filter((k) => find(k))
    if (both.length > 1) return { ok: false, kind: 'ambiguous-name', suggestions: [], message: `'${parsed.name}' is both a function and a method; write ${parsed.name}() for the function or .${parsed.name}() for the method` }
    kind = both[0] || FUNCTION
  }
  const entry = find(kind)
  if (!entry) {
    const other = kind === FUNCTION ? METHOD : FUNCTION
    if (find(other)) {
      return { ok: false, kind: `unknown-${kind}`, suggestions: [], message: `'${parsed.name}' is not a Bloblang ${kind} but a ${other}; write ${callText(other, parsed.name, parsed.param)}` }
    }
    const names = ((kind === FUNCTION ? functions : methods) || []).filter((e) => e && e.status !== 'hidden').map((e) => e.name)
    const suggestions = datasets.suggest(parsed.name, names)
    return { ok: false, kind: `unknown-${kind}`, suggestions, message: `'${parsed.name}' is not a Bloblang ${kind}` }
  }
  if (entry.status === 'hidden') {
    return { ok: false, kind: 'hidden', suggestions: [], message: `the ${kind} '${parsed.name}' is hidden: the Bloblang reference does not document it` }
  }
  if (parsed.param === undefined) return { ok: true, kind, entry }
  const params = entry.params || {}
  const named = Array.isArray(params.named) ? params.named : []
  const param = named.find((p) => p && p.name === parsed.param)
  if (!param) {
    const what = callText(kind, parsed.name)
    const why = params.variadic
      ? `${what} takes any number of unnamed arguments, so it has no parameter '${parsed.param}'`
      : named.length ? `'${parsed.param}' is not a parameter of ${what}` : `${what} has no parameters`
    return { ok: false, kind: 'unknown-parameter', suggestions: datasets.suggest(parsed.param, named.map((p) => p.name)), message: why }
  }
  return { ok: true, kind, entry, param }
}

const yesNo = (value, format) => ({ ok: true, text: format === FORMAT_RAW ? String(value) : (value ? 'yes' : 'no') })

// A Bloblang string as a rich value, in the data's docs_format.
function richString (text, format) {
  const value = String(text).trim()
  return { ok: true, text: value, rich: { kind: 'text', text: value, format } }
}

/**
 * The examples as the reference prints them: each summary, then the mapping
 * and its inputs and outputs in a bloblang listing.
 */
function examplesText (examples, format) {
  return examples.map((e) => {
    const summary = String(e.summary || '').trim()
    const lead = summary ? `${format === FORMAT_MARKDOWN ? markdownToAsciidoc(summary) : summary}`.replace(/\.$/, ':') : ''
    const results = (Array.isArray(e.results) ? e.results : []).map((r) => `# In:  ${r[0]}\n# Out: ${r[1]}`)
    const body = [String(e.mapping || '').replace(/\s+$/, ''), ...results].join('\n\n')
    return [...(lead ? [lead, ''] : []), '[,bloblang]', '----', body, '----'].join('\n')
  }).join('\n\n')
}

/**
 * The value of one field of a function or method.
 *
 * @param {object} [opts]
 * @param {object} [opts.category] - The method's category copy (pickCategory).
 */
function entryValue (kind, entry, name, { format = FORMAT_HUMAN, docsFormat = FORMAT_ASCIIDOC, category } = {}) {
  switch (FIELD_SET.normalizeField(name)) {
    case 'description': {
      const text = (category && category.Description) || entry.description
      return typeof text === 'string' && text.trim() ? richString(text, docsFormat) : { ok: false, reason: 'missing' }
    }
    case 'status':
      return typeof entry.status === 'string' && entry.status ? { ok: true, text: entry.status } : { ok: false, reason: 'missing' }
    case 'deprecated':
      return yesNo(entry.status === 'deprecated', format)
    case 'category': {
      const cats = categoriesOf(kind, entry)
      if (!cats.length) return { ok: false, reason: 'missing' }
      return { ok: true, text: format === FORMAT_RAW ? JSON.stringify(cats) : cats.join(', ') }
    }
    case 'examples': {
      const examples = (category && Array.isArray(category.Examples) && category.Examples.length ? category.Examples : entry.examples) || []
      if (!examples.length) return { ok: false, reason: 'missing' }
      const text = examplesText(examples, docsFormat)
      return { ok: true, text, rich: { kind: 'text', text, format: FORMAT_ASCIIDOC } }
    }
    case 'introduced':
      return typeof entry.version === 'string' && entry.version ? { ok: true, text: entry.version } : { ok: false, reason: 'missing' }
    case 'impure':
      return yesNo(entry.impure === true, format)
    default:
      return { ok: false, reason: 'unsupported' }
  }
}

/**
 * The value of one field of a parameter. A default is printed as the
 * reference prints it, as JSON (a string in quotes). A default that is an
 * object or an integer JavaScript cannot hold exactly is not shown: the data
 * has two of each that differ from what the function uses (random_int's
 * seed is a Go struct, and counter's and random_int's max lost precision in
 * a float round-trip).
 */
function paramValue (param, name, { docsFormat = FORMAT_ASCIIDOC, format = FORMAT_HUMAN } = {}) {
  switch (FIELD_SET.normalizeField(name)) {
    case 'default': {
      if (!own(param, 'default')) return { ok: false, reason: 'missing' }
      const value = param.default
      if (value !== null && typeof value === 'object') return { ok: false, reason: 'complex', data: JSON.stringify(value) }
      if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) return { ok: false, reason: 'imprecise', data: String(value) }
      return { ok: true, text: JSON.stringify(value) }
    }
    case 'type':
      return typeof param.type === 'string' && param.type ? { ok: true, text: param.type } : { ok: false, reason: 'missing' }
    case 'description':
      return typeof param.description === 'string' && param.description.trim() ? richString(param.description, docsFormat) : { ok: false, reason: 'missing' }
    case 'required':
      // The reference marks a parameter (optional) when it is optional or
      // has a default.
      return yesNo(!(param.is_optional === true || own(param, 'default')), format)
    default:
      return { ok: false, reason: 'unsupported' }
  }
}

/**
 * Whether a function is missing from the Cloud functions page. The page
 * leaves out the impure functions (count, env, file, file_rel, hostname), and
 * the data has no Cloud flag of its own, so impure is the gate.
 */
const cloudHiddenEntry = (kind, entry) => kind === FUNCTION && entry.impure === true

/**
 * Resolve one bloblval: call to its value, or to the reason there is none.
 *
 * @param {object} opts
 * @param {object} [opts.registry] - From connectValues.loadConnect.
 * @param {string} opts.call - The function or method as written: counter(min).
 * @param {string} [opts.field]
 * @param {string} [opts.category]
 * @param {string[]} [opts.categoryOrder] - methodCategoryOrder.
 * @param {boolean} [opts.cloud]
 * @param {string} [opts.macro] - The call as written, for messages.
 * @returns {{ok: true, text: string, rich?: object, field: string, invert: boolean, kind: string, entry: object, param?: object, warnings: object[]} |
 *   {ok: false, kind: string, message: string, field: string, warnings?: object[]}}
 */
function resolveBloblValue ({ registry, call: written, field: requested = 'default', format = FORMAT_HUMAN, cloud = false, category, categoryOrder, filePath, macro }) {
  const resolvedField = FIELD_SET.resolveField(requested)
  const fieldName = resolvedField && resolvedField.name
  const invert = Boolean(resolvedField && resolvedField.invert)
  const call = `${macro || `bloblval:[${written},${requested}]`}${filePath ? ` in ${filePath}` : ''}`
  const field = fieldName || requested
  const parsed = parseCall(written)
  if (!fieldName) return { ok: false, kind: 'unsupported-field', field, message: FIELD_SET.unsupportedMessage(call, requested) }
  if (!parsed.ok) {
    return { ok: false, kind: 'unknown-function', field, message: `${call}: '${parsed.typed}' is not a Bloblang call; write a function as now() or counter(min), and a method as .uppercase() or .replace_all(old).` }
  }
  if (!registry) return { ok: false, kind: 'no-data', field, message: `${call}: this page has no Connect data to read '${field}' from (see the connectval macro warning), so it renders <unknown ${field}>.` }
  const dataset = datasets.describeDataset(registry)
  const resolved = resolveCall(registry.data, parsed)
  if (!resolved.ok) {
    const hint = resolved.suggestions.length ? ` Did you mean: ${resolved.suggestions.join(', ')}?` : ''
    return { ok: false, kind: resolved.kind, field, message: `${call}: ${resolved.message} in ${dataset}, so it renders <unknown ${field}>.${hint}` }
  }
  const { kind, entry, param } = resolved
  const level = param ? PARAMETER : kind
  if (!FIELDS[fieldName].levels.includes(level)) {
    const hint = level === PARAMETER
      ? ` Name the ${kind} alone, as in bloblval:[${callText(kind, entry.name)},${fieldName}].`
      : ` Name a parameter in the parentheses, as in bloblval:[counter(min),${fieldName}].`
    const names = Object.keys(FIELDS).filter((name) => FIELDS[name].levels.includes(level))
    return { ok: false, kind: 'unsupported-field', field, message: `${call}: ${fieldName} is not a field of a ${level}.${hint} Fields of a ${level}: ${names.join(', ')}.` }
  }
  const what = callText(kind, entry.name)
  if (cloud && cloudHiddenEntry(kind, entry)) {
    return { ok: false, kind: 'unavailable', field, message: `${call}: the function ${what} is impure, and the Cloud Bloblang reference leaves impure functions out, so no value is shown on this Cloud page.` }
  }
  if (cloud && FIELDS[fieldName].cloudHidden) {
    return { ok: false, kind: 'cloud-hidden', field, message: `${call}: the Bloblang reference does not state '${field}' for Cloud (it renders "Introduced in version" only outside env-cloud), so this Cloud page renders <unknown ${field}>. Put the sentence in an ifndef::env-cloud[] block.` }
  }
  const picked = pickCategory(kind, entry, category, categoryOrder || methodCategoryOrder(registry.data))
  if (!picked.ok) return { ok: false, kind: 'unknown-category', field, message: `${call}: ${picked.message} in ${dataset}.` }
  const warnings = []
  if (entry.status === 'deprecated' && fieldName !== 'deprecated' && fieldName !== 'status') {
    warnings.push({ kind: 'deprecated-entry', message: `${call}: the ${kind} ${what} is deprecated in ${dataset}.` })
  }
  const docsFormat = connectValues.docsFormat(registry.data)
  const value = param ? paramValue(param, fieldName, { docsFormat, format }) : entryValue(kind, entry, fieldName, { format, docsFormat, category: picked.category })
  const subject = param ? `the parameter '${param.name}' of ${what}` : what
  if (!value.ok) {
    const messages = {
      missing: fieldName === 'introduced' ? `${subject} has no introduced version recorded in ${dataset}` : `${subject} has no ${field} in ${dataset}`,
      complex: `the ${field} of ${subject} is ${value.data} in ${dataset}, an object the Bloblang reference does not print`,
      imprecise: `the ${field} of ${subject} is ${value.data} in ${dataset}, an integer larger than JavaScript represents exactly`,
    }
    const kindOf = value.reason === 'missing' ? 'missing-field' : value.reason === 'complex' ? 'complex-default' : value.reason
    const advice = value.reason === 'missing' ? '' : ' The data is wrong here; state the value in prose by hand.'
    return { ok: false, kind: kindOf, field, warnings, message: `${call}: ${messages[value.reason] || messages.missing}, so it renders <unknown ${field}>.${advice}` }
  }
  const text = invert ? ({ yes: 'no', no: 'yes', true: 'false', false: 'true' })[value.text] || value.text : value.text
  return { ok: true, field: fieldName, invert, text, html: value.html, rich: value.rich, kind, entry, param, category: picked.category, call, warnings, registry }
}

const VALUE_ROLE = 'bloblang-value'
const UNKNOWN_VALUE_ROLE = 'bloblang-value-unknown'

/**
 * The HTML for one bloblval: instance.
 */
function buildBloblvalContent ({ call, field, text, html, unknown = false }) {
  const attrs = `data-bloblang="${escapeHtml(call)}" data-field="${escapeHtml(field)}"`
  if (unknown) return `<span class="${VALUE_ROLE} ${UNKNOWN_VALUE_ROLE}" ${attrs}>${escapeHtml(`<unknown ${field}>`)}</span>`
  return `<span class="${VALUE_ROLE}" ${attrs}>${html !== undefined ? html : escapeHtml(text)}</span>`
}

module.exports = {
  FUNCTION,
  METHOD,
  PARAMETER,
  FIELD_SET,
  FIELDS,
  FORMAT_HUMAN,
  FORMAT_RAW,
  normalizeField: FIELD_SET.normalizeField,
  parseCall,
  callText,
  categoryKey,
  categoriesOf,
  methodCategoryOrder,
  pickCategory,
  resolveCall,
  entryValue,
  paramValue,
  cloudHiddenEntry,
  resolveBloblValue,
  buildBloblvalContent,
}
