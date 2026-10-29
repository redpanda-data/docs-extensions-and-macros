'use strict'

/* Links to the Redpanda Connect reference: component pages, their field
 * anchors, and the Bloblang function and method anchors. Shared by the
 * connect: and blobl: inline macros (macros/connect.js, macros/blobl.js) and
 * check-reference-values, so a hand-written xref is judged by the link the
 * macro would make.
 *
 * A page is found in the content catalog by Antora's own rules, page aliases
 * included, never from a list of repos:
 *
 *   1. the rendering page's own component and version, at the path the
 *      connect component gives it (components:inputs/kafka_franz.adoc,
 *      guides:bloblang/methods.adoc). The connect component finds its own
 *      pages there, and a Cloud component finds its stubs, which declare
 *      those paths as page aliases.
 *   2. the connect component's latest version, except from a Cloud
 *      (env-cloud) page: Cloud readers are never sent to self-managed docs.
 *
 * Anchors are the ids Asciidoctor generates on the published pages (idprefix
 * empty, idseparator -). A field heading such as === `batching.byte_size`
 * becomes batching-byte_size. When a section earlier on the page already has
 * that id (a component whose description has a Metadata or Credentials
 * section and a field of the same name), the field gets the next free one,
 * metadata-2, as Asciidoctor numbers it. On the methods page the second copy
 * of a method in two categories is contains-2. Parameters have no anchors.
 */

const fs = require('fs')
const datasets = require('./attachment-datasets')
const connectValues = require('./connect-values')
const bloblang = require('./bloblang-values')
const { annotateVerbatimLines } = require('../tools/redpanda-connect/metadata-utils')
const { connectFieldName } = require('../tools/redpanda-connect/helpers/flattenConnectFields')
const { FORMAT_MARKDOWN } = require('./value-descriptions')
const { latestVersion } = require('./rpk-links')

const CONNECT = connectValues.CONNECT_COMPONENT
const COMPONENTS_MODULE = 'components'
const GUIDES_MODULE = 'guides'
const BLOBLANG_PAGES = { [bloblang.FUNCTION]: 'bloblang/functions.adoc', [bloblang.METHOD]: 'bloblang/methods.adoc' }
const METHODS_PARTIAL = 'bloblang/methods.adoc'

const $pageIndex = Symbol('$connectPageIndex')

// ---------------------------------------------------------------------------
// Ids

/**
 * The id Asciidoctor generates for a section title with idprefix empty and
 * idseparator -: markup and characters other than word characters, spaces,
 * dots and hyphens dropped, and each run of spaces, dots and hyphens turned
 * into one hyphen.
 */
