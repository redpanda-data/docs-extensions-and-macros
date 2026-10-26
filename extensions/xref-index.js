'use strict'

/* Publishes a page and anchor index of the whole site as one JSON file.
 *
 * Example use in the playbook:
 *   antora:
 *     extensions:
 *       - require: '@redpanda-data/docs-extensions-and-macros/extensions/xref-index'
 *
 * WHY THIS EXISTS
 * ---------------
 * An editor checking `xref:` and `include::` targets needs the content catalog,
 * but a writer has one repository checked out and the site aggregates seven.
 * This file is that catalog with the bodies left out: every published page's
 * resource ID, title, URL and section anchors, the aliases that still resolve,
 * and the partials and examples that can be included with their tag regions.
 * The docs language server downloads it once and reads the local repository
 * on top of it.
 *
 * WHAT IS LEFT OUT
 * ----------------
 * Only what the site already serves goes in. Pages without an output (the
 * unpublish-pages extension removes them at documentsConverted) are skipped,
 * aliases are listed only when their target is published, and components in
 * `exclude_components` are skipped entirely. Partials and examples are not
 * published, so for them the index carries the path and the tag names only,
 * never the contents. Set `includes: false` to leave them out.
 *
 * Anchors are read from the converted HTML, not the AsciiDoc source, so they
 * are the ids Asciidoctor actually produced: conditionals are resolved, included
 * partials are expanded, and generated ids follow the page's own idprefix.
 */

const { raiseListenerLimit } = require('./util/raise-listener-limit')

const SCHEMA_VERSION = 1
const DEFAULT_OUTPUT_PATH = 'assets/data/xref-index.json'

const HEADING_RX = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/g
const ID_ATTR_RX = /\sid="([^"]+)"/
const ANY_ID_RX = /<([a-z][a-z0-9]*)\b[^>]*?\sid="([^"]+)"/g
const TAG_RX = /\btag::([\w.-]+)\[\]/g
// Ids nobody writes an xref to: the ones @asciidoctor/tabs generates for every
// tab and panel (on tab-heavy pages they outnumber the real anchors), and the
// structural ids Asciidoctor itself emits for the preamble, the in-page TOC and
// footnotes.
const NOISE_ID_RX = /^(?:_tabs_\d+|preamble$|toc$|_footnote(?:def|ref)_\d+$)/

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Plain text of an HTML fragment: tags removed, entities decoded, spaces collapsed. */
function htmlToText (html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ref) => {
      if (ref[0] === '#') {
        const code = ref[1].toLowerCase() === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : match
      }
      return ENTITIES[ref.toLowerCase()] ?? match
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The anchors in a converted page body: sections (headings with an id, in
 * document order, with their level and text) and every other element id.
 *
 * @param {string} html Article HTML as Asciidoctor produced it
 * @returns {{ sections: Array<{id: string, title: string, level: number}>, ids: string[] }}
 */
function extractAnchors (html) {
  const sections = []
  const headingIds = new Set()
  for (const [, level, attrs, inner] of html.matchAll(HEADING_RX)) {
    const id = (attrs.match(ID_ATTR_RX) || [])[1]
    if (!id || NOISE_ID_RX.test(id)) continue
    headingIds.add(id)
    sections.push({ id, title: htmlToText(inner), level: Number(level) - 1 })
  }
  const ids = new Set()
  for (const [, , id] of html.matchAll(ANY_ID_RX)) {
    if (headingIds.has(id) || NOISE_ID_RX.test(id)) continue
    ids.add(id)
  }
  return { sections, ids: [...ids] }
}

/** Sorted, de-duplicated tag region names in an includable file. */
function extractTags (source) {
  const tags = new Set()
  for (const [, name] of String(source || '').matchAll(TAG_RX)) tags.add(name)
  return [...tags].sort()
}

/** `module:relative`, the key a file has inside its component version. */
function localId (src) {
  return `${src.module}:${src.relative}`
}

/** A full resource ID, `version@component:module:relative`. */
function resourceId (src) {
  return `${src.version}@${src.component}:${src.module}:${src.relative}`
}

function sortObject (obj) {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]))
}

/**
 * Builds the index from a content catalog whose pages have been converted.
 *
 * @param {object} contentCatalog Antora content catalog
 * @param {object} [options]
 * @param {string[]} [options.excludeComponents] Component names to leave out
 * @param {boolean} [options.includes] Whether to list partials and examples (default true)
 * @param {string} [options.siteUrl] The playbook's site.url
 * @param {Map|WeakMap} [options.anchorsByPage] Anchors captured earlier, by page file
 * @returns {object} The index, ready to serialize
 */
