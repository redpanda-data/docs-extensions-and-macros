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
 * A page found through an alias counts only when it is the page for that
 * path (isPageOf): when Cloud removes a stub, its paths become aliases of the
 * type's about page, which is not the component's page.
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
const { normalizeType } = require('../extensions/util/connect-catalog')

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

// The file name of a page path: inputs/kafka_franz.adoc -> kafka_franz.adoc.
const baseName = (relative) => String(relative).split('/').pop()

/**
 * Whether a page, found by a connect path (components:inputs/x.adoc) in some
 * component, is the page for that path: the connect page itself, or a page
 * with the same file name as the path or as the connect page it resolves to
 * (a Cloud stub, or the page of a renamed component). A Cloud about page
 * that a removed stub's paths alias is not.
 */
function isPageOf (catalog, page, { module, relative }) {
  const connectPage = findPage(catalog, `${CONNECT}:${module}:${relative}`)
  if (page === connectPage) return true
  const name = baseName(page.src.relative)
  return name === baseName(relative) || (Boolean(connectPage) && name === baseName(connectPage.src.relative))
}

/**
 * The page a link from one component version goes to, in the order the file
 * comment gives.
 *
 * @returns {{ok: true, page: object, id: string, own: boolean} | {ok: false, reason: 'cloud-no-page'|'no-page'}}
 */
