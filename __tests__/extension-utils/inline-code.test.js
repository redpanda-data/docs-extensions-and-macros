'use strict'

const { formatInlineCode, codeSpans, CODE_TOKEN_PATTERNS } = require('../../extension-utils/inline-code')
const common = require('../../tools/lint-strings/rules/common')

describe('formatInlineCode', () => {
  test('the lint rule and the formatter share one set of patterns', () => {
    expect(common.CODE_TOKEN_PATTERNS).toBe(CODE_TOKEN_PATTERNS)
    expect(CODE_TOKEN_PATTERNS.map((p) => p.id)).toEqual(['identifier', 'flag', 'path'])
  })

  test('a flag wildcard is one span, and a flag inside a longer token is left alone', () => {
    expect(formatInlineCode('Choose the store with the --cloud-secrets-* flags')).toBe('Choose the store with the `--cloud-secrets-*` flags')
    expect(formatInlineCode('Pass --a/--b or --c.')).toBe('Pass --a/--b or `--c`.')
  })

  test('leaves AsciiDoc tables alone, whose column styles set the formatting', () => {
    const table = '[cols="1m,1a"]\n|===\n|Value |Description\n\n|in_progress |The balancer runs.\n|===\n'
    expect(formatInlineCode(`Before in_progress.\n\n${table}\nAfter in_progress.`)).toBe(`Before \`in_progress\`.\n\n${table}\nAfter \`in_progress\`.`)
  })

  test('wraps each token kind', () => {
    expect(formatInlineCode('Defaults to default_topic_partitions.')).toBe('Defaults to `default_topic_partitions`.')
    expect(formatInlineCode('Pass --tolerate-data-loss to continue.')).toBe('Pass `--tolerate-data-loss` to continue.')
    expect(formatInlineCode('Reads /etc/redpanda/redpanda.yaml, then /v1/brokers.')).toBe('Reads `/etc/redpanda/redpanda.yaml`, then `/v1/brokers`.')
    expect(formatInlineCode('Served at https://example.com/a_b/c.')).toBe('Served at `https://example.com/a_b/c`.')
  })

  test('a dotted key with a snake_case segment is one span', () => {
    expect(formatInlineCode('Set redpanda.cluster_id or rpk.admin_api.addresses first.'))
      .toBe('Set `redpanda.cluster_id` or `rpk.admin_api.addresses` first.')
  })

  test('keeps --flag=value in one span, commas inside the value included', () => {
    expect(formatInlineCode('Use --format=json, or --d=y.')).toBe('Use `--format=json`, or `--d=y`.')
    expect(formatInlineCode('Pass --additional-controllers=a,b to enable them.')).toBe('Pass `--additional-controllers=a,b` to enable them.')
    expect(formatInlineCode('Not -- alone.')).toBe('Not -- alone.')
  })

  test('limits itself to the requested kinds', () => {
    expect(formatInlineCode('Set cluster_id with --id at /a/b.', { kinds: ['identifier'] })).toBe('Set `cluster_id` with --id at /a/b.')
    expect(formatInlineCode('See https://example.com/x.', { kinds: ['flag'] })).toBe('See https://example.com/x.')
  })

  test('never double-wraps: formatting twice changes nothing', () => {
    const once = formatInlineCode('Set default_topic_partitions with --partitions=3 from /etc/redpanda/x.yaml.')
    expect(formatInlineCode(once)).toBe(once)
    expect(formatInlineCode('Already `default_topic_partitions` and `--flag`.')).toBe('Already `default_topic_partitions` and `--flag`.')
  })

  test('skips text in links', () => {
    for (const text of [
      'See xref:reference:cluster_properties.adoc[the default_topic_partitions property].',
      'See [the docs](/docs/cluster_properties) for more.',
      'See https://example.com/a_b[the my_label page].',
      'See <<field_paths,the field_paths section>>.',
      'Jump to [[field_paths]] here.'
    ]) {
      expect(formatInlineCode(text)).toBe(text)
    }
  })

  test('leaves docs site URLs bare, since they become xrefs', () => {
    expect(formatInlineCode('See https://docs.redpanda.com/current/x/.')).toBe('See https://docs.redpanda.com/current/x/.')
  })

  test('skips code blocks', () => {
    expect(formatInlineCode('```\nfoo_bar --x\n```\nThen bar_baz.')).toBe('```\nfoo_bar --x\n```\nThen `bar_baz`.')
    expect(formatInlineCode('----\nfoo_bar\n----\n')).toBe('----\nfoo_bar\n----\n')
  })

  test('wraps only whole tokens, so every span renders', () => {
    for (const text of [
      'topic:partition_id (repeatable)',
      '(approval_policy=on-request)',
      'For disk, it is \'seastar::dma_read\'.',
      'Set "enable_sasl: true" here.',
      'Escaped {topic_name} and \\{my_var}.',
      'Prefixes us./eu./apac./global. are supported.'
    ]) {
      expect(formatInlineCode(text)).toBe(text)
    }
  })

  test('codeSpans reports kinds in text order without overlap', () => {
    expect(codeSpans('/var/lib/redpanda_data and cluster_id', ['identifier', 'path']).map((s) => s.kind)).toEqual(['path', 'identifier'])
  })
})
