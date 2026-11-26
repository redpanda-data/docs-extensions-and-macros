'use strict'

const warnings = []
jest.mock('@antora/logger', () => () => ({
  warn: (...args) => warnings.push(args),
  info () {}, debug () {}, error () {},
}))

const asciidoctor = require('@asciidoctor/core')()
const glossary = require('../../macros/glossary')

const termFile = (name, extra = '') => ({
  path: `modules/terms/partials/${name}.adoc`,
  contents: Buffer.from(`=== ${name}\n:term-name: ${name}\n:hover-text: About ${name}.\n${extra}\nBody.\n`),
  src: { component: 'shared', module: 'terms', family: 'partial', fileUri: name },
})

function convert (source, files, attributes = { 'glossary-tooltip': 'data-tippy-content' }) {
  const registry = asciidoctor.Extensions.create()
  glossary.register(registry, {
    contentCatalog: { findBy: () => files, resolvePage: () => undefined },
    file: { src: { version: '1.0', component: 'streaming', module: 'manage', relative: 'page.adoc' }, pub: { url: '/current/page.html' } },
    config: { attributes: {} },
  })
  return asciidoctor.convert(source, { extension_registry: registry, attributes })
}

beforeEach(() => { warnings.length = 0 })

describe('glossterm targets', () => {
  test('a target with no glossary entry and no definition warns once per page, with the file', () => {
    const html = convert('glossterm:widget[] and glossterm:widget[] again.', [termFile('broker')])
    expect(html).toMatch(/widget not yet defined/)
    expect(warnings).toHaveLength(1)
    expect(warnings[0][0]).toEqual({ file: expect.objectContaining({ relative: 'page.adoc' }) })
    expect(warnings[0][1]).toMatch(/glossterm:widget\[\] has no glossary entry/)
  })

  test('an inline definition is not a warning', () => {
    convert('glossterm:widget[A small part.]', [termFile('broker')])
    expect(warnings).toHaveLength(0)
  })

  test('an alt label or a different case resolves to the term, with its definition', () => {
    const html = convert('glossterm:Redpanda broker[] and glossterm:Broker[]', [termFile('broker', ':alt-labels: Redpanda broker\n')])
    expect(warnings).toHaveLength(0)
    expect(html.match(/About broker\./g)).toHaveLength(2)
    expect(html).toMatch(/>Redpanda broker</)
  })
})
