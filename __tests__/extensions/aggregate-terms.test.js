'use strict'

const asciidoctor = require('@asciidoctor/core')()
const aggregateTerms = require('../../extensions/aggregate-terms')
const glossary = require('../../macros/glossary')

const term = (name, category) => ({
  path: `modules/terms/partials/${name}.adoc`,
  basename: `${name}.adoc`,
  contents: Buffer.from(`=== ${name}\n:term-name: ${name}\n:hover-text: About ${name}.\n:category: ${category}\n\nBody of ${name}.\n`),
  src: { component: 'shared', module: 'terms', family: 'partial', fileUri: name },
})

const page = (component, version, relative, text = '= Glossary\n') => ({
  src: { component, version, module: relative.includes(':') ? relative.split(':')[0] : 'ROOT', relative },
  contents: Buffer.from(text),
})

// Runs the extension's two listeners over a small site: a shared component
// with two terms, and components with or without glossary pages.
function run (config, pages) {
  const listeners = {}
  const logs = []
  const logger = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m]) }
  const context = { on (event, fn) { listeners[event] = fn; return context }, getLogger: () => logger, setMaxListeners () {}, getMaxListeners () { return 10 } }
  aggregateTerms.register.call(context, { config })

  const siteCatalog = {}
  const shared = { name: 'shared', files: [term('broker', 'Redpanda core'), term('pipeline', 'Redpanda Connect')] }
  listeners.contentAggregated({ siteCatalog, contentAggregate: [shared] })

  const components = [
    { versions: [{ name: 'streaming', version: '26.2', title: 'Streaming', asciidoc: { attributes: {} } }] },
    { versions: [{ name: 'connect', version: '', title: 'Connect', asciidoc: { attributes: {} } }] },
    { versions: [{ name: 'home', version: '', title: 'Home', asciidoc: { attributes: {} } }] },
  ]
  const contentCatalog = {
    getComponents: () => components,
    resolvePage: (id) => pages[id],
  }
  listeners.contentClassified({ siteCatalog, contentCatalog })
  const attrs = Object.fromEntries(components.map((c) => [c.versions[0].name, c.versions[0].asciidoc.attributes['glossary-page']]))
  return { attrs, logs }
}

describe('aggregate-terms', () => {
  test('without glossarypage, each component with a glossary links to its own, and others get none', () => {
    const streaming = page('streaming', '26.2', 'reference:glossary.adoc')
    const { attrs } = run({}, { '26.2@streaming:reference:glossary.adoc': streaming })
    expect(attrs).toEqual({ streaming: 'reference:glossary.adoc', connect: undefined, home: undefined })
    expect(streaming.contents.toString()).toMatch(/== Redpanda Connect[\s\S]*=== pipeline[\s\S]*== Redpanda core[\s\S]*=== broker/)
  })

  test('with glossarypage, every component links to the site glossary, which holds every term', () => {
    const site = page('home', '', 'glossary.adoc')
    const streaming = page('streaming', '26.2', 'reference:glossary.adoc')
    const { attrs, logs } = run({ glossarypage: 'home:ROOT:glossary.adoc' }, {
      'home:ROOT:glossary.adoc': site,
      '26.2@streaming:reference:glossary.adoc': streaming,
    })
    expect(attrs).toEqual({ streaming: 'home:ROOT:glossary.adoc', connect: 'home:ROOT:glossary.adoc', home: 'home:ROOT:glossary.adoc' })
    expect(site.contents.toString()).toMatch(/=== broker[\s\S]*/)
    expect(site.contents.toString()).toMatch(/=== pipeline/)
    // A component glossary that still exists stays complete until it is removed.
    expect(streaming.contents.toString()).toMatch(/=== broker/)
    expect(logs.some(([l, m]) => l === 'info' && /site glossary home:ROOT:glossary.adoc/.test(m))).toBe(true)
  })

  test('a missing glossarypage warns and falls back to per-component glossaries', () => {
    const streaming = page('streaming', '26.2', 'reference:glossary.adoc')
    const { attrs, logs } = run({ glossarypage: 'home:ROOT:glossary.adoc' }, { '26.2@streaming:reference:glossary.adoc': streaming })
    expect(attrs).toEqual({ streaming: 'reference:glossary.adoc', connect: undefined, home: undefined })
    expect(logs.some(([l, m]) => l === 'warn' && /home:ROOT:glossary.adoc does not exist/.test(m))).toBe(true)
  })

  test('the glossterm macro links a term to the site glossary from another component', () => {
    const files = [term('pipeline', 'Redpanda Connect')]
    const registry = asciidoctor.Extensions.create()
    glossary.register(registry, {
      contentCatalog: {
        findBy: () => files,
        resolvePage: (id) => (id === 'home:ROOT:glossary.adoc' ? { pub: { url: '/home/glossary/' } } : undefined),
      },
      file: { src: { version: '', component: 'connect' }, pub: { url: '/connect/components/outputs/drop/' } },
      config: { attributes: { 'site-url': 'https://docs.redpanda.com' } },
    })
    const html = asciidoctor.convert(':glossary-page: home:ROOT:glossary.adoc\n\nFrom the glossterm:pipeline[].', { extension_registry: registry })
    expect(html).toContain('href="https://docs.redpanda.com/home/glossary/#pipeline"')
  })
})