function buildXrefIndex (contentCatalog, options = {}) {
  const excluded = new Set(options.excludeComponents || [])
  const withIncludes = options.includes !== false
  const anchorsByPage = options.anchorsByPage
  const versionsByKey = new Map()
  const components = {}

  for (const component of contentCatalog.getComponents()) {
    if (excluded.has(component.name)) continue
    const entry = { title: component.title, latest: component.latest ? component.latest.version : undefined, versions: [] }
    for (const cv of component.versions) {
      const v = { version: cv.version, pages: {}, aliases: {} }
      if (cv.displayVersion && cv.displayVersion !== cv.version) v.displayVersion = cv.displayVersion
      if (cv.prerelease) v.prerelease = true
      if (withIncludes) {
        v.partials = {}
        v.examples = {}
      }
      entry.versions.push(v)
      versionsByKey.set(`${cv.version}@${component.name}`, v)
    }
    components[component.name] = entry
  }
  const slot = (src) => versionsByKey.get(`${src.version}@${src.component}`)

  const published = new Set()
  for (const page of contentCatalog.getPages((p) => p.out && p.pub && p.pub.url)) {
    const v = slot(page.src)
    if (!v) continue
    published.add(page)
    const anchors = (anchorsByPage && anchorsByPage.get(page)) || extractAnchors(page.contents ? page.contents.toString() : '')
    const record = {
      title: htmlToText((page.asciidoc && (page.asciidoc.doctitle || page.asciidoc.navtitle)) || page.title || page.src.stem),
      url: page.pub.url,
    }
    if (anchors.sections.length) record.sections = anchors.sections
    if (anchors.ids.length) record.ids = anchors.ids
    v.pages[localId(page.src)] = record
  }

  for (const alias of contentCatalog.findBy({ family: 'alias' })) {
    const v = slot(alias.src)
    if (!v) continue
    let target = alias.rel
    let depth = 0
    while (target && target.src && target.src.family === 'alias' && depth++ < 5) target = target.rel
    if (!target || !published.has(target)) continue
    v.aliases[localId(alias.src)] = resourceId(target.src)
  }

  if (withIncludes) {
    for (const [family, key] of [['partial', 'partials'], ['example', 'examples']]) {
      for (const file of contentCatalog.findBy({ family })) {
        const v = slot(file.src)
        if (!v) continue
        v[key][localId(file.src)] = extractTags(file.contents)
      }
    }
  }

  for (const entry of Object.values(components)) {
    for (const v of entry.versions) {
      for (const key of ['pages', 'aliases', 'partials', 'examples']) if (v[key]) v[key] = sortObject(v[key])
    }
  }

  return {
    schema: SCHEMA_VERSION,
    site: options.siteUrl,
    generated: new Date().toISOString(),
    components: sortObject(components),
  }
}

// No default for the argument: Antora passes the config only when register
// declares a parameter (register.length > 0), and a default makes it 0.
module.exports.register = function ({ config = {} }) {
  const logger = this.getLogger('xref-index-extension')
  raiseListenerLimit(this)

  // Antora camel-cases playbook keys, so output_path arrives as outputPath.
  const outputPath = config.outputPath || DEFAULT_OUTPUT_PATH
  const excludeComponents = [].concat(config.excludeComponents || [])
  const includes = config.includes !== false

  // Anchors are read while page contents are still the article body. After
  // pagesComposed they are wrapped in the UI layout, whose nav and footer
  // headings would pollute every page.
  const anchorsByPage = new WeakMap()
  let index

  this.on('documentsConverted', ({ contentCatalog }) => {
    for (const page of contentCatalog.getPages((p) => p.out && p.contents)) {
      anchorsByPage.set(page, extractAnchors(page.contents.toString()))
    }
  })

  // navigationBuilt comes after every documentsConverted listener, so pages that
  // unpublish-pages removed are already gone whatever the registration order.
  this.on('navigationBuilt', ({ playbook, contentCatalog }) => {
    index = buildXrefIndex(contentCatalog, {
      excludeComponents,
      includes,
      siteUrl: playbook.site && playbook.site.url,
      anchorsByPage,
    })
  })

  this.on('beforePublish', ({ siteCatalog }) => {
    if (!index) return
    const json = JSON.stringify(index)
    siteCatalog.addFile({ contents: Buffer.from(json, 'utf8'), out: { path: outputPath } })
    const pages = Object.values(index.components)
      .flatMap((c) => c.versions)
      .reduce((n, v) => n + Object.keys(v.pages).length, 0)
    logger.info(`xref index: published ${outputPath} (${pages} pages, ${json.length} bytes).`)
  })
}

module.exports.buildXrefIndex = buildXrefIndex
module.exports.extractAnchors = extractAnchors
module.exports.extractTags = extractTags
module.exports.htmlToText = htmlToText
module.exports.SCHEMA_VERSION = SCHEMA_VERSION
module.exports.DEFAULT_OUTPUT_PATH = DEFAULT_OUTPUT_PATH
