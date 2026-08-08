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
})
