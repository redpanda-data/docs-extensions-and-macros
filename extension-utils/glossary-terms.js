'use strict'

/**
 * The glossary as data: one parser for the term files in the docs repo at
 * shared/modules/terms/partials/, used by the glossterm macro, the
 * aggregate-terms extension (which publishes terms.json), and
 * doc-tools check-metadata.
 *
 * A term file is a short AsciiDoc section with attribute entries:
 *
 *   === Schema Registry
 *   :term-name: Schema Registry
 *   :hover-text: One-sentence definition, shown in tooltips.
 *   :category: Schema Registry
 *   :alt-labels: schema registry service, SR      (optional)
 *   :do-not-use: the Schema Registry               (optional)
 *   :link: https://...                              (optional)
 *
 * `alt-labels` are other names readers use for the same thing. `do-not-use`
 * are forms the docs avoid; style lint flags them and agents should not write
 * them. Both are comma-separated. A do-not-use form is exact-case, so it can
 * be a casing rule: `Bring your own cloud` next to the alt label
 * `Bring Your Own Cloud`. terms.json gives each one the label to use instead.
 *
 * The term ID is the file's basename without `.adoc`, so it stays stable
 * when the term name changes case or wording.
 *
 * validateTerms reports what makes the glossary ambiguous: two terms with the
 * same name, a label that names two terms, or a form a term both uses and
 * avoids. The build fails on these, the same way it fails on an invalid
 * taxonomy.
 */

const TERMS_COMPONENT = 'shared'
const TERMS_MODULE = 'terms'
const TERMS_PATH = 'shared/modules/terms/partials'
const TERMS_JSON = 'terms.json'
const PUBLIC_URL = `https://docs.redpanda.com/${TERMS_COMPONENT}/_attachments/${TERMS_JSON}`
const SCHEMA_VERSION = 1

const ATTRIBUTE_RX = /^:([a-zA-Z0-9_-]+):[ \t]*(.*)$/gm
// Characters glossary anchors replace with '-' (macros/glossary.js termId).
const ANCHOR_RX = /[/ _.-]+/g

