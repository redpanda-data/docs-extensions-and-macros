'use strict'

const {
  register,
  buildEnterpriseContent,
  resolveTooltipAttribute,
} = require('../../macros/enterprise')

describe('enterprise macro', () => {
  describe('buildEnterpriseContent', () => {
    const defaults = {
      licensingPage: 'get-started:licensing/overview.adoc',
      role: 'enterprise-feature',
      tooltipAttr: 'title',
      links: true,
    }

    test('links the feature name to the licensing page by default', () => {
      const html = buildEnterpriseContent({ ...defaults, feature: 'Continuous Data Balancing' })
      expect(html).toBe(
        '<span class="enterprise-feature" title="Continuous Data Balancing requires an Enterprise Edition license.">' +
        'xref:get-started:licensing/overview.adoc[Continuous Data Balancing]</span>'
      )
    })

    test('links to the feature doc when an xref attribute is given', () => {
      const html = buildEnterpriseContent({
        ...defaults,
        feature: 'Tiered Storage',
        xref: 'manage:tiered-storage/tiered-storage.adoc',
      })
      expect(html).toContain('xref:manage:tiered-storage/tiered-storage.adoc[Tiered Storage]')
    })

    test('honors display text and tooltip overrides', () => {
      const html = buildEnterpriseContent({
        ...defaults,
        feature: 'Audit Logging',
        text: 'audit logging',
        tooltip: 'Audit Logging needs a license and a SASL listener.',
      })
      expect(html).toContain('[audit logging]')
      expect(html).toContain('title="Audit Logging needs a license and a SASL listener."')
    })

    test('escapes double quotes in tooltip text', () => {
      const html = buildEnterpriseContent({
        ...defaults,
        feature: 'X',
        tooltip: 'Requires a "valid" license.',
      })
      expect(html).toContain('title="Requires a &quot;valid&quot; license."')
    })

    test('renders plain text without a link when links are disabled', () => {
      const html = buildEnterpriseContent({ ...defaults, feature: 'Shadowing', links: false })
      expect(html).not.toContain('xref:')
      expect(html).toContain('>Shadowing</span>')
    })

    test('omits the tooltip when disabled', () => {
      const html = buildEnterpriseContent({ ...defaults, feature: 'Shadowing', tooltipAttr: undefined })
      expect(html).not.toContain('title=')
    })
  })

  describe('resolveTooltipAttribute', () => {
    test.each([
      [undefined, 'title'],
      ['title', 'title'],
      ['true', 'data-enterprise-tooltip'],
      ['data-tooltip', 'data-tooltip'],
      ['false', undefined],
    ])('%s resolves to %s', (input, expected) => {
      expect(resolveTooltipAttribute(input)).toBe(expected)
    })

    test('falls back to title for invalid values', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      expect(resolveTooltipAttribute('sparkles')).toBe('title')
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  describe('registration', () => {
    test('registers an inline macro on a plain registry', () => {
      const inlineMacro = jest.fn()
      register({ inlineMacro })
      expect(inlineMacro).toHaveBeenCalledTimes(1)
      expect(typeof inlineMacro.mock.calls[0][0]).toBe('function')
    })

    test('uses the group form when the registry supports register()', () => {
      const inlineMacro = jest.fn()
      const registry = {
        register (group) {
          group.call({ inlineMacro })
        },
      }
      register(registry)
      expect(inlineMacro).toHaveBeenCalledTimes(1)
    })
  })
})
