'use strict'

/**
 * validate-attributes' taxonomy pass, kept apart from the extension so its
 * legacy check stays as it was. The rules themselves are
 * extension-utils/metadata-check.js, the same ones `doc-tools check-metadata`
 * runs on a PR.
 */

const { checkPageMetadata, CATEGORY_ATTRIBUTE, TOPIC_TYPE_ATTRIBUTE } = require('./metadata-check')
const { normalizeKey } = require('./taxonomy')

// Components whose pages are not Product Docs, so validate-attributes leaves
// their categories to the legacy check alone. labs is retiring as it is, and
// solutions-catalog checks solution metadata itself (and writes the legacy
// list back onto every solution page before this runs).
const TAXONOMY_SKIPPED_COMPONENTS = ['labs', 'solutions']

function createTaxonomyReport () {
  return new Map()
}

/**
 * Run the metadata rules on a Product Docs page and return the page-categories
 * list the legacy check should see.
 *
 * - A legacy value (one valid-categories.yml lists) passes through unchanged,
 *   so page-categories, and the Algolia `categories` built from it, stay
 *   exactly what they were.
 * - A value only the taxonomy knows (a new label such as Iceberg Topics) is
 *   replaced by the legacy label of the concept it resolves to, or dropped
 *   when there is none. It is not an invalid category.
 * - A value neither knows passes through, so the legacy check warns about it
 *   per page exactly as before; the report leaves it to that warning.
 *
 * Findings go into `report`, which logTaxonomyReport prints once per value.
 *
 * @returns {Array<string>} the list for the legacy check (unchanged for a skipped component)
 */
function checkTaxonomy (list, { taxonomy, categoryMap, page, report }) {
  const component = page.src && page.src.component
  if (TAXONOMY_SKIPPED_COMPONENTS.includes(component)) return list
  const { isLegacy } = legacyIndex(categoryMap)
  const attrs = page.asciidoc.attributes
  // What the author wrote, before validate-attributes adds legacy parents:
  // this is the list the taxonomy resolves (see authoredCategories). A page
  // with no categories (checked only for its content type) gets none.
  if (list.length) attrs['page-categories-authored'] = list.join(', ')
  const where = [component, page.src && page.src.module, (page.src && page.src.relative) || attrs['page-relative-src-path']].filter(Boolean).join(':')

  const findings = checkPageMetadata(
    { [CATEGORY_ATTRIBUTE]: list, [TOPIC_TYPE_ATTRIBUTE]: attrs[TOPIC_TYPE_ATTRIBUTE] },
    { taxonomy, solution: false, isLegacyCategory: isLegacy }
  )
  for (const f of findings) {
    if (f.rule === 'unknown-value') continue // the legacy check's per-page warning covers it
    const key = `${f.rule}\u0000${f.attribute}\u0000${f.value}`
    if (!report.has(key)) report.set(key, { finding: f, pages: [] })
    report.get(key).pages.push(where)
  }

  return toLegacyCategories(list, { taxonomy, categoryMap })
}

// Legacy lookups per category map, built once per build rather than per page.
const legacyIndexes = new WeakMap()

/**
 * Lookups over valid-categories.yml: exact membership, and the legacy
 * spelling of a label by lookup key, so a value that differs from its legacy
 * label only in case (the use case 'Disaster recovery' and the old category
 * 'Disaster Recovery') maps to the legacy spelling, not a deprecated sibling.
 */
function legacyIndex (categoryMap) {
  let index = legacyIndexes.get(categoryMap)
  if (index) return index
  const byKey = new Map()
  for (const label of [...categoryMap.categories.keys(), ...categoryMap.subcategories.keys()]) {
    if (!byKey.has(normalizeKey(label))) byKey.set(normalizeKey(label), label)
  }
  index = {
    isLegacy: (label) => categoryMap.categories.has(label) || categoryMap.subcategories.has(label),
    legacyFor: (label) => byKey.get(normalizeKey(label)),
  }
  legacyIndexes.set(categoryMap, index)
  return index
}

/**
 * The legacy page-categories list for a list that may hold new labels. The
 * one mapping both validate-attributes (Product Docs pages) and
 * solutions-catalog (solution overviews) use:
 *
 * - A legacy value (one valid-categories.yml lists) passes through unchanged.
 * - A value that is a legacy label in another case becomes that label.
 * - A value only the taxonomy knows becomes the legacy label of the concept it
 *   resolves to, or is dropped when there is none.
 * - A value neither knows passes through, for the legacy check to reject.
 *
 * @returns {Array<string>}
 */
function toLegacyCategories (list, { taxonomy, categoryMap }) {
  const { isLegacy, legacyFor } = legacyIndex(categoryMap)
  const out = []
  const keep = (label) => {
    if (!out.includes(label)) out.push(label)
  }
  for (const value of list || []) {
    if (isLegacy(value)) {
      keep(value)
      continue
    }
    const sameLegacy = legacyFor(value)
    const resolved = taxonomy.resolve(value)
    if (sameLegacy && resolved && !resolved.deprecated) {
      keep(sameLegacy)
      continue
    }
    if (!resolved) {
      keep(value)
      continue
    }
    for (const id of resolved.ids) {
      const legacy = taxonomy.legacyLabel(id, (label) => Boolean(legacyFor(label)))
      const spelled = legacy && legacyFor(legacy)
      if (spelled) keep(spelled)
    }
  }
  return out
}

/**
 * One warning per value rather than one per page: deprecated values are on
 * hundreds of pages until they are rewritten, and a per-page line would bury
 * every other warning in the build. Nothing here fails the build.
 */
function logTaxonomyReport (report, logger) {
  const sample = (pages) => pages.slice(0, 3).join(', ') + (pages.length > 3 ? `, and ${pages.length - 3} more` : '')
  for (const { finding, pages } of report.values()) {
    logger.warn(`${finding.message} (${pages.length} page${pages.length === 1 ? '' : 's'}): ${sample(pages)}`)
  }
}

module.exports = { TAXONOMY_SKIPPED_COMPONENTS, checkTaxonomy, toLegacyCategories, createTaxonomyReport, logTaxonomyReport }
