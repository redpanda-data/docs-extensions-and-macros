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

    // The two branches in register() exist because the Extensions module and a
    // registry expose different APIs. Pin that shape against the real library
    // so the assumption cannot drift with an @asciidoctor/core upgrade.
    test('the real Extensions module exposes register() but not block()', () => {
      expect(typeof asciidoctor.Extensions.block).toBe('undefined')
      expect(typeof asciidoctor.Extensions.register).toBe('function')
    })

    test('registers through an Extensions-like module that has only register()', () => {
      // Shape of Asciidoctor.Extensions: no .block(), and the callback passed
      // to .register() runs with a real registry as `this`. Without the
      // register() branch this target is unusable and the call throws.
      const innerRegistry = { block: jest.fn(() => {}) }
      const extensionsModule = {
        register: jest.fn(function (callback) { callback.call(innerRegistry) }),
      }
      expect(() => macro.register.call(extensionsModule)).not.toThrow()
      expect(extensionsModule.register).toHaveBeenCalled()
      expect(innerRegistry.block).toHaveBeenCalled()
    })

    test('throws a named error when the target is neither a registry nor Extensions', () => {
      expect(() => macro.register({}, {})).toThrow(/iceberg-explorer/)
    })
  })

  describe('mount contract', () => {
    // Asciidoctor turns an unrecognized block style into a CSS class, so a site
    // whose playbook forgot this macro still renders a div named after the
    // block. If docs-ui hydrated on that class name, the accident would look
    // like a working explorer full of built-in sample data while the author's
    // JSON body was silently discarded. The mount contract therefore has to be
    // something only this macro can emit.
    test('an unregistered [iceberg-explorer] block cannot pass for a mount point', () => {
      const source = '[iceberg-explorer]\n--\n--'
      // No extension registry: this is what a consumer repo that added the
      // block but forgot the playbook entry actually publishes.
      const accidental = asciidoctor.convert(source)
      expect(accidental).toContain('class="openblock iceberg-explorer"')
      expect(accidental).not.toContain(macro.MOUNT_ATTRIBUTE)
      expect(accidental).not.toContain(macro.MOUNT_CLASS)

      const mounted = convert(source)
      expect(mounted).toContain(`${macro.MOUNT_ATTRIBUTE}="${macro.MOUNT_CONTRACT_VERSION}"`)
      expect(mounted).toContain(`class="${macro.MOUNT_CLASS}"`)
    })

    test('the mount selector keys on an attribute, not on a class name', () => {
      expect(macro.MOUNT_SELECTOR).toBe(`[${macro.MOUNT_ATTRIBUTE}]`)
      expect(macro.MOUNT_ATTRIBUTE.startsWith('data-')).toBe(true)
    })
  })

  describe('rendering', () => {
    test('emits a hydration mount point for an empty open block', () => {
      const html = convert('[iceberg-explorer]\n--\n--')
      expect(html).toContain(`class="${macro.MOUNT_CLASS}"`)
      expect(html).toContain(`${macro.MOUNT_ATTRIBUTE}="1"`)
    })

    // The failure readers actually hit is JS running fine with the docs-ui
    // explorer module missing, which suppresses <noscript> and leaves a
    // zero-height void. The fallback has to be plain, visible markup.
    test('renders a visible fallback that does not depend on JavaScript', () => {
      const html = convert('[iceberg-explorer]\n--\n--')
      expect(html).not.toContain('<noscript>')
      expect(html).toContain('class="iceberg-explorer-fallback"')
      expect(html).toMatch(/docs-ui build that includes the explorer module/)
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

    // Every string below is author-controlled and lands inside a double-quoted
    // HTML attribute, so each interpolation point needs its own assertion. The
    // JSON-body path was the only one covered.
    test('escapes a config attribute that tries to break out of the attribute', () => {
      const html = convert('[iceberg-explorer,config="a\\" onmouseover=\\"x"]\n--\n--')
      expect(html).toContain('data-config="a&quot; onmouseover=&quot;x"')
      expect(html).not.toContain('onmouseover="')
    })

    test('escapes a page version that tries to break out of the attribute', () => {
      const html = convert('[iceberg-explorer]\n--\n--', { 'page-version': '1" onload="x' })
      expect(html).toContain('data-version="1&quot; onload=&quot;x"')
      expect(html).not.toContain('onload="')
    })

    test('ignores an invalid JSON body but still renders the mount point', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const html = convert('[iceberg-explorer]\n----\nnot json\n----')
      expect(html).toContain(`class="${macro.MOUNT_CLASS}"`)
      expect(html).not.toContain('data-defaults=')
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
  })
})