function sectionId (title) {
  return String(title == null ? '' : title)
    .toLowerCase()
    .replace(/<[^>]+>|&(?:[a-z][a-z]+\d{0,2}|#\d\d\d{0,4}|#x[\da-f][\da-f][\da-f]{0,3});|[^ \p{L}\p{M}\p{N}\p{Pc}\-.]+/gu, '')
    .replace(/[ .-]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Register an id as Asciidoctor does: the id itself when it is free,
 * otherwise the first free id-2, id-3, ...
 */
function claimId (base, taken) {
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  taken.add(id)
  return id
}

/**
 * The ids a block of AsciiDoc (or Markdown) source registers, in order:
 * section and discrete headings, and explicit [[id]] and [#id] anchors. A
 * heading right after an explicit anchor takes that id instead of its own.
 * Lines in listings are skipped. onInclude(target, attrs) may return the ids
 * of an included file, which are registered where the include is.
 * marker(line) may return an entry to put in place of a line.
 */
function sourceIds (text, { format, onInclude, marker } = {}) {
  const ids = []
  let anchored = false
  for (const { line, verbatim } of annotateVerbatimLines(String(text == null ? '' : text))) {
    if (verbatim) continue
    if (marker && marker(line)) {
      ids.push(marker(line))
      anchored = false
      continue
    }
    const inc = line.match(/^include::([^[]+)\[([^\]]*)\]\s*$/)
    if (inc) {
      if (onInclude) ids.push(...(onInclude(inc[1], inc[2]) || []))
      anchored = false
      continue
    }
    const explicit = line.match(/^\[\[([^\],\s]+)(?:,[^\]]*)?\]\]\s*$/) || line.match(/^\[#([^\].,%\s]+)[^\]]*\]\s*$/)
    if (explicit) {
      ids.push({ id: explicit[1], explicit: true })
      anchored = true
      continue
    }
    const heading = format === FORMAT_MARKDOWN ? line.match(/^(#{2,6})\s+(\S.*?)\s*#*\s*$/) : line.match(/^(={2,6})\s+(\S.*?)\s*$/)
    if (heading) {
      if (!anchored) ids.push({ id: sectionId(heading[2]) })
      anchored = false
      continue
    }
    if (line.trim() && !/^\[.*\]\s*$/.test(line)) anchored = false
  }
  return ids
}

// The lines between tag::x[] and end::x[], or all of them.
function taggedRegion (text, attrs) {
  const tag = (String(attrs || '').match(/(?:^|,)\s*tags?=([\w-]+)/) || [])[1]
  if (!tag) return String(text)
  const out = []
  let inside = false
  for (const line of String(text).split('\n')) {
    if (new RegExp(`tag::${tag}\\[\\]`).test(line)) { inside = true; continue }
    if (new RegExp(`end::${tag}\\[\\]`).test(line)) { inside = false; continue }
    if (inside) out.push(line)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Pages

const fileText = (file) => {
  if (!file) return undefined
  const src = file.src || {}
  if (src.contents) return String(src.contents)
  if (src.abspath) {
    try {
      return fs.readFileSync(src.abspath, 'utf8')
    } catch (error) {
      // Fall through to the catalog contents.
    }
  }
  return file.contents == null ? undefined : String(file.contents)
}

const isHtml = (text) => /^\s*<(?:div|p|h[1-6]|section|table|ul|ol)\b/.test(String(text))

// Every page and page alias in a catalog without resolvePage (the
// synthetic catalog of check-reference-values), keyed by resource ID.
function pageIndex (catalog) {
  if (catalog[$pageIndex]) return catalog[$pageIndex]
  const index = new Map()
  const key = (src) => `${src.version == null ? '' : src.version}@${src.component}:${src.module}:${src.relative}`
  for (const page of catalog.findBy({ family: 'page' }) || []) index.set(key(page.src), page)
  for (const alias of catalog.findBy({ family: 'alias' }) || []) {
    if (alias.rel && !index.has(key(alias.src))) index.set(key(alias.src), alias.rel)
  }
  catalog[$pageIndex] = index
  return index
}


/**
 * The page a resource ID names from a context, aliases resolved, or
 * undefined. spec is [component:]module:relative.
 */
function findPage (catalog, spec, context = {}) {
  if (!catalog) return undefined
  if (typeof catalog.resolvePage === 'function') {
    try {
      return catalog.resolvePage(spec, context) || undefined
    } catch (error) {
      return undefined
    }
  }
  const parts = String(spec).split(':')
  const relative = parts.pop()
  const module = parts.pop() || context.module || 'ROOT'
  const named = parts.pop()
  const component = named || context.component
  const version = named ? latestVersion(catalog, named) : (context.version == null ? '' : String(context.version))
  if (version === undefined) return undefined
  return pageIndex(catalog).get(`${version}@${component}:${module}:${relative}`)
}

/**
 * The Antora resource ID of a page, for the path attribute of an xref.
 */
function resourceId (page) {
  const src = page.src || {}
  return `${src.version ? `${src.version}@` : ''}${src.component}:${src.module}:${src.relative}`
}

/**
 * Whether a component version renders for Cloud.
 */
const isCloud = (catalog, component, version) =>
  Boolean(catalog) && datasets.isAttributeSet(datasets.componentAttributes(catalog, component || '', version || '')['env-cloud'])

/**
 * The page a link from one component version goes to, in the order the file
 * comment gives.
 *
 * @returns {{ok: true, page: object, id: string, own: boolean} | {ok: false, reason: 'cloud-no-page'|'no-page'}}
 */
function pickConnectPage (catalog, { component, version, module, relative, cloud }) {
  const ownPage = findPage(catalog, `${module}:${relative}`, { component, version, module })
  if (ownPage) return { ok: true, page: ownPage, id: resourceId(ownPage), own: true }
  if (cloud) return { ok: false, reason: 'cloud-no-page' }
  const page = component === CONNECT ? undefined : findPage(catalog, `${CONNECT}:${module}:${relative}`)
  return page ? { ok: true, page, id: resourceId(page), own: false } : { ok: false, reason: 'no-page' }
}

/**
 * A connect component partial's source, or undefined when the build does not
 * have it (a checkout without the release asset).
 */
function connectPartial (catalog, relative) {
  if (!catalog || typeof catalog.findBy !== 'function') return undefined
  const file = (catalog.findBy({ component: CONNECT, module: COMPONENTS_MODULE, family: 'partial', relative }) || [])[0]
  return file ? fileText(file) : undefined
}

// ---------------------------------------------------------------------------
// Components and fields

// The directory of a component type's pages: rate-limits -> rate_limits.
const typeDir = (key) => String(key).replace(/-/g, '_')

/**
 * The page path of a component, below the components module.
 */
const componentPagePath = (key, name) => `${typeDir(key)}/${name}.adoc`

// How the component type reads after its name: input, rate limit, metrics.
const typeWords = (type) => String(type).replace(/_/g, ' ')

/**
 * Parse <type>/<name>[.<field.path>] and resolve it in the Connect data.
 *
 * @returns {{ok: true, key: string, type: string, name: string, entry: object, path: string, field?: object, segments: string[]} |
 *   {ok: false, kind: string, message: string, suggestions?: string[]}}
 */
function resolveComponentRef (data, text) {
  const { component, path } = connectValues.parseFieldTarget(text)
  if (component === connectValues.CONFIG_COMPONENT) {
    return { ok: false, kind: 'unknown-component', message: 'the root config fields have no reference page to link; write <type>/<name>, such as inputs/kafka_franz' }
  }
  const parsed = connectValues.parseComponent(component)
  if (!parsed || !parsed.name) return { ok: false, kind: 'unknown-component', message: `'${component}' is not <type>/<name>, such as inputs/kafka_franz` }
  const resolved = connectValues.resolveComponent(data, parsed.type, parsed.name)
  if (!resolved.ok) {
    return { ok: false, kind: resolved.kind, message: resolved.message, suggestions: resolved.suggestions }
  }
  const base = { ok: true, key: resolved.key, type: resolved.type, name: parsed.name, entry: resolved.entry, path, segments: [] }
  if (!path) return base
  const segments = path.split('.').filter(Boolean)
  const walked = connectValues.resolveFieldPath(resolved.fields, segments)
  if (!walked.ok) {
    return { ok: false, kind: 'unknown-field', message: `${walked.message} in ${resolved.type}/${parsed.name}`, suggestions: walked.suggestions }
  }
  return { ...base, field: walked.field, segments }
}

/**
 * The heading the reference gives a field (batching.byte_size,
 * addresses[]) and whether the reference lists it: deprecated fields, and
 * every field below one, are left out.
 */
function fieldHeading (fields, segments) {
  let children = fields
  const names = []
  let documented = true
  for (const segment of segments) {
    const name = String(segment).replace(/\[\]$/, '')
    const field = (children || []).find((c) => c && String(c.name).replace(/\[\]$/, '') === name)
    if (!field) return { heading: undefined, documented: false }
    if (field.is_deprecated === true) documented = false
    names.push(connectFieldName(field))
    children = field.children
  }
  return { heading: names.join('.'), documented }
}

/**
 * The ids a component page registers before its fields: its own headings,
 * and those of the connect partials it includes before the fields partial.
 * A partial the build does not have is read from the data: the description
 * (a description partial's body, or a metadata partial's Metadata section)
 * and the example titles.
 *
 * @param {object} opts
 * @param {object} opts.entry - The component in the Connect data.
 * @param {string} [opts.pageText] - The connect page's AsciiDoc source.
 * @param {(relative: string) => string|undefined} [opts.readPartial]
 * @param {string} [opts.format] - The data's docs_format.
 * @returns {{before: string[], after: string[]}} the ids before the fields
 *   partial, in order, and the ids after it.
 */
function componentPageIds ({ entry = {}, pageText, readPartial = () => undefined, format } = {}) {
  const description = () => sourceIds(entry.description || '', { format })
  const examples = () => (Array.isArray(entry.examples) && entry.examples.length
    ? [{ id: 'examples' }, ...entry.examples.map((e) => ({ id: sectionId(e.title || '') })).filter((x) => x.id)]
    : [])
  if (pageText === undefined || isHtml(pageText)) return { before: description().map((x) => x.id), after: examples().map((x) => x.id) }
  const onInclude = (target, attrs) => {
    const m = target.match(/^(?:(?:connect:)?components:)?partial\$(.+)$/)
    if (!m) return []
    const relative = m[1]
    // The fields partial: its ids are the fields' own.
    if (/^fields\//.test(relative)) return [{ fields: true }]
    const text = readPartial(relative)
    if (text !== undefined) return sourceIds(taggedRegion(text, attrs))
    const tag = (String(attrs).match(/tags?=([\w-]+)/) || [])[1]
    if (/^descriptions\//.test(relative)) return tag === 'meta' ? [] : description()
    if (/^metadata\//.test(relative)) return description().filter((x) => x.id === 'metadata').slice(0, 1)
    if (/^examples\//.test(relative)) return examples()
    return []
  }
  // The fields section starts at the fields partial, or at its == Fields
  // heading written into the page.
  const ids = sourceIds(pageText, { onInclude, marker: (line) => (/^==\s+Fields\s*$/.test(line) ? { fields: true } : undefined) })
  const at = ids.findIndex((x) => x.fields)
  const split = at === -1 ? ids.length : at
  return { before: ids.slice(0, split).map((x) => x.id), after: ids.slice(split + 1).filter((x) => !x.fields).map((x) => x.id) }
}

/**
 * The connect component's page for a component, and its source, wherever
 * the link goes: a Cloud stub has the same anchors, because it includes this
 * page.
 */
function connectPageText (catalog, key, name) {
  const page = findPage(catalog, `${CONNECT}:${COMPONENTS_MODULE}:${componentPagePath(key, name)}`)
  return page ? fileText(page) : undefined
}

/**
 * The anchor of a field on its component's page, or undefined when the
 * reference does not list the field (it is deprecated).
 *
 * @param {object} opts
 * @param {object} opts.resolved - From resolveComponentRef.
 * @param {object} [opts.catalog]
 * @param {string} [opts.pageText] - Instead of reading the page from the catalog.
 * @param {string} [opts.format]
 * @returns {{anchor?: string, heading?: string, documented: boolean}}
 */
function fieldAnchor ({ resolved, catalog, pageText, format }) {
  const fields = resolved.entry && resolved.entry.config && Array.isArray(resolved.entry.config.children) ? resolved.entry.config.children : []
  const { heading, documented: listed } = fieldHeading(fields, resolved.segments)
  if (!heading) return { documented: false }
  const dir = typeDir(resolved.key)
  const partial = connectPartial(catalog, `fields/${dir}/${resolved.name}.adoc`)
  const documented = partial !== undefined ? partial.split('\n').some((l) => l.trim() === `=== \`${heading}\``) : listed
  if (!documented) return { heading, documented: false }
  const text = pageText !== undefined ? pageText : connectPageText(catalog, resolved.key, resolved.name)
  if (text !== undefined && isHtml(text)) {
    // A page already converted: the heading's own id.
    const rx = new RegExp(`<h[2-6] id="([^"]+)"[^>]*>(?:<a [^>]*></a>)?<code>${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</code></h[2-6]>`)
    const m = String(text).match(rx)
    if (m) return { anchor: m[1], heading, documented: true }
  }
  const { before } = componentPageIds({ entry: resolved.entry, pageText: text, readPartial: (relative) => connectPartial(catalog, relative), format })
  const taken = new Set()
  for (const id of before) claimId(id, taken)
  claimId('fields', taken)
  return { anchor: claimId(sectionId(heading), taken), heading, documented: true }
}

/**
 * Every id on a component page, for checking a hand-written fragment: the
 * sections before and after the fields, and every field the reference
 * lists.
 */
function componentAnchors ({ entry, pageText, catalog, format }) {
  const { before, after } = componentPageIds({ entry, pageText, readPartial: (relative) => connectPartial(catalog, relative), format })
  const taken = new Set()
  for (const id of before) claimId(id, taken)
  claimId('fields', taken)
  const walk = (children, prefix) => {
    const sorted = [...(children || [])].filter((c) => c && c.name).sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }))
    for (const c of sorted) {
      if (c.is_deprecated === true) continue
      const heading = prefix ? `${prefix}.${connectFieldName(c)}` : connectFieldName(c)
      claimId(sectionId(heading), taken)
      walk(c.children, heading)
    }
  }
  walk(entry && entry.config && entry.config.children, '')
  for (const id of after) claimId(id, taken)
  return taken
}

// ---------------------------------------------------------------------------
// Bloblang

/**
 * The method category order of the build: from the methods partial when the
 * build has it.
 */
const categoryOrder = (catalog, data) => bloblang.methodCategoryOrder(data, connectPartial(catalog, METHODS_PARTIAL))

/**
 * The anchor of a function or method on its page: the name, or for the
 * second copy of a method in two categories, name-2.
 */
function bloblangAnchor (entry, picked) {
  return picked && picked.index > 0 ? `${entry.name}-${picked.index + 1}` : entry.name
}

/**
 * Every anchor on a Bloblang page, for checking a hand-written fragment:
 * each function the page lists (impure ones only off Cloud), or each method
 * copy and each category heading. Wrapper page headings are added by the
 * caller.
 */
function bloblangAnchors (data, kind, { cloud = false, order } = {}) {
  const taken = new Set()
  const entries = (data && data[kind === bloblang.FUNCTION ? 'bloblang-functions' : 'bloblang-methods']) || []
  if (kind === bloblang.FUNCTION) {
    for (const e of entries) {
      if (!e || e.status === 'hidden' || (cloud && bloblang.cloudHiddenEntry(kind, e))) continue
      taken.add(e.name)
    }
    return taken
  }
  const cats = order || bloblang.methodCategoryOrder(data)
  for (const key of cats) {
    const heading = entries.flatMap((e) => (e.categories || []).filter((c) => bloblang.categoryKey(c.Category) === key)).map((c) => c.Category)[0]
    if (heading) taken.add(sectionId(heading))
  }
  for (const e of entries) {
    if (!e) continue
    const copies = Math.max(1, (e.categories || []).length)
    for (let i = 0; i < copies; i++) taken.add(i ? `${e.name}-${i + 1}` : e.name)
  }
  return taken
}

module.exports = {
  CONNECT,
  COMPONENTS_MODULE,
  GUIDES_MODULE,
  BLOBLANG_PAGES,
  sectionId,
  claimId,
  sourceIds,
  taggedRegion,
  fileText,
  findPage,
  resourceId,
  isCloud,
  pickConnectPage,
  connectPartial,
  typeDir,
  componentPagePath,
  typeWords,
  resolveComponentRef,
  fieldHeading,
  componentPageIds,
  connectPageText,
  fieldAnchor,
  componentAnchors,
  categoryOrder,
  bloblangAnchor,
  bloblangAnchors,
}
