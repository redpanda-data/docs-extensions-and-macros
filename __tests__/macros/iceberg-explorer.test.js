'use strict'

const asciidoctor = require('@asciidoctor/core')()
const macro = require('../../macros/iceberg-explorer.js')

function convert (input, attributes = {}) {
  const registry = asciidoctor.Extensions.create()
  macro.register(registry, {})
  return asciidoctor.convert(input, {
    extension_registry: registry,
    attributes,
  })
}

describe('iceberg-explorer macro', () => {
  describe('registration', () => {
    test('exports a register function', () => {
      expect(typeof macro.register).toBe('function')
    })

    test('registers a block without errors given a valid registry', () => {
      const mockRegistry = {
        block: jest.fn(() => {}),
        register: jest.fn(callback => callback.call(mockRegistry)),
      }
      expect(() => macro.register(mockRegistry, {})).not.toThrow()
      expect(mockRegistry.block).toHaveBeenCalled()
    })

    test('supports the this-based calling convention (registry as this)', () => {
      // docs-ui preview calls register.call(Extensions) with no arguments.
      const mockRegistry = { block: jest.fn(() => {}) }
      expect(() => macro.register.call(mockRegistry)).not.toThrow()
      expect(mockRegistry.block).toHaveBeenCalled()
    })
  })

  describe('rendering', () => {
    test('emits a hydration mount point for an empty open block', () => {
      const html = convert('[iceberg-explorer]\n--\n--')
      expect(html).toContain('class="iceberg-explorer"')
      // Container is a mount point only: no controls are rendered server-side.
      expect(html).toContain('<noscript>')
    })

    test('stamps the doc version onto the mount point', () => {
      const html = convert('[iceberg-explorer]\n--\n--', { 'page-version': '26.2' })
      expect(html).toContain('data-version="26.2"')
    })

    test('omits data-version when no version attribute is set', () => {
      const html = convert('[iceberg-explorer]\n--\n--')
      expect(html).not.toContain('data-version=')
    })

    test('passes an initial config from a named attribute', () => {
      const html = convert('[iceberg-explorer,config="key:mode=binary;value:mode=binary"]\n--\n--')
      expect(html).toContain('data-config="key:mode=binary;value:mode=binary"')
    })

    test('embeds valid JSON block-body defaults as an escaped attribute', () => {
      const body = JSON.stringify({ config: 'value:mode=schema_latest' })
      const html = convert(`[iceberg-explorer]\n----\n${body}\n----`)
      expect(html).toContain('data-defaults=')
      // JSON quotes must be attribute-escaped, never raw, to keep valid HTML.
      expect(html).toContain('&quot;')
      expect(html).not.toContain('data-defaults="{"')
    })

    test('ignores an invalid JSON body but still renders the mount point', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const html = convert('[iceberg-explorer]\n----\nnot json\n----')
      expect(html).toContain('class="iceberg-explorer"')
      expect(html).not.toContain('data-defaults=')
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
  })
})