function pickConnectPage (catalog, { component, version, module, relative, cloud }) {
  const ownPage = findPage(catalog, `${module}:${relative}`, { component, version, module })
  if (ownPage && isPageOf(catalog, ownPage, { module, relative })) return { ok: true, page: ownPage, id: resourceId(ownPage), own: true }
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

// ---------------------------------------------------------------------------
// Former names and replacements

// The data key of a component type directory: rate_limits -> rate-limits.
const keyOfDir = (data, dir) => Object.values(connectValues.componentTypes(data)).find((key) => typeDir(key) === dir)

/**
 * The component another component's path now goes to: the connect page that
 * declares components:<type>/<name>.adoc as a page alias, when that page is
 * another component in the data (outputs/kafka_migrator ->
 * outputs/redpanda_migrator, inputs/pg_stream -> inputs/postgres_cdc).
 *
 * @returns {{key: string, type: string, name: string, entry: object, alias: string} | undefined}
 */
function aliasedComponent (catalog, data, key, name) {
  const relative = componentPagePath(key, name)
  const page = findPage(catalog, `${CONNECT}:${COMPONENTS_MODULE}:${relative}`)
  if (!page || !page.src || page.src.relative === relative) return undefined
  const m = String(page.src.relative).match(/^([a-z_]+)\/([\w-]+)\.adoc$/)
  const target = m && keyOfDir(data, m[1])
  const entry = target && (data[target] || []).find((c) => c && c.name === m[2])
  if (!entry) return undefined
  return { key: target, type: normalizeType(target), name: m[2], entry, alias: `${COMPONENTS_MODULE}:${relative}` }
}

/**
 * A component written by a former name: one the data does not have, whose
 * path the connect docs alias to a component it has. undefined for a name
 * the data has, or no alias.
 */
function renamedComponent (catalog, data, text) {
  const { component } = connectValues.parseFieldTarget(text)
  const parsed = connectValues.parseComponent(component)
  if (!parsed || !parsed.name || !catalog) return undefined
  const resolved = connectValues.resolveComponent(data, parsed.type, parsed.name)
  if (resolved.ok || resolved.kind !== 'unknown-component') return undefined
  return aliasedComponent(catalog, data, resolved.key || connectValues.componentTypes(data)[normalizeType(parsed.type)], parsed.name)
}

/**
 * The component a deprecated component's data names as its replacement: the
 * page its path is an alias of (pg_stream, whose path the postgres_cdc page
 * declares), or the one component its description links in the paragraphs
 * that say it is deprecated ("This input is deprecated as of version 4.68.0.
 * Use the xref:components:inputs/redpanda.adoc[`redpanda` input] instead.").
 * undefined when it names none, or more than one (parquet: parquet_decode
 * and parquet_encode).
 *
 * @returns {{key: string, type: string, name: string, entry: object, source: 'page-alias'|'description'} | undefined}
 */
function componentReplacement (catalog, data, key, name, entry) {
  if (!entry || entry.status !== 'deprecated') return undefined
  const aliased = catalog ? aliasedComponent(catalog, data, key, name) : undefined
  if (aliased) return { ...aliased, source: 'page-alias' }
  const found = new Map()
  for (const paragraph of String(entry.description || '').split(/\n\s*\n/)) {
    if (!/deprecat/i.test(paragraph)) continue
    for (const m of paragraph.matchAll(/xref:(?:connect:)?components:([a-z_]+)\/([\w-]+)\.adoc/g)) {
      const target = keyOfDir(data, m[1])
      const other = target && (data[target] || []).find((c) => c && c.name === m[2])
      if (other && !(target === key && m[2] === name)) found.set(`${target}/${m[2]}`, { key: target, type: normalizeType(target), name: m[2], entry: other, source: 'description' })
    }
  }
  return found.size === 1 ? [...found.values()][0] : undefined
}

/**
 * The field a deprecated field's description names instead ("Deprecated:
 * use `commit_backoff.max_elapsed_time` instead", "Deprecated in favor of
 * `address`"), as a path from the component: beside the field first, then
 * from the top. undefined when the description names none that the data has
 * and lists.
 */
function fieldReplacement (fields, segments, field) {
  if (!field || field.is_deprecated !== true) return undefined
  const m = String(field.description || '').match(/deprecated(?:\s+in\s+favou?r\s+of|[:.,]?\s+use)\s+(?:the\s+)?`?([a-z_][\w.]*[a-z0-9_])`?/i)
  if (!m) return undefined
  const named = m[1].split('.')
  for (const base of [segments.slice(0, -1), []]) {
    const path = [...base, ...named]
    const walked = connectValues.resolveFieldPath(fields, path)
    if (walked.ok && walked.field.is_deprecated !== true && path.join('.') !== segments.join('.')) return path.join('.')
  }
  return undefined
}

/**
 * The fields of a component entry.
 */
const fieldsOf = (entry) => (entry && entry.config && Array.isArray(entry.config.children) ? entry.config.children : [])

/**
 * What to write instead of a component reference (<type>/<name>[.<field>])
 * that uses a former or deprecated name, and whether a call may simply be
 * rewritten to it: the component the data names, with the same field path
 * when that component has it, or the field the deprecated field's
 * description names.
 *
 * @returns {{kind: 'renamed'|'deprecated-component'|'deprecated-field', ref?: string, writable: boolean, why?: string, replacement?: object} | undefined}
 *   ref is <dir>/<name>[.<path>], written as the macros take it.
 */
function referenceAdvice (catalog, data, text) {
  const { path } = connectValues.parseFieldTarget(text)
  const segments = path ? path.split('.').filter(Boolean) : []
  const renamed = renamedComponent(catalog, data, text)
  const withPath = (target) => {
    if (!segments.length) return { ok: true, ref: `${typeDir(target.key)}/${target.name}` }
    const walked = connectValues.resolveFieldPath(fieldsOf(target.entry), segments)
    return walked.ok ? { ok: true, ref: `${typeDir(target.key)}/${target.name}.${segments.join('.')}` } : { ok: false }
  }
  if (renamed) {
    const p = withPath(renamed)
    return { kind: 'renamed', replacement: renamed, ref: p.ok ? p.ref : undefined, writable: p.ok, why: p.ok ? undefined : `${typeDir(renamed.key)}/${renamed.name} has no field ${path}` }
  }
  const resolved = resolveComponentRef(data, text)
  if (!resolved.ok) return undefined
  if (resolved.field && resolved.field.is_deprecated === true) {
    const instead = fieldReplacement(fieldsOf(resolved.entry), resolved.segments, resolved.field)
    if (instead) return { kind: 'deprecated-field', ref: `${typeDir(resolved.key)}/${resolved.name}.${instead}`, field: instead, writable: true }
    return { kind: 'deprecated-field', writable: false, why: 'the Connect data names no replacement for the field' }
  }
  if (resolved.entry.status !== 'deprecated') return undefined
  const replacement = componentReplacement(catalog, data, resolved.key, resolved.name, resolved.entry)
  if (!replacement) return { kind: 'deprecated-component', writable: false, why: `the Connect data names no single replacement for the ${resolved.type} '${resolved.name}'` }
  const p = withPath(replacement)
  const sameType = replacement.key === resolved.key
  return {
    kind: 'deprecated-component',
    replacement,
    ref: p.ok ? p.ref : undefined,
    writable: p.ok && sameType,
    why: !p.ok ? `${typeDir(replacement.key)}/${replacement.name} has no field ${path}, so find the equivalent by hand` : sameType ? undefined : `${typeDir(replacement.key)}/${replacement.name} is another type of component, so the sentence needs rewording by hand`,
  }
}

/**
 * The sentence a macro warns with for referenceAdvice: what the name is, what
 * to write instead, or why it cannot simply be rewritten.
 *
 * @param {object} advice - From referenceAdvice.
 * @param {object} opts
 * @param {string} opts.written - <dir>/<name>[.<path>] as written.
 * @param {string} opts.dataset - describeDataset of the data.
 * @param {(ref: string) => string} opts.suggest - The call around a reference.
 */
function adviceSentence (advice, { written, dataset, suggest }) {
  const { component, path } = connectValues.parseFieldTarget(written)
  const parsed = connectValues.parseComponent(component) || {}
  const what = `the ${normalizeType(parsed.type || '').replace(/_/g, ' ')} '${parsed.name}'`
  const instead = advice.ref && advice.writable ? `: write ${suggest(advice.ref)}` : advice.why ? `, but ${advice.why}` : ''
  if (advice.kind === 'renamed') {
    const r = advice.replacement
    return `${what} is now ${typeDir(r.key)}/${r.name}: the connect docs alias its page path, ${r.alias}, to that component's page${advice.ref ? `; write ${suggest(advice.ref)}` : `, and ${advice.why}`}.`
  }
  if (advice.kind === 'deprecated-field') {
    return `'${path}' of ${what} is deprecated in ${dataset}${advice.field ? `; its replacement is ${advice.field}${instead}` : `; ${advice.why}`}.`
  }
  const r = advice.replacement
  return `${what} is deprecated in ${dataset}${r ? `; its replacement is ${typeDir(r.key)}/${r.name}${instead}` : `; ${advice.why}`}.`
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
  // A partial's own includes count too: a description partial includes the
  // metadata partial, which holds the == Metadata section.
  const onInclude = (target, attrs) => {
    const m = target.match(/^(?:(?:connect:)?components:)?partial\$(.+)$/)
    if (!m) return []
    const relative = m[1]
    // The fields partial: its ids are the fields' own.
    if (/^fields\//.test(relative)) return [{ fields: true }]
    const text = readPartial(relative)
    if (text !== undefined) return sourceIds(taggedRegion(text, attrs), { onInclude })
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
  isPageOf,
  pickConnectPage,
  connectPartial,
  typeDir,
  componentPagePath,
  typeWords,
  resolveComponentRef,
  aliasedComponent,
  renamedComponent,
  componentReplacement,
  fieldReplacement,
  referenceAdvice,
  adviceSentence,
  fieldHeading,
  componentPageIds,
  connectPageText,
  fieldAnchor,
  componentAnchors,
  categoryOrder,
  bloblangAnchor,
  bloblangAnchors,
}