/** Case-insensitive, whitespace-collapsed key for comparing labels. */
function labelKey (value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

function splitLabels (value) {
  if (!value) return []
  return String(value).split(',').map((s) => s.trim()).filter(Boolean)
}

/** The anchor the glossary page gives a term, from its section title. */
function termAnchor (pageTitle) {
  return String(pageTitle || '').replace(/[[\]()]/g, '').toLowerCase().replace(ANCHOR_RX, '-')
}

/**
 * Parse one term file.
 *
 * @param {string|Buffer} contents
 * @param {{id?: string, path?: string}} [meta] - id defaults to the basename of path
 * @returns {Object|null} null when term-name or hover-text is missing
 */
function parseTermFile (contents, { id, path: filePath } = {}) {
  const content = String(contents)
  const attributes = {}
  let match
  ATTRIBUTE_RX.lastIndex = 0
  while ((match = ATTRIBUTE_RX.exec(content)) !== null) attributes[match[1]] = match[2].trim()
  if (!attributes['term-name'] || !attributes['hover-text']) return null
  const firstLine = content.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  const pageTitle = firstLine ? firstLine.replace(/^=+\s*/, '') : '#'
  const base = filePath ? String(filePath).split('/').pop().replace(/\.adoc$/, '') : ''
  const term = {
    id: id || base || labelKey(attributes['term-name']).replace(/\s+/g, '-'),
    term: attributes['term-name'],
    def: attributes['hover-text'],
    category: attributes.category || '',
    altLabels: splitLabels(attributes['alt-labels']),
    doNotUse: splitLabels(attributes['do-not-use']),
    pageTitle,
    anchor: termAnchor(pageTitle),
    content,
  }
  if (attributes.link) term.link = attributes.link
  if (filePath) term.path = filePath
  return term
}

/**
 * Find what makes the glossary ambiguous.
 *
 * @param {Array<Object>} terms - from parseTermFile
 * @returns {string[]} one message per problem, empty when the glossary is consistent
 */
function validateTerms (terms) {
  const errors = []
  const names = new Map() // key -> term
  const labels = new Map() // key -> { term, kind }
  const where = (t) => t.path || t.id

  for (const t of terms) {
    const key = labelKey(t.term)
    if (names.has(key)) errors.push(`duplicate term-name '${t.term}' in ${where(t)} and ${where(names.get(key))}`)
    else names.set(key, t)
  }
  for (const t of terms) {
    const own = new Set([labelKey(t.term)])
    for (const alt of t.altLabels) {
      const key = labelKey(alt)
      if (own.has(key)) continue
      own.add(key)
      const named = names.get(key)
      if (named && named !== t) errors.push(`alt-label '${alt}' of '${t.term}' (${where(t)}) is the name of another term, '${named.term}' (${where(named)})`)
      const seen = labels.get(key)
      if (seen && seen.term !== t) errors.push(`alt-label '${alt}' names two terms: '${seen.term.term}' (${where(seen.term)}) and '${t.term}' (${where(t)})`)
      else labels.set(key, { term: t, kind: 'alt' })
    }
    // A do-not-use form may differ from a label only in case: that is a
    // casing rule (`Bring your own cloud` for Bring Your Own Cloud). The
    // exact same string as a label is a contradiction.
    const exactLabels = new Set([t.term, ...t.altLabels])
    for (const avoid of t.doNotUse) {
      if (exactLabels.has(avoid)) errors.push(`'${avoid}' is both a label and a do-not-use form of '${t.term}' (${where(t)})`)
      const named = names.get(labelKey(avoid))
      if (named && named !== t) errors.push(`do-not-use form '${avoid}' of '${t.term}' (${where(t)}) is the name of another term, '${named.term}' (${where(named)})`)
    }
  }
  return errors
}

/**
 * Index terms by every label a writer may use in glossterm: the term name and
 * its alt labels, case-insensitively.
 */
function indexTerms (terms) {
  const byLabel = new Map()
  for (const t of terms) {
    for (const label of [t.term, ...t.altLabels]) {
      const key = labelKey(label)
      if (!byLabel.has(key)) byLabel.set(key, t)
    }
  }
  return byLabel
}

/**
 * What to write instead of a do-not-use form: the label it matches ignoring
 * case (so `Bring your own cloud` becomes `Bring Your Own Cloud`), otherwise
 * the term name.
 */
function useInstead (term, form) {
  const key = labelKey(form)
  return [term.term, ...term.altLabels].find((label) => labelKey(label) === key) || term.term
}

/**
 * The published form, served at /shared/_attachments/terms.json.
 *
 * @param {Array<Object>} terms
 * @param {{glossaryUrl?: string, generatedBy?: string}} [options] - glossaryUrl is
 *   the site path of the glossary page; each term gets `url` = glossaryUrl#anchor
 */
function toTermsJson (terms, { glossaryUrl, generatedBy } = {}) {
  const out = {
    schema: SCHEMA_VERSION,
    source: TERMS_PATH,
    terms: [...terms]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) // ordinal, the same in every locale
      .map((t) => {
        const entry = { id: t.id, term: t.term, definition: t.def, category: t.category, altLabels: t.altLabels, doNotUse: t.doNotUse.map((form) => ({ form, useInstead: useInstead(t, form) })) }
        if (glossaryUrl) entry.url = `${glossaryUrl}#${t.anchor}`
        if (t.link) entry.link = t.link
        return entry
      }),
  }
  if (generatedBy) out.generatedBy = generatedBy
  return out
}

/**
 * Read terms from a local directory of term files (a docs checkout).
 *
 * @param {string} dir
 * @returns {Array<Object>}
 */
function loadTermsFromDir (dir) {
  const fs = require('fs')
  const path = require('path')
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.adoc'))
    .sort()
    .map((f) => parseTermFile(fs.readFileSync(path.join(dir, f), 'utf8'), { path: `${TERMS_PATH}/${f}` }))
    .filter(Boolean)
}

/** Terms from a published terms.json (the shape toTermsJson writes). */
function termsFromJson (data) {
  return ((data && data.terms) || []).map((e) => ({
    id: e.id,
    term: e.term,
    def: e.definition,
    category: e.category || '',
    altLabels: e.altLabels || [],
    doNotUse: (e.doNotUse || []).map((d) => (typeof d === 'string' ? d : d.form)),
    anchor: e.url ? e.url.split('#')[1] : '',
  }))
}

module.exports = {
  TERMS_COMPONENT,
  TERMS_MODULE,
  TERMS_PATH,
  TERMS_JSON,
  PUBLIC_URL,
  SCHEMA_VERSION,
  labelKey,
  termAnchor,
  parseTermFile,
  validateTerms,
  indexTerms,
  useInstead,
  toTermsJson,
  loadTermsFromDir,
  termsFromJson,
}
