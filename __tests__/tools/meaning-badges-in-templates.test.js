'use strict'

// Every generated reference marks Enterprise, Deprecated, Since vX.Y, and Beta
// with the badge macro, so the docs UI shows each meaning the same way.

const fs = require('fs')
const path = require('path')
const handlebars = require('handlebars')

const root = path.join(__dirname, '..', '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

function propertyTemplate (file) {
  const hb = handlebars.create()
  const helpers = require('../../tools/property-extractor/helpers')
  for (const [name, fn] of Object.entries(helpers)) if (typeof fn === 'function') hb.registerHelper(name, fn)
  return hb.compile(read(`tools/property-extractor/templates/${file}`))
}

const enterpriseProperty = {
  name: 'x',
  version: 'v25.3.1',
  description: 'D.',
  type: 'string',
  enum: ['a', 'b'],
  'x-enum-metadata': { b: { is_enterprise: true } },
  is_enterprise: true,
  enterprise_value: 'b',
  default: 'a',
  defined_in: 'src/v/config/configuration.cc',
}

describe.each(['property.hbs', 'topic-property.hbs'])('%s', (file) => {
  const out = propertyTemplate(file)(enterpriseProperty)

  test('marks Introduced in with a Since badge', () => {
    expect(out).toContain('badge::[label=Since v25.3.1, product=Redpanda]')
    expect(out).not.toContain('Introduced in')
  })

  test('marks Enterprise with a badge, not a NOTE box or a (Enterprise) suffix', () => {
    expect(out).toContain('badge::[label=Enterprise] Enterprise license required: `b`')
    expect(out).toContain('`b` badge::[label=Enterprise]')
    expect(out).not.toContain('(Enterprise)')
    expect(out).not.toContain('.Enterprise license required')
  })

  test('links to the one Self-Managed licensing page', () => {
    expect(out).toContain('xref:get-started:licensing/overview.adoc[Redpanda Licenses and Enterprise Features]')
    expect(out).not.toContain('licensing/index.adoc')
  })
})

describe('rpk command.hbs', () => {
  const src = read('tools/rpk-docs/templates/command.hbs')

  test('marks deprecated flags, introduced commands, and new flags with badges', () => {
    expect(src).toContain('badge::[label=Deprecated]')
    expect(src).toContain('badge::[label=Since {{introducedInVersion}}')
    expect(src).not.toContain('*[Deprecated')
    expect(src).not.toContain('(New in')
    expect(src).not.toContain('NOTE: This command was introduced in')
  })

  test('keeps the deprecated-command warning as an admonition', () => {
    expect(src).toMatch(/\[CAUTION\]\n====\nThis command is deprecated/)
  })
})

describe('Redpanda Connect templates and helpers', () => {
  const renderConnectFields = require('../../tools/redpanda-connect/helpers/renderConnectFields')

  test('a beta field gets a Beta badge with no size override', () => {
    const out = String(renderConnectFields([{ name: 'f', type: 'string', description: 'D.', is_beta: true }]))
    expect(out).toContain('badge::[label=Beta, tooltip={page-beta-text}]')
    expect(out).not.toContain('size=large')
  })

  test('a field with a version gets a Since badge', () => {
    const out = String(renderConnectFields([{ name: 'f', type: 'string', description: 'D.', version: '4.53.0' }]))
    expect(out).toContain('badge::[label=Since 4.53.0, product=Redpanda Connect]')
    expect(out).not.toContain('Requires version')
  })

  test.each(['intro.hbs', 'descriptions-partials.hbs'])('%s marks the version with a Since badge', (file) => {
    const src = read(`tools/redpanda-connect/templates/${file}`)
    expect(src).toContain('badge::[label=Since {{version}}, product=Redpanda Connect]')
    expect(src).not.toContain('Introduced in version')
  })
})

// The help cursor on a badge promises a tooltip, so every badge any macro or
// template emits must carry a non-empty data-tooltip.
describe('every emitted rp-badge has a non-empty data-tooltip', () => {
  const asciidoctor = require('@asciidoctor/core')()
  const badgeMacro = require('../../macros/badge')
  const { buildBadgeHtml } = badgeMacro
  const { buildFeatureTable, parseRegistry } = require('../../macros/enterprise')

  function render (source) {
    const registry = asciidoctor.Extensions.create()
    badgeMacro.register(registry)
    return asciidoctor.convert(source, { extension_registry: registry, safe: 'safe', attributes: { 'page-beta-text': 'Beta text.' } })
  }

  function expectEveryBadgeHasTooltip (html) {
    const badges = html.match(/<(?:span|a)\b[^>]*class="[^"]*\brp-badge\b[^"]*"[^>]*>/g) || []
    expect(badges.length).toBeGreaterThan(0)
    for (const tag of badges) {
      expect(tag).toMatch(/\sdata-tooltip="[^"]*\S[^"]*"/)
    }
  }

  test.each([
    'beta', 'preview', 'limited', 'limited availability', 'deprecated', 'eol', 'end of life',
    'eol soon', 'new', 'enterprise', 'cloud', 'byoc', 'serverless', 'dedicated', 'self-managed',
    'certified', 'community', 'unreleased', 'Since 25.1', 'Kafka API', 'constructor',
  ])('badge macro: %s', (label) => {
    expectEveryBadgeHasTooltip(buildBadgeHtml({ label }))
    expectEveryBadgeHasTooltip(buildBadgeHtml({ label, tooltip: '   ' }))
  })

  test('the contract tooltips for Since, New, and the Cloud tiers', () => {
    expect(buildBadgeHtml({ label: 'Since 25.1', product: 'Redpanda' })).toContain('data-tooltip="Introduced in Redpanda v25.1."')
    expect(buildBadgeHtml({ label: 'new' })).toContain('data-tooltip="New in this release."')
    expect(buildBadgeHtml({ label: 'BYOC' })).toContain('data-tooltip="Available on Redpanda Cloud BYOC clusters."')
    expect(buildBadgeHtml({ label: 'serverless' })).toContain('data-tooltip="Available on Redpanda Cloud Serverless clusters."')
    expect(buildBadgeHtml({ label: 'dedicated' })).toContain('data-tooltip="Available on Redpanda Cloud Dedicated clusters."')
    expect(buildBadgeHtml({ label: 'cloud' })).toContain('data-tooltip="Available in Redpanda Cloud."')
    expect(buildBadgeHtml({ label: 'self-managed' })).toContain('data-tooltip="Available in Self-Managed Redpanda."')
  })

  test('enterprise registry beta and unreleased badges', () => {
    const { features } = parseRegistry([
      'features:',
      '  - name: A',
      '    scope: redpanda',
      '    description: d',
      '    status: beta',
      '  - name: B',
      '    scope: redpanda',
      '    description: d',
      '    status: unreleased',
    ].join('\n'))
    const table = buildFeatureTable(features, 'redpanda', { includeUnreleased: true })
    expectEveryBadgeHasTooltip(table)
    expect(table).toContain('rp-badge--beta')
    expect(table).toContain('badge--unreleased')
  })

  // Every badge:: call in a generator template, with its Handlebars values
  // filled in, rendered the way Antora renders it.
  test.each([
    'tools/property-extractor/templates/property.hbs',
    'tools/property-extractor/templates/topic-property.hbs',
    'tools/rpk-docs/templates/command.hbs',
    'tools/redpanda-connect/templates/intro.hbs',
    'tools/redpanda-connect/templates/descriptions-partials.hbs',
    'tools/redpanda-connect/helpers/renderConnectFields.js',
  ])('%s', (file) => {
    const calls = read(file).match(/badge::\[[^\]\n]*\]/g) || []
    expect(calls.length).toBeGreaterThan(0)
    const source = calls
      .map((call) => call
        .replace(/\{\{#if [^}]*\}\}|\{\{\/if\}\}|\{\{else\}\}/g, '')
        .replace(/\{\{[^}]*[Vv]ersion[^}]*\}\}|\$\{child\.version\}/g, 'v26.1.0')
        .replace(/\{\{[^}]*\}\}/g, 'connect'))
      .join('\n\n')
    expectEveryBadgeHasTooltip(render(source))
  })
})
