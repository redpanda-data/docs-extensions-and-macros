'use strict'

const asciidoctor = require('@asciidoctor/core')()
const { buildBadgeHtml, resolveMeaning, DEFAULT_TOOLTIPS } = require('../../macros/badge')
const badgeMacro = require('../../macros/badge')

function convert (source) {
  const registry = asciidoctor.Extensions.create()
  badgeMacro.register(registry)
  return asciidoctor.convert(source, { extension_registry: registry, safe: 'safe' })
}

describe('badge macro', () => {
  // The docs-ui meaning badge, with the older classes on the same element so
  // pages built with an older UI bundle still style it.
  test.each([
    ['beta', 'beta', 'badge--beta', 'Beta'],
    ['Preview', 'preview', 'badge--preview', 'Preview'],
    ['limited', 'limited', 'badge--limited-availability', 'Limited availability'],
    ['limited availability', 'limited', 'badge--limited-availability', 'Limited availability'],
    ['deprecated', 'deprecated', 'badge--deprecated', 'Deprecated'],
    ['eol', 'eol', 'badge--eol', 'End of life'],
    ['new', 'new', 'badge--new', 'New'],
    ['enterprise', 'enterprise', 'badge--enterprise', 'Enterprise'],
    ['cloud', 'cloud', 'badge--cloud', 'Cloud'],
    ['BYOC', 'cloud', 'badge--byoc', 'BYOC'],
    ['self-managed', 'self-managed', 'badge--self-managed', 'Self-Managed'],
    ['Since 25.1', 'since', 'badge--since', 'Since v25.1'],
    ['since v4.53.0', 'since', 'badge--since', 'Since v4.53.0'],
    ['unreleased', 'neutral', 'badge--unreleased', 'Unreleased'],
  ])('%s renders rp-badge--%s with %s and the label %s', (label, name, legacy, text) => {
    const html = buildBadgeHtml({ label })
    expect(html).toMatch(new RegExp(`^<span class="rp-badge rp-badge--${name} badge ${legacy}"`))
    expect(html).toContain(`>${text}</span>`)
  })

  test('labels never carry parentheses', () => {
    for (const label of ['beta', 'enterprise', 'Since 25.1', 'something else']) {
      expect(buildBadgeHtml({ label })).not.toMatch(/>\(.*\)</)
    }
  })

  test('uses data-tooltip, never title, with the standard text', () => {
    const html = buildBadgeHtml({ label: 'enterprise' })
    expect(html).toContain('data-tooltip="Requires an Enterprise Edition license."')
    expect(html).not.toContain('title=')
    expect(buildBadgeHtml({ label: 'beta' })).toContain(`data-tooltip="${DEFAULT_TOOLTIPS.beta}"`)
    expect(buildBadgeHtml({ label: 'deprecated' })).toContain('data-tooltip="Deprecated: still available, but planned for removal."')
  })

  test('a caller tooltip wins over the default', () => {
    expect(buildBadgeHtml({ label: 'beta', tooltip: 'Only in 26.1.' })).toContain('data-tooltip="Only in 26.1."')
  })

  test('size=sm adds rp-badge--sm, size=large keeps the legacy class', () => {
    expect(buildBadgeHtml({ label: 'beta', size: 'sm' })).toContain('class="rp-badge rp-badge--beta rp-badge--sm badge badge--beta"')
    expect(buildBadgeHtml({ label: 'beta', size: 'large' })).toContain('badge--large')
  })

  test('an unknown label is a neutral badge with its own text', () => {
    expect(resolveMeaning('Kafka API')).toEqual({ name: 'neutral', label: 'Kafka API', legacy: 'kafka-api', tooltipKey: 'kafka api' })
  })

  test('renders through Asciidoctor in both macro forms', () => {
    expect(convert('A badge::[label=Since v25.1] here.')).toContain('<span class="rp-badge rp-badge--since badge badge--since" data-tooltip="Introduced in v25.1.">Since v25.1</span>')
    expect(convert('A badge:x[label=deprecated] here.')).toContain('rp-badge--deprecated')
  })
})
