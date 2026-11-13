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
    expect(out).toContain('badge::[label=Since v25.3.1]')
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
    expect(out).toContain('badge::[label=Since 4.53.0]')
    expect(out).not.toContain('Requires version')
  })

  test.each(['intro.hbs', 'descriptions-partials.hbs'])('%s marks the version with a Since badge', (file) => {
    const src = read(`tools/redpanda-connect/templates/${file}`)
    expect(src).toContain('badge::[label=Since {{version}}]')
    expect(src).not.toContain('Introduced in version')
  })
})
