'use strict'

const aggregateTerms = require('../../extensions/aggregate-terms')

const term = (name, extra = '') => ({
  path: `modules/terms/partials/${name}.adoc`,
  basename: `${name}.adoc`,
  contents: Buffer.from(`=== ${name}\n:term-name: ${name}\n:hover-text: About ${name}.\n:category: Redpanda core\n${extra}\nBody.\n`),
  src: { component: 'shared', module: 'terms', family: 'partial' },
})

function run (config, files) {
  const listeners = {}
  const logger = { info () {}, warn () {}, error () {} }
  const context = { on (event, fn) { listeners[event] = fn; return context }, getLogger: () => logger, setMaxListeners () {}, getMaxListeners () { return 10 } }
  aggregateTerms.register.call(context, { config })
  const siteCatalog = {}
  listeners.contentAggregated({ siteCatalog, contentAggregate: [{ name: 'shared', files }] })
  const added = []
  const glossary = { src: { component: 'home', version: '', relative: 'glossary.adoc' }, contents: Buffer.from('= Glossary\n'), pub: { url: '/home/glossary/' } }
  const contentCatalog = {
    getComponents: () => [],
    getComponent: (name) => (name === 'shared' ? { latest: { version: '' } } : undefined),
    resolvePage: (id) => (id === 'home:ROOT:glossary.adoc' ? glossary : undefined),
    addFile: (f) => { added.push(f); return f },
  }
  listeners.contentClassified({ siteCatalog, contentCatalog })
  return added
}

describe('aggregate-terms terms.json', () => {
  test('publishes every term to the shared attachments with its glossary URL', () => {
    const added = run({ glossarypage: 'home:ROOT:glossary.adoc' }, [term('broker', ':alt-labels: Redpanda broker\n'), term('topic')])
    expect(added).toHaveLength(1)
    expect(added[0].src).toEqual({ component: 'shared', version: '', module: 'ROOT', family: 'attachment', relative: 'terms.json' })
    const data = JSON.parse(added[0].contents.toString())
    expect(data.schema).toBe(1)
    expect(data.generatedBy).toMatch(/^doc-tools \d/)
    expect(data.terms.map((t) => [t.id, t.url, t.altLabels])).toEqual([
      ['broker', '/home/glossary/#broker', ['Redpanda broker']],
      ['topic', '/home/glossary/#topic', []],
    ])
  })

  test('the glossary page lists a term\'s alt labels', () => {
    const listeners = {}
    const context = { on (event, fn) { listeners[event] = fn; return context }, getLogger: () => ({ info () {}, warn () {}, error () {} }), setMaxListeners () {}, getMaxListeners () { return 10 } }
    aggregateTerms.register.call(context, { config: { glossarypage: 'home:ROOT:glossary.adoc', publishjson: false } })
    const siteCatalog = {}
    listeners.contentAggregated({ siteCatalog, contentAggregate: [{ name: 'shared', files: [term('BYOC', ':alt-labels: Bring Your Own Cloud\n')] }] })
    const glossary = { src: {}, contents: Buffer.from('= Glossary\n') }
    listeners.contentClassified({ siteCatalog, contentCatalog: { getComponents: () => [], resolvePage: (id) => (id === 'home:ROOT:glossary.adoc' ? glossary : undefined) } })
    expect(glossary.contents.toString()).toMatch(/Also called: Bring Your Own Cloud\./)
  })

  test('publishJson: false turns publishing off', () => {
    expect(run({ publishjson: false }, [term('broker')])).toHaveLength(0)
  })

  test('an ambiguous glossary fails the build', () => {
    expect(() => run({}, [term('broker', ':alt-labels: topic\n'), term('topic')])).toThrow(/glossary .* is ambiguous:[\s\S]*alt-label 'topic' of 'broker'/)
  })
})
