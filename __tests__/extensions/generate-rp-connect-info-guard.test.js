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
  it('passes when connector pages, field partials, and description partials are present', () => {
    expect(() => assertConnectReferencePresent(catalog([page('inputs/kafka.adoc'), partial('fields/inputs/kafka.adoc'), partial('descriptions/inputs/kafka.adoc')]))).not.toThrow()
  })
  it('fails when connector pages have fields but no description partials', () => {
    expect(() => assertConnectReferencePresent(catalog([page('inputs/kafka.adoc'), partial('fields/inputs/kafka.adoc')])))
      .toThrow(/components:partial\$descriptions\/\*/)
  })
  it('names both missing sets when neither is present', () => {
    expect(() => assertConnectReferencePresent(catalog([page('inputs/kafka.adoc')])))
      .toThrow(/components:partial\$fields\/\* or components:partial\$descriptions\/\*/)
  })
  it('fails when connector pages have no field partials', () => {
    expect(() => assertConnectReferencePresent(catalog([page('inputs/kafka.adoc'), partial('secret_warning.adoc')])))
      .toThrow(/no generated components:partial\$fields\/\*/)
  })
  it('explains the release asset setup in its error', () => {
    const run = () => assertConnectReferencePresent(catalog([page('inputs/kafka.adoc')]))
    expect(run).toThrow(/redpanda-connect-docs\.tar\.gz/)
    expect(run).toThrow(/`tag`/)
    expect(run).toThrow(/REDPANDA_CONNECT_DOCS_DIR/)
    expect(run).not.toThrow(/Add the connect repository as a content source/)
  })
  it('ignores overview pages, which include no field partials', () => {
    expect(() => assertConnectReferencePresent(catalog([page('about.adoc')]))).not.toThrow()
  })
  it('skips playbooks without the connect component or its pages', () => {
    expect(() => assertConnectReferencePresent(catalog([], ['streaming']))).not.toThrow()
    expect(() => assertConnectReferencePresent(catalog([partial('secret_warning.adoc')]))).not.toThrow()
  })
})
