'use strict'

const { formatHelmSpec } = require('../../cli-utils/format-helm-spec')

describe('formatHelmSpec', () => {
  test('renders a local chart dependency repository as literal code', () => {
    // The row helm-docs writes for the Redpanda chart's console subchart.
    // Asciidoctor auto-links a bare file:// URL, publishing a dead link.
    expect(formatHelmSpec('|file://../../console/chart |console |>=3.7.0-0\n')).toBe(
      '|`file://../../console/chart` |console |>=3.7.0-0\n'
    )
  })

  test('leaves a file:// URL that is already code alone', () => {
    const doc = '|`file://../console` |console |>=3.7.0-0\n'
    expect(formatHelmSpec(doc)).toBe(doc)
  })

  test('leaves docs.redpanda.com URLs for the url-to-xref extension to convert', () => {
    const doc = 'See https://docs.redpanda.com/docs/manage/kubernetes/k-manage-resources/[resources].\n'
    expect(formatHelmSpec(doc)).toBe(doc)
  })

  test('turns a bare URL section title into a link macro', () => {
    expect(formatHelmSpec('=== https://example.com/values[values.yaml]\n')).toBe(
      '=== link:++https://example.com/values++[values.yaml]\n'
    )
  })

  test('converts the pandoc heading and description lines', () => {
    expect(formatHelmSpec('== # Redpanda\n== description: A chart.\n')).toBe('= Redpanda\n:description: A chart.\n')
  })

  // Antora resolves page metadata with a header-only parse that stops at the
  // first blank line, so a description below that line is ignored and the page
  // ships the generic site meta description (DOC-2414). Converting the line is
  // not enough; it has to end up in the header.
  test('moves a description below the header up under the title', () => {
    const pandocOutput = [
      '== # Redpanda Helm Spec',
      '',
      '== description: Configure the Redpanda chart.',
      '',
      'Body text here.',
    ].join('\n')

    expect(formatHelmSpec(pandocOutput)).toBe(
      '= Redpanda Helm Spec\n:description: Configure the Redpanda chart.\n\nBody text here.'
    )
  })

  test('leaves a description that is already in the header where it is', () => {
    const doc = '= Redpanda\n:description: A chart.\n\nBody.\n'
    expect(formatHelmSpec(doc)).toBe(doc)
  })

  test('leaves a document with no description untouched', () => {
    const doc = '= Redpanda\n\nBody.\n'
    expect(formatHelmSpec(doc)).toBe(doc)
  })
})
