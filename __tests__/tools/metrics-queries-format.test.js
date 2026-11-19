'use strict'

/**
 * The .promql example file: one query inside a `query` tag, test settings in
 * comment lines outside it. A page includes only the tag, so everything
 * outside it has to be a setting the checker understands. Each way a file can
 * be wrong has a test here, next to the good file it differs from.
 */

const { parseQueryFile, findPlaceholders } = require('../../tools/metrics-queries/query-file')

const file = (...lines) => `${lines.join('\n')}\n`
const GOOD = file(
  '# expect: series',
  '# tag::query[]',
  'redpanda_cluster_health_unhealthy_reasons',
  '  and on(instance)',
  '    redpanda_raft_leader_for{redpanda_namespace="redpanda",redpanda_topic="controller",redpanda_partition="0"} == 1',
  '# end::query[]'
)

describe('a good query file', () => {
  it('gives the query as readers see it, and the settings', () => {
    const parsed = parseQueryFile(GOOD)
    expect(parsed.errors).toEqual([])
    expect(parsed.query).toBe([
      'redpanda_cluster_health_unhealthy_reasons',
      '  and on(instance)',
      '    redpanda_raft_leader_for{redpanda_namespace="redpanda",redpanda_topic="controller",redpanda_partition="0"} == 1'
    ].join('\n'))
    expect(parsed.resolved).toBe(parsed.query)
    expect(parsed.settings).toEqual({ expect: 'series', set: {}, skipRun: null, extraLabels: [], exporter: null })
  })

  it('defaults expect to series', () => {
    const parsed = parseQueryFile(file('# tag::query[]', 'up', '# end::query[]'))
    expect(parsed.errors).toEqual([])
    expect(parsed.settings.expect).toBe('series')
  })

  it.each(['series', 'empty', 'scalar'])('accepts expect: %s', (value) => {
    const parsed = parseQueryFile(file(`# expect: ${value}`, '# tag::query[]', 'up', '# end::query[]'))
    expect(parsed.errors).toEqual([])
    expect(parsed.settings.expect).toBe(value)
  })

  it('reads settings after the tag, blank lines and Windows line endings', () => {
    const parsed = parseQueryFile('# tag::query[]\r\nup\r\n# end::query[]\r\n\r\n#expect:empty\r\n')
    expect(parsed.errors).toEqual([])
    expect(parsed.settings.expect).toBe('empty')
    expect(parsed.query).toBe('up')
  })

  it('keeps comments inside the tag: they are part of what readers see', () => {
    const parsed = parseQueryFile(file('# tag::query[]', '# Brokers that are down', 'up == 0', '# end::query[]'))
    expect(parsed.errors).toEqual([])
    expect(parsed.query).toBe('# Brokers that are down\nup == 0')
  })

  it('reads skip-run with its reason and extra-labels as a list', () => {
    const parsed = parseQueryFile(file(
      '# skip-run: needs a Kubernetes cluster',
      '# extra-labels: namespace, pod',
      '# tag::query[]', 'up', '# end::query[]'
    ))
    expect(parsed.errors).toEqual([])
    expect(parsed.settings.skipRun).toBe('needs a Kubernetes cluster')
    expect(parsed.settings.extraLabels).toEqual(['namespace', 'pod'])
  })

  it('reads exporter as a name, and has none by default', () => {
    const parsed = parseQueryFile(file('# expect: empty', '# exporter: kafka-connect', '# tag::query[]', 'kafka_consumer_lag_max > 1000', '# end::query[]'))
    expect(parsed.errors).toEqual([])
    expect(parsed.settings.exporter).toBe('kafka-connect')
    expect(parsed.settings.expect).toBe('empty')
    expect(parseQueryFile(GOOD).settings.exporter).toBeNull()
  })

  it.each(['redpanda-operator', 'kafka-connect', 'node', 'k8s', 'exporter2'])('accepts the exporter name %s', (name) => {
    expect(parseQueryFile(file(`# exporter: ${name}`, '# tag::query[]', 'up', '# end::query[]')).errors).toEqual([])
  })
})

