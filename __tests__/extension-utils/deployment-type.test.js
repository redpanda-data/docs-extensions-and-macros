'use strict'

const { getDeploymentType } = require('../../extension-utils/deployment-type')

describe('getDeploymentType', () => {
  test('returns empty string for missing or non-object attributes', () => {
    expect(getDeploymentType()).toBe('')
    expect(getDeploymentType(null)).toBe('')
    expect(getDeploymentType('nope')).toBe('')
    expect(getDeploymentType({})).toBe('')
  })

  test.each([
    [{ 'env-kubernetes': true }, 'Kubernetes'],
    [{ 'env-linux': true }, 'Linux'],
    [{ 'env-docker': true }, 'Docker'],
    [{ 'env-cloud': true }, 'Redpanda Cloud'],
    [{ 'page-cloud': true }, 'Redpanda Cloud'],
  ])('maps %j to %s', (attrs, expected) => {
    expect(getDeploymentType(attrs)).toBe(expected)
  })

  test('a bare attribute set to the empty string stays unclassified (historical falsy check)', () => {
    // Antora stores `:env-kubernetes:` with no value as ''. Every copy this
    // helper replaces used a truthiness check, so '' never classified a page.
    expect(getDeploymentType({ 'env-kubernetes': '' })).toBe('')
  })

  test('keeps the historical precedence order', () => {
    expect(getDeploymentType({ 'env-docker': true, 'env-kubernetes': true })).toBe('Kubernetes')
    expect(getDeploymentType({ 'env-docker': true, 'env-linux': true })).toBe('Linux')
    expect(getDeploymentType({ 'page-cloud': true, 'env-docker': true })).toBe('Docker')
  })
})
