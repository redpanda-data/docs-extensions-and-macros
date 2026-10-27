'use strict'

// prop.js logs through @antora/logger rather than console.warn -- see the
// same note in __tests__/macros/prop.test.js.
jest.mock('@antora/logger', () => {
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const getLogger = () => logger
  getLogger.configure = () => getLogger
  return getLogger
})

const extension = require('../../extensions/property-page-index')
const { register } = require('../../macros/prop')

const PROPERTIES_JSON = JSON.stringify({
  properties: {
    enable_transactions: { name: 'enable_transactions', config_scope: 'cluster' },
  },
})

function makeCatalog () {
  const files = [
    {
      src: { component: 'streaming', version: 'current', module: 'reference', family: 'attachment', relative: 'redpanda-properties-v26.2.1.json' },
      contents: Buffer.from(PROPERTIES_JSON),
    },
    {
      src: { component: 'streaming', version: 'current', module: 'reference', family: 'partial', relative: 'properties/cluster-properties.adoc' },
      contents: Buffer.from('=== enable_transactions\nEnables transactions.\n'),
    },
    {
      src: { component: 'streaming', version: 'current', module: 'reference', family: 'page', relative: 'properties/cluster-properties.adoc' },
      contents: Buffer.from('include::reference:partial$properties/cluster-properties.adoc[tags=!deprecated]'),
    },
  ]
  return {
    files,
    findBy: (query) => files.filter((f) => Object.entries(query).every(([k, v]) => f.src[k] === v)),
    getComponents: () => [{ name: 'streaming', versions: [{ version: 'current' }] }],
  }
}

function runExtension (contentCatalog) {
  const context = {
    handlers: {},
    getLogger: () => ({ info: () => {}, debug: () => {} }),
    once (event, handler) { this.handlers[event] = handler },
  }
  extension.register.call(context)
  context.handlers.contentClassified({ contentCatalog })
}

function convert (input, catalog) {
  const Asciidoctor = require('@asciidoctor/core')()
  const extensionRegistry = Asciidoctor.Extensions.create()
  register(extensionRegistry, {
    contentCatalog: catalog,
    file: { src: { path: 'modules/develop/pages/transactions.adoc', component: 'streaming', version: 'current', module: 'develop' } },
  })
  return Asciidoctor.convert(input, { extension_registry: extensionRegistry })
}

describe('property-page-index extension', () => {
  test('links resolve even when the reference page has already converted to HTML', () => {
    const catalog = makeCatalog()
    // Warm the index while sources are raw (what contentClassified guarantees).
    runExtension(catalog)
    // Simulate Antora converting the reference page before this document:
    // its contents are now HTML and its include:: lines are gone.
    catalog.files[2].contents = Buffer.from('<article><h3>enable_transactions</h3></article>')
    const html = convert('prop:enable_transactions[link=true]', catalog)
    expect(html).toContain('cluster-properties')
    expect(html).toContain('data-property-name="enable_transactions"')
  })

  test('without the extension, the lazy path warns about mid-conversion indexing', () => {
    const catalog = makeCatalog()
    catalog.files[2].contents = Buffer.from('<article><h3>enable_transactions</h3></article>')
    const warn = jest.spyOn(require('@antora/logger')(), 'warn').mockImplementation(() => {})
    convert('prop:enable_transactions[link=true]', catalog)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('after conversion started'))
    warn.mockRestore()
  })
})
