'use strict'

const { classifyNames, convertLine, convertDocument } = require('../../tools/migrate-property-refs')

const PROPERTIES = {
  properties: {
    cloud_storage_enabled: {},
    fips_mode: {},
    'redpanda.iceberg.mode': {},
    admin: {},
    rack: {},
  },
}

const { convertible } = classifyNames(PROPERTIES)

describe('migrate-property-refs', () => {
  describe('classifyNames', () => {
    test('separates convertible names from ambiguous separator-free names', () => {
      const result = classifyNames(PROPERTIES)
      expect(result.convertible.has('cloud_storage_enabled')).toBe(true)
      expect(result.convertible.has('redpanda.iceberg.mode')).toBe(true)
      expect(result.convertible.has('admin')).toBe(false)
      expect(result.ambiguous.sort()).toEqual(['admin', 'rack'])
    })
  })

  describe('convertLine', () => {
    test('converts a known backticked property', () => {
      const result = convertLine('Set `cloud_storage_enabled` to `true`.', convertible)
      expect(result.line).toBe('Set prop:cloud_storage_enabled[] to `true`.')
      expect(result.count).toBe(1)
    })

    test('never converts ambiguous names', () => {
      const result = convertLine('The `admin` listener and the `rack` field.', convertible)
      expect(result.count).toBe(0)
    })

    test('leaves unknown backticked terms alone', () => {
      const result = convertLine('Use `kubectl` with `some_other_flag`.', convertible)
      expect(result.count).toBe(0)
    })

    test('converts multiple mentions on one line', () => {
      const result = convertLine('`cloud_storage_enabled` requires `fips_mode` off.', convertible)
      expect(result.line).toBe('prop:cloud_storage_enabled[] requires prop:fips_mode[] off.')
      expect(result.count).toBe(2)
    })

    test('skips mentions inside another macro payload', () => {
      const result = convertLine('See xref:page.adoc[`cloud_storage_enabled` docs] for details.', convertible)
      expect(result.count).toBe(0)
    })

    test('converts after a closed macro payload on the same line', () => {
      const result = convertLine('See xref:page.adoc[docs] and set `fips_mode`.', convertible)
      expect(result.line).toContain('prop:fips_mode[]')
    })

    test('handles dotted names', () => {
      const result = convertLine('Enable `redpanda.iceberg.mode` on the topic.', convertible)
      expect(result.line).toContain('prop:redpanda.iceberg.mode[]')
    })
  })

  describe('convertDocument', () => {
    test('skips listing, literal, comment, and fenced blocks', () => {
      const doc = [
        'Prose `fips_mode` converts.',
        '----',
        'code `fips_mode` stays',
        '----',
        '....',
        'literal `fips_mode` stays',
        '....',
        '////',
        'comment `fips_mode` stays',
        '////',
        '```',
        'fenced `fips_mode` stays',
        '```',
        'More prose `fips_mode` converts.',
      ].join('\n')
      const result = convertDocument(doc, convertible)
      expect(result.count).toBe(2)
      expect(result.content).toContain('code `fips_mode` stays')
      expect(result.content).toContain('literal `fips_mode` stays')
      expect(result.content).toContain('comment `fips_mode` stays')
      expect(result.content).toContain('fenced `fips_mode` stays')
    })

    test('skips headings, attribute entries, and block titles', () => {
      const doc = [
        '== The `fips_mode` heading',
        ':some-attr: `fips_mode`',
        '.A `fips_mode` block title',
        'Prose `fips_mode` converts.',
      ].join('\n')
      const result = convertDocument(doc, convertible)
      expect(result.count).toBe(1)
      expect(result.content).toContain('== The `fips_mode` heading')
      expect(result.content).toContain('Prose prop:fips_mode[] converts.')
    })

    test('converts inside table cells', () => {
      const doc = ['|===', '| `cloud_storage_enabled` | Enables it', '|==='].join('\n')
      const result = convertDocument(doc, convertible)
      expect(result.count).toBe(1)
      expect(result.content).toContain('| prop:cloud_storage_enabled[] | Enables it')
    })
  })
})
