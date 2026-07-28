const { describe, it, expect, beforeEach } = require('@jest/globals')

const extension = require('../../extensions/set-available-attachment-versions.js')

function makeAttachment (component, version, module, relative) {
  return { src: { component, version, module, family: 'attachment', relative } }
}

describe('set-available-attachment-versions extension', () => {
  let mockLogger
  let handlers
  let extensionContext

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }
    handlers = {}
    extensionContext = {
      once: jest.fn((event, handler) => {
        handlers[event] = handler
      }),
      getLogger: jest.fn(() => mockLogger),
    }
  })

  function run (components, attachments) {
    const contentCatalog = {
      getComponents: jest.fn(() => components),
      findBy: jest.fn(({ component, version }) =>
        attachments.filter((a) => a.src.component === component && a.src.version === version)
      ),
    }
    extension.register.call(extensionContext)
    handlers.contentClassified({ contentCatalog })
    return contentCatalog
  }

  it('sets available-properties-tag to the newest properties JSON in the catalog', () => {
    const compVer = {
      version: '26.1',
      asciidoc: { attributes: { 'latest-redpanda-tag': 'v26.1.14' } },
    }
    run(
      [{ name: 'ROOT', versions: [compVer] }],
      [
        makeAttachment('ROOT', '26.1', 'reference', 'redpanda-properties-v26.1.12.json'),
        makeAttachment('ROOT', '26.1', 'reference', 'redpanda-properties-v26.1.13.json'),
        makeAttachment('ROOT', '26.1', 'reference', 'redpanda-properties-v26.1.9.json'),
      ]
    )
    expect(compVer.asciidoc.attributes['available-properties-tag']).toBe('v26.1.13')
    expect(compVer.asciidoc.attributes['page-disable-property-tooltips']).toBeUndefined()
  })

  it('disables property tooltips when a version has no properties JSON', () => {
    const compVer = {
      version: '25.2',
      asciidoc: { attributes: { 'latest-redpanda-tag': 'v25.2.1' } },
    }
    run([{ name: 'ROOT', versions: [compVer] }], [])
    expect(compVer.asciidoc.attributes['available-properties-tag']).toBeUndefined()
    expect(compVer.asciidoc.attributes['page-disable-property-tooltips']).toBe('true')
  })

  it('leaves versions without latest-redpanda-tag untouched', () => {
    const compVer = { version: 'shared', asciidoc: { attributes: {} } }
    run([{ name: 'ROOT', versions: [compVer] }], [])
    expect(compVer.asciidoc.attributes).toEqual({})
  })

  it('does not overwrite an author-pinned available-properties-tag', () => {
    const compVer = {
      version: '26.1',
      asciidoc: {
        attributes: {
          'latest-redpanda-tag': 'v26.1.14',
          'available-properties-tag': 'v26.1.10',
        },
      },
    }
    run(
      [{ name: 'ROOT', versions: [compVer] }],
      [makeAttachment('ROOT', '26.1', 'reference', 'redpanda-properties-v26.1.13.json')]
    )
    expect(compVer.asciidoc.attributes['available-properties-tag']).toBe('v26.1.10')
  })

  it('ignores attachments outside the reference module', () => {
    const compVer = {
      version: '26.1',
      asciidoc: { attributes: { 'latest-redpanda-tag': 'v26.1.14' } },
    }
    run(
      [{ name: 'ROOT', versions: [compVer] }],
      [makeAttachment('ROOT', '26.1', 'console', 'redpanda-properties-v26.1.13.json')]
    )
    expect(compVer.asciidoc.attributes['available-properties-tag']).toBeUndefined()
    expect(compVer.asciidoc.attributes['page-disable-property-tooltips']).toBe('true')
  })

  it('sets available-connect-version to the newest connect JSON, comparing numerically', () => {
    const compVer = {
      version: 'current',
      asciidoc: { attributes: { 'latest-connect-version': '4.102.0' } },
    }
    run(
      [{ name: 'redpanda-connect', versions: [compVer] }],
      [
        makeAttachment('redpanda-connect', 'current', 'components', 'connect-4.100.0.json'),
        makeAttachment('redpanda-connect', 'current', 'components', 'connect-4.99.0.json'),
      ]
    )
    expect(compVer.asciidoc.attributes['available-connect-version']).toBe('4.100.0')
  })

  it('handles missing asciidoc config without throwing', () => {
    const compVer = { version: '26.1' }
    run(
      [{ name: 'streaming', versions: [compVer] }],
      [makeAttachment('streaming', '26.1', 'reference', 'redpanda-properties-v26.1.13.json')]
    )
    expect(compVer.asciidoc.attributes['available-properties-tag']).toBe('v26.1.13')
  })

  it('ignores components that are neither streaming nor connect', () => {
    const compVer = { version: 'main', asciidoc: { attributes: {} } }
    const catalog = run([{ name: 'labs', versions: [compVer] }], [])
    expect(catalog.findBy).not.toHaveBeenCalled()
    expect(compVer.asciidoc.attributes).toEqual({})
  })
})
