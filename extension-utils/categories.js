'use strict'

/**
 * Category helpers shared by validate-attributes, the Algolia indexer,
 * generate-index-data, and the solutions catalog.
 *
 * The canonical list lives in the docs repo at
 * shared/modules/ROOT/partials/valid-categories.yml and reaches extensions as
 * the `page-valid-categories` site attribute (see add-global-attributes). Its
 * shape is a list of `{ category, subcategories?: [{ category }] }`.
 */

/**
 * Build fast lookup structures from the valid-categories list.
 *
 * @param {Array<{category: string, subcategories?: Array<{category: string}>}>} validCategories
 * @returns {{categories: Set<string>, subcategories: Set<string>, parentMap: Map<string, string>}}
 *   `categories` holds top-level names, `subcategories` holds subcategory
 *   names, and `parentMap` maps a subcategory to its top-level parent.
 */
function createCategoryMap (validCategories) {
  const categoryMap = {
    categories: new Set(),
    subcategories: new Set(),
    parentMap: new Map(),
  }
  if (!Array.isArray(validCategories)) return categoryMap

  validCategories.forEach((categoryInfo) => {
    if (!categoryInfo || !categoryInfo.category) return
    categoryMap.categories.add(categoryInfo.category)
    if (Array.isArray(categoryInfo.subcategories)) {
      categoryInfo.subcategories.forEach((subcat) => {
        if (!subcat || !subcat.category) return
        categoryMap.subcategories.add(subcat.category)
        categoryMap.parentMap.set(subcat.category, categoryInfo.category)
      })
    }
  })
  return categoryMap
}

/**
 * Split a `page-categories` attribute value into a trimmed list.
 *
 * @param {string|Array<string>|undefined} value
 * @returns {Array<string>}
 */
function parseCategoryList (value) {
  if (Array.isArray(value)) return value.map((c) => String(c).trim()).filter(Boolean)
  if (typeof value !== 'string') return []
  return value.split(',').map((c) => c.trim()).filter(Boolean)
}

/**
 * Normalize a list of authored categories against the valid-categories map.
 *
 * Behaviour matches the historical validate-attributes logic exactly:
 * - a known subcategory keeps its place and its parent is appended if absent
 * - a known top-level category is kept
 * - anything else is dropped and reported in `invalid`
 * Order is the authored order with any added parents appended afterwards.
 *
 * @param {Array<string>} list - authored categories (already split and trimmed)
 * @param {ReturnType<typeof createCategoryMap>} categoryMap
 * @returns {{categories: Array<string>, invalid: Array<string>, parentsAdded: Array<string>}}
 */
function normalizeCategories (list, categoryMap) {
  const adjusted = new Set(Array.isArray(list) ? list : [])
  const invalid = []
  const parentsAdded = []

  ;(Array.isArray(list) ? list : []).forEach((category) => {
    if (categoryMap.subcategories.has(category)) {
      const parent = categoryMap.parentMap.get(category)
      if (parent && !adjusted.has(parent)) {
        adjusted.add(parent)
        parentsAdded.push(parent)
      }
    } else if (!categoryMap.categories.has(category)) {
      adjusted.delete(category)
      invalid.push(category)
    }
  })

  return { categories: Array.from(adjusted), invalid, parentsAdded }
}

module.exports = { createCategoryMap, parseCategoryList, normalizeCategories }
