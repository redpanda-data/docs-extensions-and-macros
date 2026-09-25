const { describe, it, expect } = require('@jest/globals')
const { assertConnectReferencePresent } = require('../../extensions/generate-rp-connect-info.js')

// A minimal content catalog with findBy over a list of files.
function catalog (files, components = ['connect']) {
  return {
    getComponents: () => components.map((name) => ({ name })),
    findBy: (q) => files.filter((f) => Object.entries(q).every(([k, v]) => f.src[k] === v)),
  }
}
const page = (relative) => ({ src: { component: 'connect', module: 'components', family: 'page', relative } })
const partial = (relative) => ({ src: { component: 'connect', module: 'components', family: 'partial', relative } })

describe('assertConnectReferencePresent', () => {
  it('passes when connector pages and field partials are both present', () => {
    expect(() => assertConnectReferencePresent(catalog([page('inputs/kafka.adoc'), partial('fields/inputs/kafka.adoc')]))).not.toThrow()
  })
  it('fails when connector pages have no field partials', () => {
    expect(() => assertConnectReferencePresent(catalog([page('inputs/kafka.adoc'), partial('secret_warning.adoc')])))
      .toThrow(/no generated field partials/)
  })
  it('skips playbooks without the connect component or its pages', () => {
    expect(() => assertConnectReferencePresent(catalog([], ['streaming']))).not.toThrow()
    expect(() => assertConnectReferencePresent(catalog([partial('secret_warning.adoc')]))).not.toThrow()
  })
})
