'use strict'

const { extractDescription } = require('../../extensions/generate-rp-connect-info.js')

const page = (adoc, attributes) => ({
  asciidoc: attributes ? { attributes } : undefined,
  contents: Buffer.from(adoc, 'utf8')
})

describe('generate-rp-connect-info extractDescription', () => {
  test('returns empty string when no page is available', () => {
    expect(extractDescription(null)).toBe('')
    expect(extractDescription(undefined)).toBe('')
    expect(extractDescription({})).toBe('')
  })

  test('prefers the parsed asciidoc description attribute', () => {
    const src = page('= Kafka\n\ncomponent_type_dropdown::[]\n\nBody paragraph that should be ignored.\n', {
      description: 'Attribute description wins'
    })
    expect(extractDescription(src)).toBe('Attribute description wins')
  })

  test('falls back to an explicit :description: attribute in the raw contents', () => {
    const src = page('= Kafka\n:type: input\n:description: Reads records from Kafka topics.\n\ncomponent_type_dropdown::[]\n\nSomething else.\n')
    expect(extractDescription(src)).toBe('Reads records from Kafka topics.')
  })

  test('extracts the first paragraph after component_type_dropdown::[]', () => {
    const src = page([
      '= Kafka',
      ':type: input',
      '',
      'component_type_dropdown::[]',
      '',
      'Consumes messages from Kafka topics with consumer groups.',
      '',
      '== Fields'
    ].join('\n'))
    expect(extractDescription(src)).toBe('Consumes messages from Kafka topics with consumer groups.')
  })

  test('returns empty string when the page has no component_type_dropdown marker', () => {
    const src = page('= Kafka\n\nJust a paragraph with no dropdown macro in sight, sadly.\n')
    expect(extractDescription(src)).toBe('')
  })

  test('strips xref and URL macros, formatting, and attribute references', () => {
    const src = page([
      '= Kafka',
      '',
      'component_type_dropdown::[]',
      '',
      'Consumes data from xref:components/inputs/kafka.adoc[Apache Kafka] using the *native* `client` with _tuned_ {max-batch} batching.',
      ''
    ].join('\n'))
    expect(extractDescription(src)).toBe('Consumes data from Apache Kafka using the native client with tuned batching.')
  })

  test('converts external links spanning source lines to their text', () => {
    const src = page([
      '= Kafka',
      '',
      'component_type_dropdown::[]',
      '',
      'Streams change events from',
      'https://www.mongodb.com/[MongoDB^] collections into downstream systems.',
      ''
    ].join('\n'))
    expect(extractDescription(src)).toBe('Streams change events from MongoDB collections into downstream systems.')
  })

  test('skips admonition blocks, conditionals, and include directives', () => {
    const src = page([
      '= Kafka',
      '',
      'component_type_dropdown::[]',
      '',
      '[WARNING]',
      '====',
      'Scary warning that must not leak into the description.',
      '====',
      '',
      'ifndef::env-cloud[]',
      'include::partial$deprecated.adoc[]',
      'endif::[]',
      '',
      'The real first paragraph describing the connector behavior.',
      ''
    ].join('\n'))
    expect(extractDescription(src)).toBe('The real first paragraph describing the connector behavior.')
  })

  test('truncates long descriptions at the first sentence boundary', () => {
    const longPara = 'This connector reads a very large number of records from the upstream system and applies a long series of documented transformations before delivery. It also does much more that should be cut.'
    const src = page(`= Kafka\n\ncomponent_type_dropdown::[]\n\n${longPara}\n`)
    expect(extractDescription(src)).toBe('This connector reads a very large number of records from the upstream system and applies a long series of documented transformations before delivery.')
  })

  test('drops the "Introduced in version" suffix', () => {
    const src = page('= Kafka\n\ncomponent_type_dropdown::[]\n\nDoes something useful with streams. Introduced in version 4.53.0.\n')
    expect(extractDescription(src)).toBe('Does something useful with streams')
  })
})
