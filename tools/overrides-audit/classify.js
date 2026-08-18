/**
 * Overrides Audit - Field-Level Classification
 *
 * Classifies each field of a docs-side override entry against the string
 * extracted from engineering source, powering the override-retirement loop:
 * a description override is a stopgap that dies once the fixed string ships
 * upstream, while structured docs enrichment (related_topics, config_scope,
 * examples-as-files, page attributes) stays in the override layer by design.
 *
 * Classes:
 * - REDUNDANT: the override no longer changes anything (source already
 *   matches after normalization). Safe to delete in the next auto-docs PR.
 * - UPSTREAMABLE: the override differs from source and is free of docs-only
 *   markup, so the override text itself can be sent upstream verbatim
 *   (upstream_candidate_text carries it).
 * - KEEP_UNTIL_UPSTREAMED: the override differs AND contains docs-only
 *   markup (the SPLIT case). The markup-stripped prose is emitted as
 *   upstream_candidate_text; the entry keeps masking the source string until
 *   the stripped prose ships upstream.
 * - UPSTREAMABLE_SLOT: structured data that has a natural home in source
 *   metadata (the `.example` metadata slot on property declarations).
 * - REDUNDANT_OR_UPSTREAMABLE: needs a human ruling (accepted_values on an
 *   enum property: the override may be filtering internal-only values, or it
 *   may just restate the enum).
 * - KEEP: docs-layer enrichment that stays in the override file by design.
 * - REVIEW: a mismatch that may indicate a source bug (default/type
 *   overrides that disagree with source) or a unit the audit cannot rule on.
 *   Never auto-delete.
 */

'use strict'

const crypto = require('crypto')

const CLASSES = Object.freeze({
  REDUNDANT: 'REDUNDANT',
  UPSTREAMABLE: 'UPSTREAMABLE',
  KEEP_UNTIL_UPSTREAMED: 'KEEP_UNTIL_UPSTREAMED',
  UPSTREAMABLE_SLOT: 'UPSTREAMABLE_SLOT',
  REDUNDANT_OR_UPSTREAMABLE: 'REDUNDANT_OR_UPSTREAMABLE',
  KEEP: 'KEEP',
  REVIEW: 'REVIEW'
})

/**
 * Attributes that are acceptable inside an upstreamed source string.
 *
 * Empty today: the live overrides file contains no unescaped attribute
 * references, and source strings ship verbatim into JSON payloads (hover
 * tooltips) where an unresolved {attr} would leak raw. The hook exists so a
 * product-name attribute can be allowlisted later without touching the
 * markup detector.
 */
const PRODUCT_ATTR_ALLOWLIST = Object.freeze([])

/**
 * Fields that stay in the override layer by design: docs-site structure the
 * source string cannot carry (see the override-lifecycle policy).
 */
const KEEP_BY_DESIGN_FIELDS = Object.freeze([
  'related_topics',
  'category',
  'config_scope',
  'version',
  'exclude_from_docs',
  'descriptionScope'
])

/**
 * The known typo'd key: the extractor honors `accepted_values`, so an
 * `acceptable_values` override is silently ignored for existing properties.
 */
const TYPO_KEYS = Object.freeze({ acceptable_values: 'accepted_values' })

/**
 * Fields the audit never classifies as override content.
 * `upstream_ref` is a policy annotation carried onto the description row;
 * `_comment` is maintainer notes.
 */
const META_FIELDS = Object.freeze(['upstream_ref', '_comment'])

/**
 * Normalize prose for comparison: unwrap lines and collapse all whitespace
 * runs (spaces, newlines from re-wrapped C++ adjacent literals) to single
 * spaces, then trim.
 *
 * @param {string} text - Raw description text.
 * @returns {string} Normalized text.
 */
function normalizeText (text) {
  if (typeof text !== 'string') return ''
  return text.replace(/\s+/g, ' ').trim()
}

