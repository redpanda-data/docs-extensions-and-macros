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
const example = (relative) => ({ src: { component: 'connect', module: 'components', family: 'example', relative } })
// Every generated set a connector page includes.
const complete = () => [
  partial('fields/inputs/kafka.adoc'),
  partial('descriptions/inputs/kafka.adoc'),
  partial('availability/inputs/kafka.adoc'),
  example('common/inputs/kafka.yaml'),
  example('advanced/inputs/kafka.yaml'),
]
const without = (relativePrefix) => complete().filter((f) => !f.src.relative.startsWith(relativePrefix))

describe('assertConnectReferencePresent', () => {
  it('passes when connector pages and every generated set are present', () => {
    expect(() => assertConnectReferencePresent(catalog([page('inputs/kafka.adoc'), ...complete()]))).not.toThrow()
  })
  it('fails when connector pages have fields but no description partials', () => {
    expect(() => assertConnectReferencePresent(catalog([page('inputs/kafka.adoc'), ...without('descriptions/')])))
      .toThrow(/no generated components:partial\$descriptions\/\* files/)
  })
  it('fails when the availability partials are missing', () => {
    expect(() => assertConnectReferencePresent(catalog([page('inputs/kafka.adoc'), ...without('availability/')])))
      .toThrow(/no generated components:partial\$availability\/\* files/)
  })
  it('fails when the common or advanced examples are missing', () => {
    expect(() => assertConnectReferencePresent(catalog([page('inputs/kafka.adoc'), ...without('common/')])))
      .toThrow(/no generated components:example\$common\/\* files/)
    expect(() => assertConnectReferencePresent(catalog([page('inputs/kafka.adoc'), ...without('advanced/')])))
      .toThrow(/no generated components:example\$advanced\/\* files/)
  })
  it('does not count a partial named like an example directory as the examples', () => {
    expect(() => assertConnectReferencePresent(catalog([page('inputs/kafka.adoc'), ...without('common/'), partial('common/x.adoc')])))
      .toThrow(/components:example\$common\/\*/)
  })
  it('names every missing set when none is present', () => {
    expect(() => assertConnectReferencePresent(catalog([page('inputs/kafka.adoc')])))
      .toThrow(/components:partial\$fields\/\* or components:partial\$descriptions\/\* or components:partial\$availability\/\* or components:example\$common\/\* or components:example\$advanced\/\* files/)
  })
  it('mentions a connect content source that is still in the playbook', () => {
    const run = (opts) => () => assertConnectReferencePresent(catalog([page('inputs/kafka.adoc')]), opts)
    expect(run({ connectSources: ['https://github.com/redpanda-data/connect'] })).toThrow(/lists a connect content source \(https:\/\/github\.com\/redpanda-data\/connect\), so no release asset was downloaded/)
    expect(run()).not.toThrow(/lists a connect content source/)
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