describe('a file that fails', () => {
  const errorsOf = (text) => parseQueryFile(text).errors

  it.each([
    ['no tag', file('up'), /only settings/],
    ['no tag, only settings', file('# expect: series'), /no query tag/],
    ['two tags', file('# tag::query[]', 'up', '# end::query[]', '# tag::query[]', 'up', '# end::query[]'), /2 query tags/],
    ['an empty query', file('# tag::query[]', '', '# end::query[]'), /the query is empty/],
    ['a query that is only a comment', file('# tag::query[]', '# nothing here', '# end::query[]'), /the query is empty/],
    ['a tag that is not closed', file('# tag::query[]', 'up'), /not closed/],
    ['an end with no start', file('# end::query[]'), /no matching tag/],
    ['a tag with another name', file('# tag::alert[]', 'up', '# end::alert[]'), /unknown tag "alert"/],
    ['a tag inside the tag', file('# tag::query[]', '# tag::inner[]', 'up', '# end::inner[]', '# end::query[]'), /a tag inside the query tag/],
    ['an unknown setting', file('# expects: series', '# tag::query[]', 'up', '# end::query[]'), /unknown setting "expects"/],
    ['a comment that is not a setting', file('# This alert fires when a broker is down', '# tag::query[]', 'up', '# end::query[]'), /only settings/],
    ['query text outside the tag', file('# tag::query[]', 'up', '# end::query[]', 'up'), /only settings/],
    ['an unknown expect value', file('# expect: nothing', '# tag::query[]', 'up', '# end::query[]'), /expect must be one of series, empty, scalar/],
    ['expect given twice', file('# expect: series', '# expect: empty', '# tag::query[]', 'up', '# end::query[]'), /"expect" is given twice/],
    ['skip-run with no reason', file('# skip-run:', '# tag::query[]', 'up', '# end::query[]'), /skip-run needs a reason/],
    ['extra-labels with no label', file('# extra-labels:', '# tag::query[]', 'up', '# end::query[]'), /at least one label/],
    ['extra-labels with a bad name', file('# extra-labels: pod name', '# tag::query[]', 'up', '# end::query[]'), /not a label name: pod name/],
    ['exporter with no name', file('# exporter:', '# tag::query[]', 'up', '# end::query[]'), /exporter needs a name/],
    ['exporter with capitals', file('# exporter: Kafka-Connect', '# tag::query[]', 'up', '# end::query[]'), /exporter must be one name in lowercase letters, digits and hyphens.*got "Kafka-Connect"/],
    ['exporter with two names', file('# exporter: redpanda-operator, kafka-connect', '# tag::query[]', 'up', '# end::query[]'), /exporter must be one name/],
    ['exporter with a space', file('# exporter: kafka connect', '# tag::query[]', 'up', '# end::query[]'), /exporter must be one name/],
    ['exporter with an underscore', file('# exporter: kafka_connect', '# tag::query[]', 'up', '# end::query[]'), /exporter must be one name/],
    ['exporter that starts with a digit', file('# exporter: 9operator', '# tag::query[]', 'up', '# end::query[]'), /exporter must be one name/],
    ['exporter that ends in a hyphen', file('# exporter: kafka-', '# tag::query[]', 'up', '# end::query[]'), /exporter must be one name/],
    ['exporter given twice', file('# exporter: kafka-connect', '# exporter: kafka-connect', '# tag::query[]', 'up', '# end::query[]'), /"exporter" is given twice/],
    ['a setting named like exporter', file('# exporters: kafka-connect', '# tag::query[]', 'up', '# end::query[]'), /unknown setting "exporters". The settings are expect, set, skip-run, extra-labels, exporter/],
    ['exporter with skip-run', file('# exporter: kafka-connect', '# skip-run: no Kafka Connect', '# tag::query[]', 'up', '# end::query[]'), /skip-run has no effect with exporter/],
    ['exporter with extra-labels', file('# extra-labels: pod', '# exporter: kafka-connect', '# tag::query[]', 'up', '# end::query[]'), /extra-labels has no effect with exporter/]
  ])('%s', (_, text, message) => {
    const errors = errorsOf(text)
    expect(errors.join('\n')).toMatch(message)
    expect(parseQueryFile(text).resolved).toBeNull()
  })

  it('names the line of the problem', () => {
    expect(errorsOf(file('# tag::query[]', 'up', '# end::query[]', '# expect: maybe'))[0]).toMatch(/^line 4: /)
  })
})