// Docs-only markup detectors. `<<anchor>>` cross-references are included
// beyond the core macro list: they target anchors that only exist on the
// generated docs page, so they can never ship in a source string.
const MARKUP_PATTERNS = Object.freeze([
  { id: 'xref', re: /xref:[^\s[]+\[[^\]]*\]/ },
  { id: 'glossterm', re: /glossterm:[^[]+\[[^\]]*\]/ },
  { id: 'include', re: /include::[^\s[]+\[[^\]]*\]/ },
  { id: 'conditional', re: /(?:^|\n)\s*(?:ifdef|ifndef|endif)::[^\n]*/ },
  { id: 'pass', re: /pass:[a-z,]*\[/ },
  { id: 'anchor-xref', re: /<<[^<>\n]+>>/ },
  // Property-link macros: config_ref: is the deprecated docs macro (the
  // extractor rewrites it to prop:), prop: is its replacement. Both resolve
  // against the published property JSON, so neither can ship in source.
  { id: 'property-link', re: /\b(?:config_ref|prop):[^\s[]+\[[^\]]*\]/ }
])

/**
 * Find unescaped AsciiDoc attribute references (`{attr}`) that are not on
 * the product-attr allowlist. Escaped literals (`\{attr}`) do not count.
 *
 * @param {string} text - Description text.
 * @param {string[]} allowlist - Attribute names allowed in source strings.
 * @returns {string[]} Disallowed attribute names found.
 */
function findDisallowedAttrs (text, allowlist = PRODUCT_ATTR_ALLOWLIST) {
  const found = []
  const re = /(\\)?\{([a-zA-Z][a-zA-Z0-9_-]*)\}/g
  let match
  while ((match = re.exec(text)) !== null) {
    if (match[1]) continue // escaped literal, renders as {attr}
    if (!allowlist.includes(match[2]) && !found.includes(match[2])) {
      found.push(match[2])
    }
  }
  return found
}

/**
 * List the docs-only markup kinds present in a description.
 *
 * @param {string} text - Description text.
 * @param {string[]} attrAllowlist - Product-attr allowlist.
 * @returns {string[]} Markup kind ids (empty when the text is markup-free).
 */
function detectDocsMarkup (text, attrAllowlist = PRODUCT_ATTR_ALLOWLIST) {
  const kinds = []
  for (const { id, re } of MARKUP_PATTERNS) {
    if (re.test(text)) kinds.push(id)
  }
  if (findDisallowedAttrs(text, attrAllowlist).length > 0) kinds.push('attribute')
  return kinds
}

/**
 * Strip docs-only markup from a description, leaving prose that could ship
 * as a source string (the SPLIT case's upstream candidate).
 *
 * - `xref:target[text]` keeps the link text (or the last path segment when
 *   the text is empty).
 * - `glossterm:Term[definition]` keeps the term.
 * - `<<anchor,text>>` keeps the text; `<<anchor>>` keeps the anchor.
 * - `pass:q[content]` keeps the content.
 * - `include::` and `ifdef::`/`ifndef::`/`endif::` directive lines are
 *   dropped (conditional content between the directives is kept).
 * - Unresolvable `{attr}` references are left in place; the caller flags
 *   them for human review via the markup kinds.
 *
 * @param {string} text - Description text with markup.
 * @returns {string} Markup-stripped prose.
 */
function stripDocsMarkup (text) {
  let out = text
  // xref:module:page.adoc[link text] -> link text
  out = out.replace(/xref:([^\s[]+)\[([^\]]*)\]/g, (m, target, label) => {
    if (label.trim()) return label.trim()
    const segment = target.split(/[/:]/).pop().replace(/\.adoc$/, '').replace(/#.*$/, '')
    return segment.replace(/-/g, ' ')
  })
  // glossterm:Term[definition] -> Term
  out = out.replace(/glossterm:([^[]+)\[[^\]]*\]/g, (m, term) => term.trim())
  // config_ref:name,link,path[display] -> display (or `name`)
  out = out.replace(/\bconfig_ref:([^\s[,]+)[^[]*\[([^\]]*)\]/g, (m, name, label) =>
    label.trim() ? label.trim() : `\`${name.trim()}\``)
  // prop:name[attrs] -> text= attr value (or `name`)
  out = out.replace(/\bprop:([^\s[]+)\[([^\]]*)\]/g, (m, name, attrs) => {
    const textAttr = /(?:^|,)\s*text=([^,\]]+)/.exec(attrs)
    return textAttr ? textAttr[1].trim() : `\`${name.trim()}\``
  })
  // pass:q[content] -> content
  out = out.replace(/pass:[a-z,]*\[([^\]]*)\]/g, '$1')
  // <<anchor,text>> -> text ; <<anchor>> -> anchor
  out = out.replace(/<<([^<>,\n]+),([^<>\n]+)>>/g, (m, anchor, label) => label.trim())
  out = out.replace(/<<([^<>\n]+)>>/g, (m, anchor) => anchor.trim())
  // Drop include and conditional directive lines, keeping surrounding prose
  out = out
    .split('\n')
    .filter((line) => !/^\s*(?:include::|ifdef::|ifndef::|endif::)/.test(line))
    .join('\n')
  // Tidy whitespace artifacts without flattening paragraphs
  out = out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return out
}

/**
 * Stable content hash for the dedup manifest kept by the docs-repo
 * workflow: the same (name, override description) pair always hashes to the
 * same value, so an upstream PR already opened for this text is skipped.
 *
 * @param {string} name - Property (or command) name.
 * @param {string} overrideText - The override description text.
 * @returns {string} 16-hex-char sha256 prefix.
 */
function contentHash (name, overrideText) {
  return crypto
    .createHash('sha256')
    .update(`${name} ${normalizeText(overrideText)}`)
    .digest('hex')
    .slice(0, 16)
}

/**
 * Structural deep equality (same semantics as compare-properties.js).
 *
 * @param {*} a - First value.
 * @param {*} b - Second value.
 * @returns {boolean} True when deeply equal.
 */
function deepEqual (a, b) {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((val, i) => deepEqual(val, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) return false
    return keysA.every((key) => keysB.includes(key) && deepEqual(a[key], b[key]))
  }
  return false
}

/**
 * Build one manifest row.
 *
 * @param {Object} fields - Row fields (name, field, class, note, ...).
 * @returns {Object} Manifest row with stable key order.
 */
function row (fields) {
  const base = { name: fields.name, field: fields.field, class: fields.class }
  for (const key of ['upstream_candidate_text', 'upstream_ref', 'content_hash', 'source_file', 'source_line', 'note']) {
    if (fields[key] !== undefined) base[key] = fields[key]
  }
  return base
}

/**
 * Classify the description field of one override entry.
 *
 * @param {string} name - Property name.
 * @param {Object} override - Override entry (may carry upstream_ref).
 * @param {Object|null} sourceProp - Extracted source property, or null.
 * @param {Object} [opts] - Options ({ attrAllowlist }).
 * @returns {Object} Manifest row.
 */
function classifyDescription (name, override, sourceProp, opts = {}) {
  const attrAllowlist = opts.attrAllowlist || PRODUCT_ATTR_ALLOWLIST
  const overrideText = override.description
  const common = {
    name,
    field: 'description',
    content_hash: contentHash(name, overrideText),
    source_file: sourceProp ? sourceProp.defined_in : undefined,
    source_line: sourceProp && sourceProp.line_start !== undefined ? sourceProp.line_start : undefined
  }
  if (override.upstream_ref !== undefined) common.upstream_ref = override.upstream_ref

  if (!sourceProp) {
    return row({
      ...common,
      class: CLASSES.REVIEW,
      note: 'Property not present in extracted source JSON; override may create a doc-only property or the property was removed upstream.'
    })
  }

  const sourceText = normalizeText(sourceProp.description)
  const overrideNormalized = normalizeText(overrideText)

  if (overrideNormalized === sourceText) {
    return row({
      ...common,
      class: CLASSES.REDUNDANT,
      note: 'Source description already matches the override after normalization.'
    })
  }

  const markupKinds = detectDocsMarkup(overrideText, attrAllowlist)
  if (markupKinds.length === 0) {
    return row({
      ...common,
      class: CLASSES.UPSTREAMABLE,
      upstream_candidate_text: overrideText,
      note: 'Override prose differs from source and is markup-free; send upstream verbatim.'
    })
  }

  const stripped = stripDocsMarkup(overrideText)
  if (normalizeText(stripped) === sourceText) {
    return row({
      ...common,
      class: CLASSES.KEEP,
      note: `Markup-only enrichment (${markupKinds.join(', ')}): the prose already matches source, only docs-site markup is added. Nothing to upstream.`
    })
  }

  return row({
    ...common,
    class: CLASSES.KEEP_UNTIL_UPSTREAMED,
    upstream_candidate_text: stripped,
    note: `SPLIT: contains docs-only markup (${markupKinds.join(', ')}). Stripped prose is the upstream candidate; keep the override until it ships.`
  })
}

/**
 * Classify one field of one override entry against the extracted source
 * property. Dispatches on field name; unknown fields are kept (docs-layer
 * data the audit does not understand yet), with typo'd keys flagged.
 *
 * @param {string} name - Property name.
 * @param {string} field - Override field name.
 * @param {Object} override - Full override entry.
 * @param {Object|null} sourceProp - Extracted property, or null when absent.
 * @param {Object} [opts] - Options ({ attrAllowlist }).
 * @returns {Object|null} Manifest row, or null for meta fields.
 */
function classifyField (name, field, override, sourceProp, opts = {}) {
  if (META_FIELDS.includes(field)) return null

  const sourceRef = sourceProp
    ? { source_file: sourceProp.defined_in, source_line: sourceProp.line_start }
    : {}

  if (field === 'description') {
    return classifyDescription(name, override, sourceProp, opts)
  }

  if (field === 'example') {
    const value = override.example
    const text = Array.isArray(value) ? value.join('\n') : String(value)
    const hasBlockMarkup = /(^|\n)(\[,?\s*[a-z]*\]|----)/.test(text)
    return row({
      name,
      field,
      class: CLASSES.UPSTREAMABLE_SLOT,
      ...sourceRef,
      note: hasBlockMarkup
        ? 'Migrate to the source `.example` metadata slot; contains AsciiDoc block markup, review formatting before migrating.'
        : 'Migrate to the source `.example` metadata slot.'
    })
  }

  if (field === 'example_file' || field === 'example_yaml') {
    return row({
      name,
      field,
      class: CLASSES.KEEP,
      ...sourceRef,
      note: 'File/YAML example variants are docs-only rendering; they have no source slot.'
    })
  }

  if (field === 'accepted_values') {
    const sourceEnum = sourceProp && (sourceProp.enum || (sourceProp.items && sourceProp.items.enum))
    if (Array.isArray(sourceEnum)) {
      const same = deepEqual([...override.accepted_values].sort(), [...sourceEnum].sort())
      return row({
        name,
        field,
        class: CLASSES.REDUNDANT_OR_UPSTREAMABLE,
        ...sourceRef,
        note: same
          ? 'Source enum matches the override values exactly; likely redundant. Needs a human ruling.'
          : 'Source is an enum but the values differ; the override may deliberately hide internal-only values. Needs a human ruling.'
      })
    }
    return row({
      name,
      field,
      class: CLASSES.KEEP,
      ...sourceRef,
      note: 'Extracted property is not an enum; accepted_values is docs-side enrichment.'
    })
  }

  if (field === 'default' || field === 'type') {
    if (!sourceProp) {
      return row({
        name,
        field,
        class: CLASSES.REVIEW,
        note: 'Property not present in extracted source JSON; cannot compare.'
      })
    }
    if (deepEqual(override[field], sourceProp[field])) {
      return row({
        name,
        field,
        class: CLASSES.REDUNDANT,
        ...sourceRef,
        note: `Source ${field} already matches the override.`
      })
    }
    return row({
      name,
      field,
      class: CLASSES.REVIEW,
      ...sourceRef,
      note: `Override ${field} (${JSON.stringify(override[field])}) differs from source (${JSON.stringify(sourceProp[field])}); possible source bug. Never auto-delete.`
    })
  }

  if (KEEP_BY_DESIGN_FIELDS.includes(field)) {
    return row({
      name,
      field,
      class: CLASSES.KEEP,
      ...sourceRef,
      note: 'Docs-layer enrichment; stays in the override file by design.'
    })
  }

  if (TYPO_KEYS[field]) {
    return row({
      name,
      field,
      class: CLASSES.REVIEW,
      ...sourceRef,
      note: `Typo'd key: '${field}' is silently ignored by the extractor; rename to '${TYPO_KEYS[field]}'.`
    })
  }

  return row({
    name,
    field,
    class: CLASSES.KEEP,
    ...sourceRef,
    note: `Unrecognized override field '${field}'; kept, verify it is honored by the extractor.`
  })
}

/**
 * Classify every field of one property override entry.
 *
 * @param {string} name - Property name.
 * @param {Object} override - Override entry.
 * @param {Object|null} sourceProp - Extracted property, or null.
 * @param {Object} [opts] - Options.
 * @returns {Object[]} Manifest rows for the entry.
 */
function classifyPropertyEntry (name, override, sourceProp, opts = {}) {
  const rows = []
  for (const field of Object.keys(override)) {
    const result = classifyField(name, field, override, sourceProp, opts)
    if (result) rows.push(result)
  }
  return rows
}

/**
 * Classify a whole property-overrides document against extracted source.
 *
 * @param {Object} overridesDoc - Parsed property-overrides.json ({ properties }).
 * @param {Object} extractedDoc - Parsed extracted-properties JSON ({ properties }).
 * @param {Object} [opts] - Options ({ attrAllowlist }).
 * @returns {{manifest: Object[], summary: Object}} Manifest and class counts.
 */
function classifyProperties (overridesDoc, extractedDoc, opts = {}) {
  const overrides = (overridesDoc && overridesDoc.properties) || {}
  const extracted = (extractedDoc && extractedDoc.properties) || {}

  const manifest = []
  for (const [name, override] of Object.entries(overrides)) {
    if (typeof override !== 'object' || override === null || Array.isArray(override)) {
      manifest.push(row({
        name,
        field: '(entry)',
        class: CLASSES.REVIEW,
        note: `Override entry is not an object (${typeof override}); malformed.`
      }))
      continue
    }
    manifest.push(...classifyPropertyEntry(name, override, extracted[name] || null, opts))
  }
  return { manifest, summary: summarize(manifest) }
}

/**
 * Count manifest rows per class and per (class, field).
 *
 * @param {Object[]} manifest - Manifest rows.
 * @returns {Object} { total, byClass, byField }.
 */
function summarize (manifest) {
  const byClass = {}
  const byField = {}
  for (const entry of manifest) {
    byClass[entry.class] = (byClass[entry.class] || 0) + 1
    byField[entry.field] = byField[entry.field] || {}
    byField[entry.field][entry.class] = (byField[entry.field][entry.class] || 0) + 1
  }
  return { total: manifest.length, byClass, byField }
}

module.exports = {
  CLASSES,
  PRODUCT_ATTR_ALLOWLIST,
  KEEP_BY_DESIGN_FIELDS,
  TYPO_KEYS,
  normalizeText,
  detectDocsMarkup,
  findDisallowedAttrs,
  stripDocsMarkup,
  contentHash,
  deepEqual,
  classifyDescription,
  classifyField,
  classifyPropertyEntry,
  classifyProperties,
  summarize
}
