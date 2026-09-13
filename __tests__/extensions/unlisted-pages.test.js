'use strict'

const { resolveSkipComponents, DEFAULT_SKIP_COMPONENTS } = require('../../extensions/unlisted-pages')

describe('unlisted-pages skip_components', () => {
  test('defaults to api and labs, and always skips solutions', () => {
    expect(DEFAULT_SKIP_COMPONENTS).toEqual(['api', 'labs'])
    expect([...resolveSkipComponents({})].sort()).toEqual(['api', 'labs', 'solutions'])
  })

  test('accepts a list under either key spelling', () => {
    expect([...resolveSkipComponents({ skip_components: ['api'] })].sort()).toEqual(['api', 'solutions'])
    expect([...resolveSkipComponents({ skipComponents: ['docs', ' api '] })].sort()).toEqual(['api', 'docs', 'solutions'])
  })

  test('accepts a comma string and an empty list', () => {
    expect([...resolveSkipComponents({ skip_components: 'a, b' })].sort()).toEqual(['a', 'b', 'solutions'])
    expect([...resolveSkipComponents({ skip_components: [] })]).toEqual(['solutions'])
  })
})