describe('placeholders', () => {
  const withPlaceholder = (...settings) => file(
    ...settings,
    '# tag::query[]',
    'redpanda_kafka_max_offset{redpanda_topic="<topic>"}',
    '# end::query[]'
  )

  it('replaces a placeholder that has a set', () => {
    const parsed = parseQueryFile(withPlaceholder('# set: <topic>=metrics-group-probe'))
    expect(parsed.errors).toEqual([])
    expect(parsed.query).toBe('redpanda_kafka_max_offset{redpanda_topic="<topic>"}')
    expect(parsed.resolved).toBe('redpanda_kafka_max_offset{redpanda_topic="metrics-group-probe"}')
  })

  it('fails a placeholder with no set', () => {
    const parsed = parseQueryFile(withPlaceholder())
    expect(parsed.errors).toEqual(['the query has the placeholder <topic> and no "set: <topic>=value" for it'])
    expect(parsed.resolved).toBeNull()
  })

  it('fails a set for a placeholder the query does not have', () => {
    const parsed = parseQueryFile(withPlaceholder('# set: <topic>=a', '# set: <group>=b'))
    expect(parsed.errors).toEqual(['set: <group> is not a placeholder in the query'])
  })

  it.each([
    ['no equals sign', '# set: <topic>', /set must be <placeholder>=value/],
    ['no value', '# set: <topic>=', /set must be <placeholder>=value/],
    ['a name that is not a placeholder', '# set: topic=a', /"topic" is not a placeholder/],
    ['the same placeholder twice', '# set: <topic>=b', /"<topic>" is set twice/]
  ])('fails a set with %s', (_, setting, message) => {
    const parsed = parseQueryFile(withPlaceholder('# set: <topic>=a', setting))
    expect(parsed.errors.join('\n')).toMatch(message)
  })

  it('replaces Grafana variables, and every use of one', () => {
    const parsed = parseQueryFile(file(
      '# set: $__rate_interval=5m',
      '# set: ${server}=kafka',
      '# set: [[other]]=internal',
      '# tag::query[]',
      'rate(redpanda_rpc_received_bytes{redpanda_server="${server}"}[$__rate_interval])',
      '  + rate(redpanda_rpc_received_bytes{redpanda_server="[[other]]"}[$__rate_interval])',
      '# end::query[]'
    ))
    expect(parsed.errors).toEqual([])
    expect(parsed.resolved).toBe([
      'rate(redpanda_rpc_received_bytes{redpanda_server="kafka"}[5m])',
      '  + rate(redpanda_rpc_received_bytes{redpanda_server="internal"}[5m])'
    ].join('\n'))
  })

  it('finds each placeholder once and ignores one in a comment', () => {
    expect(findPlaceholders('a{t="<topic>"} + b{t="<topic>"} # replace <group> too\n[$__interval]')).toEqual(['<topic>', '$__interval'])
  })

  it('does not read a comparison as a placeholder', () => {
    expect(findPlaceholders('a < b > c')).toEqual([])
    expect(findPlaceholders('a{x=~"foo$"} <= 5')).toEqual([])
  })

  // A limit: without spaces, a < b > c reads as the placeholder <b>.
  it('reads <b> as a placeholder when a comparison chain has no spaces', () => {
    expect(findPlaceholders('a <b> c')).toEqual(['<b>'])
  })
})
