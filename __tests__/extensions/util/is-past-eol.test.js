const isPastEol = require('../../../extensions/util/is-past-eol')

describe('isPastEol', () => {
  const now = new Date('2030-01-01T00:00:00Z')
  test('page-is-past-eol true wins', () => {
    expect(isPastEol({ 'page-is-past-eol': 'true' }, now)).toBe(true)
  })
  test('an explicit page-is-past-eol of false wins over the date fallback', () => {
    expect(isPastEol({ 'page-is-past-eol': 'false', 'page-release-date': '2020-01-01' }, now)).toBe(false)
    expect(isPastEol({ 'page-is-past-eol': false, 'page-release-date': '2020-01-01' }, now)).toBe(false)
  })
  test('falls back to the release date and support window', () => {
    expect(isPastEol({ 'page-release-date': '2020-01-01' }, now)).toBe(true)
    expect(isPastEol({ 'page-release-date': '2029-06-01' }, now)).toBe(false)
  })
})
