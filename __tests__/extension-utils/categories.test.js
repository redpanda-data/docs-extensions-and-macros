'use strict'

const { createCategoryMap, parseCategoryList, normalizeCategories } = require('../../extension-utils/categories')

const VALID = [
  { category: 'rpk' },
  {
    category: 'Development',
    subcategories: [{ category: 'Clients' }, { category: 'Stream Processing' }],
  },
  {
    category: 'Deployment',
    subcategories: [{ category: 'Iceberg' }, { category: 'Integration' }],
  },
]

describe('createCategoryMap', () => {
  test('separates top-level categories, subcategories, and parents', () => {
    const map = createCategoryMap(VALID)
    expect([...map.categories]).toEqual(['rpk', 'Development', 'Deployment'])
    expect([...map.subcategories]).toEqual(['Clients', 'Stream Processing', 'Iceberg', 'Integration'])
    expect(map.parentMap.get('Clients')).toBe('Development')
    expect(map.parentMap.get('Iceberg')).toBe('Deployment')
  })

  test('throws a clear error when the list is not an array', () => {
    expect(() => createCategoryMap(undefined)).toThrow(/page-valid-categories must be a list .* got undefined/)
    expect(() => createCategoryMap({ category: 'x' })).toThrow(/got object/)
    expect(() => createCategoryMap(null)).toThrow(/got null/)
  })

  test('skips malformed entries inside a valid list', () => {
    expect(createCategoryMap([null, { nope: true }, { category: 'ok' }]).categories).toEqual(new Set(['ok']))
  })
})

describe('parseCategoryList', () => {
  test('splits on commas and trims', () => {
    expect(parseCategoryList(' Clients ,Iceberg,, ')).toEqual(['Clients', 'Iceberg'])
  })
  test('accepts an array and rejects other types', () => {
    expect(parseCategoryList(['a', ' b '])).toEqual(['a', 'b'])
    expect(parseCategoryList(undefined)).toEqual([])
    expect(parseCategoryList(42)).toEqual([])
  })
})

describe('normalizeCategories', () => {
  const map = createCategoryMap(VALID)

  test('keeps valid categories in authored order', () => {
    const result = normalizeCategories(['Development', 'rpk'], map)
    expect(result).toEqual({ categories: ['Development', 'rpk'], invalid: [], parentsAdded: [] })
  })

  test('adds the missing parent of a subcategory after the authored list', () => {
    const result = normalizeCategories(['Clients', 'Iceberg'], map)
    expect(result.categories).toEqual(['Clients', 'Iceberg', 'Development', 'Deployment'])
    expect(result.parentsAdded).toEqual(['Development', 'Deployment'])
  })

  test('does not add a parent that is already present', () => {
    const result = normalizeCategories(['Development', 'Clients'], map)
    expect(result.categories).toEqual(['Development', 'Clients'])
    expect(result.parentsAdded).toEqual([])
  })

  test('drops unknown categories and reports them', () => {
    const result = normalizeCategories(['Clients', 'Bogus', 'Nope'], map)
    expect(result.categories).toEqual(['Clients', 'Development'])
    expect(result.invalid).toEqual(['Bogus', 'Nope'])
  })

  test('is case sensitive, matching the historical behaviour', () => {
    const result = normalizeCategories(['clients'], map)
    expect(result.categories).toEqual([])
    expect(result.invalid).toEqual(['clients'])
  })

  test('accepts new taxonomy entries without code changes', () => {
    // A future valid-categories.yml adds a top-level category with children;
    // nothing here hardcodes the taxonomy, so it just works.
    const extended = createCategoryMap([
      ...VALID,
      { category: 'Redpanda Connect', subcategories: [{ category: 'Pipelines' }, { category: 'Connectors' }] },
    ])
    expect(extended.parentMap.get('Pipelines')).toBe('Redpanda Connect')
    expect(normalizeCategories(['Connectors', 'Pipelines'], extended)).toEqual({
      categories: ['Connectors', 'Pipelines', 'Redpanda Connect'],
      invalid: [],
      parentsAdded: ['Redpanda Connect'],
    })
    expect(normalizeCategories(['Redpanda Connect'], extended).categories).toEqual(['Redpanda Connect'])
    // and it is still unknown to the old map
    expect(normalizeCategories(['Pipelines'], map).invalid).toEqual(['Pipelines'])
  })

  test('handles a non-array input', () => {
    expect(normalizeCategories(undefined, map)).toEqual({ categories: [], invalid: [], parentsAdded: [] })
  })
})
