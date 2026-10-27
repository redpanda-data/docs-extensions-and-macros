'use strict'

jest.mock('@antora/logger', () => {
  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const getLogger = () => logger
  getLogger.configure = () => getLogger
  return getLogger
})

const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  parseValue,
  scanLine,
  scanDocument,
  scanRepo,
  renderMarkdown,
} = require('../../tools/migrate-property-values')
const { register } = require('../../macros/prop')

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'propval', 'redpanda-properties-v26.2.4-sample.json'), 'utf8'))
const REGISTRY = { tag: 'v26.2.4', properties: SAMPLE.properties, component: 'streaming', version: '26.2', surface: 'all' }

const scan = (content, registry = REGISTRY, options = {}) => scanDocument(content, registry, options).findings
const only = (content, registry) => {
  const findings = scan(content, registry)
  expect(findings).toHaveLength(1)
  return findings[0]
}

describe('migrate-property-values', () => {
  describe('parseValue', () => {
    test.each([
      ['`true` and more', { kind: 'bool', bool: true, backticked: true }],
      ['128 MiB, which', { kind: 'number', number: 128, unitKind: 'bytes' }],
      ['10,000ms)', { kind: 'number', number: 10000, unit: 'ms', unitKind: 'time' }],
      ['2 weeks.', { kind: 'number', number: 2, unitKind: 'time' }],
      ['`604800000`, which', { kind: 'number', number: 604800000, backticked: true }],
      ['no default.', { kind: 'null' }],
      ['10% of disk', { kind: 'number', unitKind: 'percent' }],
      ['`$.groups`)', { kind: 'string', string: '$.groups' }],
    ])('%j', (text, expected) => {
      expect(parseValue(text)).toMatchObject(expected)
    })

    test.each([',', '_', "'"])('only includes %s when followed by a digit', (separator) => {
      const written = `-1${separator}234${separator}567.5 ms`
      expect(parseValue(`${written}, which`)).toMatchObject({ written, length: written.length, number: -1234567.5, unitKind: 'time' })
      const parsed = parseValue(`3${separator} ms of prose`)
      expect(parsed).toMatchObject({ written: '3', length: 1, number: 3 })
      expect(parsed.unit).toBeUndefined()
    })
  })

  describe('statuses', () => {
    test.each([',', '_', "'"])('preserves prose after a trailing %s in --write', (separator) => {
      const result = scanDocument(`prop:default_topic_replications[] defaults to 1${separator} ms of prose.`, REGISTRY, { write: true })
      expect(result.findings[0]).toMatchObject({ status: 'exact', written: '1', autoSafe: true })
      expect(result.content).toBe(`prop:default_topic_replications[] defaults to propval:default_topic_replications[default]${separator} ms of prose.`)
    })

    test.each([',', '_', "'"])('by-default matcher preserves grouped numbers and rejects trailing %s', (separator) => {
      expect(only(`prop:log_retention_ms[] is 604${separator}800${separator}000 by default.`)).toMatchObject({ status: 'equivalent', written: `604${separator}800${separator}000` })
      expect(scan(`prop:default_topic_replications[] is 3${separator} ms by default.`)).toEqual([])
    })

    test.each([
      ['prop:enable_transactions[] defaults to `TRUE`.'],
      ['prop:log_segment_ms[] defaults to 2 WEEKS.'],
      ['prop:log_cleanup_policy[] defaults to `DELETE`.'],
    ])('case-only differences remain equivalent and are not written: %s', (content) => {
      const result = scanDocument(content, REGISTRY, { write: true })
      expect(result.findings[0]).toMatchObject({ status: 'equivalent', autoSafe: false })
      expect(result.content).toBe(content)
    })

    test.each([
      ['DELETE', 'exact', 'propval:case_value[default]'],
      ['Delete', 'exact', 'propval:case_value[default,format=raw]'],
      ['delete', 'equivalent', 'propval:case_value[default]'],
    ])('human and raw string renderings match case-sensitively: %s', (written, status, proposed) => {
      const registry = { ...REGISTRY, properties: { case_value: { default: 'Delete', default_human_readable: 'DELETE' } } }
      const content = `prop:case_value[] defaults to \`${written}\`.`
      const result = scanDocument(content, registry, { write: true })
      expect(result.findings[0]).toMatchObject({ status, proposed: status === 'exact' ? `\`${proposed}\`` : proposed, autoSafe: status === 'exact' })
      expect(result.content).toBe(status === 'exact' ? `prop:case_value[] defaults to \`${proposed}\`.` : content)
    })

    test.each([
      [{ default: [1, 2] }, '`[1, 2]`', ''],
      [{ default: [1, 2], default_human_readable: 'two entries' }, '`[1, 2]`', ',format=raw'],
      [{ default: { enabled: true } }, '`{enabled: true}`', ''],
      [{ default: 3600000, default_human_readable: '1 hour' }, '1 hour', ''],
      [{ default: 3600000, default_human_readable: '1 hour' }, '`1 hour`', ''],
    ])('uses exact renderings when semantic comparison is unverifiable: %j, %s', (entry, written, format) => {
      const registry = { ...REGISTRY, properties: { exact_value: entry } }
      const call = `propval:exact_value[default${format}]`
      const proposed = written.startsWith('`') ? `\`${call}\`` : call
      const result = scanDocument(`Use prop:exact_value[], which defaults to ${written}.`, registry, { write: true })
      expect(result.findings[0]).toMatchObject({ status: 'exact', autoSafe: true, proposed })
      expect(result.findings[0].note).toBeUndefined()
      expect(result.findings[0].reason).toBeUndefined()
      expect(result.content).toBe(`Use prop:exact_value[], which defaults to ${proposed}.`)

      const previous = `Use prop:exact_value[]. The default is ${written}.`
      const deferred = scanDocument(previous, registry, { write: true })
      expect(deferred.findings[0]).toMatchObject({ status: 'exact', autoSafe: false, proposed })
      expect(deferred.content).toBe(previous)
    })

    test('keeps nonmatching structured values unverifiable', () => {
      const registry = { ...REGISTRY, properties: { list_value: { default: [1, 2] } } }
      const content = 'prop:list_value[] defaults to `[3]`.'
      const result = scanDocument(content, registry, { write: true })
      expect(result.findings[0]).toMatchObject({ status: 'unverifiable', reason: 'not-comparable', note: 'the data value is a list or object', autoSafe: false })
      expect(result.content).toBe(content)
    })

    test('exact: the written text is what propval: renders, and it is auto-safe', () => {
      const f = only('Set prop:log_segment_ms[], which defaults to 2 weeks.')
      expect(f).toMatchObject({ status: 'exact', autoSafe: true, property: 'log_segment_ms', proposed: 'propval:log_segment_ms[default]' })
    })

    test('exact on the raw form proposes format=raw and keeps the backticks', () => {
      const f = only('Set prop:log_retention_ms[], which defaults to `604800000`.')
      expect(f).toMatchObject({ status: 'exact', proposed: '`propval:log_retention_ms[default,format=raw]`' })
    })

    test('equivalent: same value, different wording, never auto-safe', () => {
      const f = only('The prop:log_segment_ms[] property defaults to 14 days.')
      expect(f).toMatchObject({ status: 'equivalent', autoSafe: false, dataValue: '2 weeks' })
    })

    test('mismatch: the PR 2281 error, a 1 GiB segment size', () => {
      const f = only('The prop:log_segment_size[] property defaults to 1 GiB.')
      expect(f).toMatchObject({ status: 'mismatch', written: '1 GiB', dataValue: '134217728' })
      // The data has no unit for this property, so the comparison says how it
      // read the written value.
      expect(f.note).toMatch(/compared as bytes/)
    })

    test('mismatch: a wrong bare number', () => {
      expect(only('The topic property `segment.bytes` defaults to `1073741824`.')).toMatchObject({ status: 'mismatch', dataValue: '134217728' })
      expect(only('The topic property `segment.bytes` defaults to `134217728`.')).toMatchObject({ status: 'exact' })
    })

    test('mismatch: a wrong duration and a wrong boolean', () => {
      expect(only('`log_segment_ms` defaults to 1 week.')).toMatchObject({ status: 'mismatch' })
      expect(only('prop:enable_transactions[] is `false` by default.')).toMatchObject({ status: 'mismatch' })
    })

    test('min and max statements compare against minimum and maximum', () => {
      expect(only('prop:log_segment_ms[] has a minimum of 1 minute.')).toMatchObject({ field: 'min', status: 'exact' })
      expect(only('prop:log_segment_ms[] has a minimum of 30 seconds.')).toMatchObject({ field: 'min', status: 'mismatch' })
      expect(only('prop:log_segment_size[] has a maximum of 10 GiB.')).toMatchObject({ field: 'max', status: 'unverifiable', reason: 'no-such-field' })
    })

    test('a statement qualified to another audience or release is never compared as this page\'s default', () => {
      expect(only('In Redpanda Cloud, prop:log_segment_ms[] defaults to 1 day.')).toMatchObject({ status: 'unverifiable', reason: 'qualified-differs' })
      expect(only('In earlier versions, `enable_transactions` defaults to `false`.')).toMatchObject({ status: 'unverifiable', reason: 'qualified-differs' })
      expect(only('Set prop:log_segment_ms[]. If the cluster default is 1 day, nothing changes.')).toMatchObject({ status: 'unverifiable' })
    })

    test('an enum value that looks like a keyword compares as the string it is', () => {
      const registry = { ...REGISTRY, properties: { enable_schema_id_validation: { name: 'enable_schema_id_validation', config_scope: 'cluster', type: 'string', default: 'none', enum: ['none', 'redpanda', 'compat'] } } }
      expect(only('Change `enable_schema_id_validation` from its default value of `none` to `compat`.', registry)).toMatchObject({ status: 'exact' })
    })
  })

  describe('association', () => {
    test('the previous sentence: proposed, not auto-safe', () => {
      const f = only('Set prop:log_retention_ms[] to `86400000`, which is one day. The default is `604800000`, which is one week.')
      expect(f).toMatchObject({ status: 'exact', association: 'previous-sentence', autoSafe: false })
    })

    test('a list entry belongs to its subject, not to a property it mentions on the way', () => {
      const findings = scan('* `audit_log_replication_factor`: If unset, Redpanda uses the prop:default_topic_replications[] value. Default: `null`.')
      // audit_log_replication_factor is not in the sample, so the statement is
      // claimed by the subject and nothing is reported against the other name.
      expect(findings).toEqual([])
      const subject = only('* prop:log_segment_size[]: Segment size. Uses prop:fetch_max_bytes[] for something. Default: `134217728`.')
      expect(subject).toMatchObject({ property: 'log_segment_size', association: 'list-subject', status: 'exact', autoSafe: false })
    })

    test('a property xref counts as a mention, by its anchor', () => {
      const f = only('Configure xref:reference:properties/cluster-properties.adoc#log_segment_ms[the segment lifetime] (default: 2 weeks).')
      expect(f).toMatchObject({ property: 'log_segment_ms', status: 'exact' })
    })

    test('"the default value of `x` is" reads the mention after the phrase', () => {
      expect(only('The default value of `log_segment_ms` is 2 weeks.')).toMatchObject({ property: 'log_segment_ms', status: 'exact' })
    })

    test('a different property in between breaks the association', () => {
      expect(scan('Set `log_segment_ms` higher than `log_retention_ms`, which defaults to 1 week.')[0]).toMatchObject({ property: 'log_retention_ms' })
    })

    test('a reference to another property is not a value', () => {
      expect(scan('`segment.bytes` defaults to `log_segment_size`.')).toEqual([])
    })
  })

  // Wrong defaults the first dry run against docs main missed, and its false
  // positives. Each case is the pattern found in the docs.
  describe('recall audit regressions', () => {
    test('a description cell states the default of the property in the row\'s first cell', () => {
      const content = [
        '|===',
        '| Property | Description',
        '',
        '| prop:log_segment_size[link=true,helm-path=auto]',
        '| Segment size. Default is 1 GiB.',
        '',
        '| prop:log_segment_ms[link=true,helm-path=auto]',
        'a| Segment lifetime.',
        '',
        'Default is 1 day.',
        '|===',
      ].join('\n')
      const findings = scan(content)
      expect(findings).toHaveLength(2)
      expect(findings[0]).toMatchObject({ line: 5, property: 'log_segment_size', status: 'mismatch', association: 'table-row', autoSafe: false })
      expect(findings[1]).toMatchObject({ line: 10, property: 'log_segment_ms', status: 'mismatch', association: 'table-row' })
    })

    test('"Default - `x`" and "No default" under a property cell', () => {
      const content = [
        '|===',
        '| Policy | Cluster | Topic',
        '',
        '| Segment size',
        '| prop:log_segment_size[] +',
        'Default - `1073741824`',
        '| prop:segment.bytes[] +',
        'No default',
        '',
        '| Segment lifetime',
        '| prop:log_segment_ms[] +',
        'No default',
        '|===',
      ].join('\n')
      const findings = scan(content)
      expect(findings.map((f) => [f.line, f.property, f.status, f.reason])).toEqual([
        [6, 'log_segment_size', 'mismatch', undefined],
        // A topic property has no default of its own: it inherits one.
        [8, 'segment.bytes', 'unverifiable', 'inherits-cluster-default'],
        [12, 'log_segment_ms', 'mismatch', undefined],
      ])
    })

    test('a Default column states the default of the property in its row', () => {
      const content = [
        '|===',
        '| Cluster property | Default | Topic property',
        '',
        '| prop:log_segment_size[]',
        '| 134217728 bytes (128 MiB)',
        '| prop:segment.bytes[]',
        '',
        '| prop:log_segment_ms[]',
        '| null (no limit)',
        '| prop:segment.ms[]',
        '|===',
      ].join('\n')
      const findings = scan(content)
      expect(findings.map((f) => [f.line, f.property, f.status, f.association])).toEqual([
        [5, 'log_segment_size', 'equivalent', 'table-default-column'],
        [9, 'log_segment_ms', 'mismatch', 'table-default-column'],
      ])
    })

    test('"By default, the property is empty." belongs to the row\'s property', () => {
      const content = '|===\n| prop:log_segment_ms[]\n| Segment lifetime. By default, the property is empty.\n|==='
      expect(only(content)).toMatchObject({ property: 'log_segment_ms', written: 'empty', status: 'mismatch' })
    })

    test('a macro attribute such as helm-path=auto does not qualify the sentence', () => {
      expect(only('Set prop:log_segment_ms[link=true,helm-path=auto], which defaults to 1 day.')).toMatchObject({ status: 'mismatch' })
      expect(only('Set prop:log_segment_ms[] with the Helm chart, which defaults to 1 day.')).toMatchObject({ status: 'unverifiable', qualifier: 'Helm' })
    })

    test('an ifdef::env-cloud[] block is Cloud content, not this page\'s self-managed default', () => {
      const content = [
        'ifdef::env-cloud[]',
        '* prop:enable_transactions[]: Enables transactions. Default: `false`.',
        'endif::[]',
        'ifndef::env-cloud[]',
        '* prop:enable_transactions[]: Enables transactions. Default: `false`.',
        'endif::[]',
      ].join('\n')
      const findings = scan(content)
      expect(findings.map((f) => [f.line, f.status, f.qualifier])).toEqual([
        [2, 'unverifiable', 'ifdef::env-cloud'],
        [5, 'mismatch', undefined],
      ])
      // On a Cloud page, ifndef::env-cloud[] content is not rendered at all.
      const cloud = { ...REGISTRY, surface: 'cloud', properties: { ...REGISTRY.properties, enable_transactions: { ...REGISTRY.properties.enable_transactions, cloud_supported: true } } }
      expect(scan(content, cloud).map((f) => f.line)).toEqual([2])
    })

    test('a stated value for a property whose data default is null is "unset", not a mismatch', () => {
      const f = only('* prop:compaction_ctrl_backlog_size[]: Backlog size. (default: 10% of disk capacity)')
      expect(f).toMatchObject({ status: 'unset', written: '10%' })
      expect(f.note).toBe('not set in the data; the prose states 10%, which may be a runtime fallback')
      expect(only('prop:compaction_ctrl_backlog_size[] defaults to 512 MiB.')).toMatchObject({ status: 'unset' })
      // Saying it is not set still matches.
      expect(only('prop:compaction_ctrl_backlog_size[] defaults to null.')).toMatchObject({ status: 'exact' })
    })
  })

  describe('what is skipped', () => {
    test('listing, literal, comment, passthrough and fenced blocks', () => {
      const content = [
        '----', '`log_segment_ms` defaults to 1 day.', '----',
        '....', '`log_segment_ms` defaults to 1 day.', '....',
        '////', '`log_segment_ms` defaults to 1 day.', '////',
        '++++', '`log_segment_ms` defaults to 1 day.', '++++',
        '```yaml', '`log_segment_ms` defaults to 1 day.', '```',
      ].join('\n')
      expect(scan(content)).toEqual([])
    })

    test('tables are reported but never written', () => {
      const content = '|===\n| prop:log_segment_ms[] | defaults to 2 weeks\n|==='
      const result = scanDocument(content, REGISTRY, { write: true })
      expect(result.findings).toHaveLength(1)
      expect(result.findings[0]).toMatchObject({ property: 'log_segment_ms', status: 'exact', autoSafe: false })
      expect(result.content).toBe(content)
    })

    test('headings, attribute entries, block titles and comment lines', () => {
      expect(scan('== `log_segment_ms` defaults to 1 day\n:foo: `log_segment_ms` defaults to 1 day\n.`log_segment_ms` defaults to 1 day\n// `log_segment_ms` defaults to 1 day')).toEqual([])
    })

    test('word-like backticked names need prop: to count', () => {
      const registry = { ...REGISTRY, properties: { admin: { name: 'admin', config_scope: 'broker', default: 'x' } } }
      expect(scan('`admin` defaults to `y`.', registry)).toEqual([])
      expect(scan('prop:admin[] defaults to `y`.', registry)).toHaveLength(1)
    })
  })

  describe('example output', () => {
    const examples = (content, registry = REGISTRY, options = {}) => scan(content, registry, options).filter((f) => f.kind === 'example-output')
    const describeOutput = (rows) => [
      '[,bash]', '----', 'rpk topic describe test_topic', 'SUMMARY', '=======', 'NAME        test_topic', '',
      'CONFIGS', '=======', 'KEY                     VALUE                          SOURCE', ...rows, '----',
    ].join('\n')

    test('a DEFAULT_CONFIG row in rpk topic describe output is compared with the cluster default it inherits', () => {
      const [stale, ok] = examples(describeOutput([
        'segment.bytes           1073741824                     DEFAULT_CONFIG',
        'retention.ms            604800000                      DEFAULT_CONFIG',
      ]))
      expect(stale).toMatchObject({ line: 11, property: 'segment.bytes', clusterProperty: 'log_segment_size', mappedBy: 'corresponding_cluster_property', written: '1073741824', dataRaw: '134217728', source: 'DEFAULT_CONFIG', status: 'example-output', verdict: 'stale', phrase: 'config-table', autoSafe: false })
      expect(ok).toMatchObject({ property: 'retention.ms', clusterProperty: 'log_retention_ms', verdict: 'matches' })
    })

    test('a DYNAMIC_TOPIC_CONFIG row with a non-default value is not flagged', () => {
      const [f] = examples(describeOutput(['cleanup.policy          compact                        DYNAMIC_TOPIC_CONFIG']))
      expect(f).toMatchObject({ property: 'cleanup.policy', status: 'example-output', verdict: 'unverifiable', reason: 'not-default-source', differs: true })
    })

    test('a cluster property set earlier on the page is not flagged', () => {
      const content = 'Run `rpk cluster config set log_segment_size 1073741824`.\n\n' + describeOutput(['segment.bytes           1073741824                     DEFAULT_CONFIG'])
      expect(examples(content)[0]).toMatchObject({ verdict: 'unverifiable', reason: 'set-earlier-on-page', note: 'the page sets log_segment_size at line 1' })
      // Helm values set it the same way.
      const helm = '[,yaml]\n----\nconfig:\n  cluster:\n    log_segment_size: 1073741824\n----\n\n' + describeOutput(['segment.bytes           1073741824                     DEFAULT_CONFIG'])
      expect(examples(helm)[0]).toMatchObject({ reason: 'set-earlier-on-page' })
      // A topic-level override of another topic does not change a DEFAULT_CONFIG row.
      const other = 'rpk topic create t2 -c segment.bytes=1073741824\n\n' + describeOutput(['segment.bytes           1073741824                     DEFAULT_CONFIG'])
      expect(examples(other)[0]).toMatchObject({ verdict: 'stale' })
    })

    test('ifdef::env-cloud output is a Cloud value on a self-managed page, and ifndef::env-cloud output is skipped on a Cloud page', () => {
      const cloudBlock = 'ifdef::env-cloud[]\n' + describeOutput(['segment.bytes           1073741824                     DEFAULT_CONFIG']) + '\nendif::[]'
      expect(examples(cloudBlock)[0]).toMatchObject({ verdict: 'unverifiable', reason: 'ifdef::env-cloud', differs: true })
      const cloud = { ...REGISTRY, surface: 'cloud' }
      const selfManaged = 'ifndef::env-cloud[]\n' + describeOutput(['retention.ms            1                              DEFAULT_CONFIG']) + '\nendif::[]'
      expect(examples(selfManaged, cloud)).toEqual([])
      expect(examples(describeOutput(['retention.ms            1                              DEFAULT_CONFIG']), cloud)[0]).toMatchObject({ verdict: 'unverifiable', reason: 'cloud-default' })
    })

    test('-1 matches a limit the data leaves unset, and a compacted topic inherits alternate_cluster_property', () => {
      const [bytes, policy, segment] = examples(describeOutput([
        'retention.bytes         -1                             DEFAULT_CONFIG',
        'cleanup.policy          compact                        DYNAMIC_TOPIC_CONFIG',
        'segment.bytes           268435456                      DEFAULT_CONFIG',
      ]))
      expect(bytes).toMatchObject({ property: 'retention.bytes', clusterProperty: 'retention_bytes', verdict: 'matches', note: '-1 is how Kafka reports an unset limit' })
      expect(policy).toMatchObject({ reason: 'not-default-source' })
      expect(segment).toMatchObject({ clusterProperty: 'compacted_log_segment_size', mappedBy: 'alternate_cluster_property', verdict: 'matches' })
    })

    test('rpk cluster config get, in one block or as an Input/Output pair', () => {
      expect(examples('On a cluster with default settings:\n\n----\n$ rpk cluster config get log_cleanup_policy\ncompact\n----')[0]).toMatchObject({ property: 'log_cleanup_policy', written: 'compact', verdict: 'stale', phrase: 'cluster-config-get', line: 5 })
      // Without that, the output is the cluster's current value.
      expect(examples('Check that compaction is on:\n\n----\n$ rpk cluster config get log_cleanup_policy\ncompact\n----')[0]).toMatchObject({ verdict: 'unverifiable', reason: 'current-value', differs: true })
      const pair = 'The default is:\n\n.Input\n[,bash]\n----\nrpk cluster config get default_topic_replications\n----\n\n.Output\n[,bash,role=no-copy]\n----\n1\n----'
      expect(examples(pair)[0]).toMatchObject({ property: 'default_topic_replications', verdict: 'matches', line: 12 })
      // Several gets with no output state nothing.
      expect(examples('----\nrpk cluster config get log_segment_size\nrpk cluster config get log_retention_ms\n----')).toEqual([])
    })

    test('rpk cluster config export and Admin API cluster_config responses', () => {
      const exported = 'Export the defaults:\n\n----\nrpk cluster config export\nlog_segment_size: 1073741824\nlog_cleanup_policy: delete\n----'
      const [size, policy] = examples(exported)
      expect(size).toMatchObject({ property: 'log_segment_size', verdict: 'stale', phrase: 'cluster-config-export' })
      expect(policy).toMatchObject({ verdict: 'matches' })
      const api = 'A new cluster returns its defaults:\n\n[,bash]\n----\ncurl http://localhost:9644/v1/cluster_config\n----\n\n[,json]\n----\n{\n  "log_segment_size": 1073741824,\n  "enable_transactions": true\n}\n----'
      const [apiSize, tx] = examples(api)
      expect(apiSize).toMatchObject({ property: 'log_segment_size', verdict: 'stale', phrase: 'admin-api-cluster-config', line: 11 })
      expect(tx).toMatchObject({ property: 'enable_transactions', verdict: 'matches' })
      // The schema endpoint is not a config response.
      expect(examples('----\ncurl http://localhost:9644/v1/cluster_config/schema\n----\n\n----\n{\n  "log_segment_size": 1\n}\n----')).toEqual([])
    })

    test('rpk cluster config status output states no values', () => {
      expect(examples('----\nrpk cluster config status\nNODE  CONFIG-VERSION  NEEDS-RESTART  INVALID  UNKNOWN\n0     17              false          []       []\n----')).toEqual([])
    })

    test('kafka-configs --describe output and name=value (SOURCE) lines', () => {
      const kafka = '----\nkafka-configs.sh --bootstrap-server localhost:9092 --entity-type topics --entity-name t --describe --all\nAll configs for topic t are:\n  segment.bytes=1073741824 sensitive=false synonyms={DEFAULT_CONFIG:log_segment_size=1073741824}\n  cleanup.policy=compact sensitive=false synonyms={DYNAMIC_TOPIC_CONFIG:cleanup.policy=compact, DEFAULT_CONFIG:log_cleanup_policy=delete}\n----'
      const [size, policy] = examples(kafka)
      expect(size).toMatchObject({ property: 'segment.bytes', source: 'DEFAULT_CONFIG', verdict: 'stale', phrase: 'name-equals-value' })
      expect(policy).toMatchObject({ source: 'DYNAMIC_TOPIC_CONFIG', reason: 'not-default-source' })
      expect(examples('----\nsegment.bytes=134217728 (DEFAULT_CONFIG)\n----')[0]).toMatchObject({ verdict: 'matches' })
    })

    test('Key/Value/Source records in JSON compare the Redpanda-named synonym', () => {
      const json = [
        '```json', '{', '  "Configs": [', '    {',
        '      "Key": "log.segment.bytes",', '      "Value": "1073741824",', '      "Source": "DEFAULT_CONFIG",',
        '      "Synonyms": [', '        {', '          "Key": "log_segment_size",', '          "Value": "1073741824",', '          "Source": "DEFAULT_CONFIG"', '        }', '      ]',
        '    }', '  ]', '}', '```',
      ].join('\n')
      const found = examples(json)
      expect(found).toHaveLength(1)
      expect(found[0]).toMatchObject({ property: 'log_segment_size', written: '1073741824', line: 11, verdict: 'stale', phrase: 'records' })
    })

    test('Topic resource status on a Kubernetes page is a Helm or operator context', () => {
      const yaml = '----\nkubectl get topic t -o yaml\nstatus:\n  topicConfiguration:\n    - configType: LONG\n      name: segment.bytes\n      source: DEFAULT_CONFIG\n      value: "1073741824"\n    - name: retention.ms\n      source: DEFAULT_CONFIG\n      value: "604800000"\n----'
      const [size, retention] = examples(yaml, REGISTRY, { path: 'modules/manage/pages/kubernetes/k-manage-topics.adoc' })
      expect(size).toMatchObject({ property: 'segment.bytes', verdict: 'unverifiable', reason: 'helm-operator-context', differs: true, line: 8 })
      expect(retention).toMatchObject({ reason: 'helm-operator-context', differs: false })
      // kubectl in the command makes the same output context-dependent on any page.
      expect(examples(yaml)[0]).toMatchObject({ reason: 'helm-operator-context' })
    })

    test('a page that starts Redpanda in dev-container mode or from a bootstrap file states no defaults', () => {
      const content = 'Start a cluster with `rpk container start`.\n\n' + describeOutput(['write.caching           true                           DEFAULT_CONFIG'])
      expect(examples(content)[0]).toMatchObject({ property: 'write.caching', reason: 'dev-or-bootstrap-config', differs: true })
    })

    test('example output is never written, and prose inside blocks is still ignored', () => {
      const content = describeOutput(['segment.bytes           1073741824                     DEFAULT_CONFIG', 'retention.ms            604800000                      DEFAULT_CONFIG']) + '\n----\n`log_segment_ms` defaults to 1 day.\n----'
      const result = scanDocument(content, REGISTRY, { write: true })
      expect(result.content).toBe(content)
      expect(result.findings.every((f) => f.kind === 'example-output' && f.autoSafe === false)).toBe(true)
      expect(result.findings).toHaveLength(2)
    })
  })

  describe('scanRepo', () => {
    let root
    const write = (relative, content) => {
      const full = path.join(root, relative)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, content)
    }
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'propval-'))
      write('docs/antora.yml', "name: streaming\nversion: '26.2'\n")
      write('docs/modules/reference/attachments/redpanda-properties-v26.2.4.json', JSON.stringify(SAMPLE))
      // A neighbouring series on the same branch must not be picked.
      write('docs/modules/reference/attachments/redpanda-properties-v26.1.14.json', JSON.stringify({ properties: { log_segment_ms: { name: 'log_segment_ms', default: 1 } } }))
      write('docs/modules/manage/pages/a.adoc', [
        '= A',
        '',
        'Set prop:log_segment_ms[], which defaults to 2 weeks.',
        'The prop:log_segment_size[] property defaults to 1 GiB.',
        'Set prop:log_retention_ms[] to `1`. The default is `604800000`.',
      ].join('\n'))
      write('docs/modules/manage/pages/generated.adoc', '// This content is autogenerated. Do not edit manually. Generated by doc-tools.\n`log_segment_ms` defaults to 1 day.\n')
      write('docs/modules/get-started/pages/release-notes/redpanda.adoc', 'prop:log_segment_ms[] now defaults to 2 weeks.\n')
      write('cloud/antora.yml', 'name: cloud-data-platform\nversion: ~\nasciidoc:\n  attributes:\n    env-cloud: true\n')
      write('cloud/modules/manage/pages/b.adoc', [
        'prop:log_segment_ms[] defaults to 1 day.',
        'prop:log_segment_size[] defaults to 128 MiB.',
      ].join('\n'))
    })
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

    test('selects the page version\'s dataset the way prop: does, and counts statuses', () => {
      const result = scanRepo({ docsDir: path.join(root, 'docs') })
      expect(result.dataset).toBe('redpanda-properties-v26.2.4.json from streaming@26.2')
      expect(result.skippedGenerated).toBe(1)
      expect(result.counts).toMatchObject({ exact: 3, mismatch: 1, autoSafe: 1 })
      const notes = result.findings.find((f) => f.file.includes('release-notes'))
      expect(notes).toMatchObject({ status: 'exact', autoSafe: false })
    })

    test('a version with no data of its own is refused, not borrowed', () => {
      write('docs/antora.yml', "name: streaming\nversion: '26.3'\n")
      expect(scanRepo({ docsDir: path.join(root, 'docs') }).error).toMatch(/no property data for streaming@26\.3/)
    })

    test('Cloud borrows GA streaming data, states no defaults, and gates cloud_supported: false', () => {
      const result = scanRepo({ docsDir: path.join(root, 'cloud'), lenderDirs: [path.join(root, 'docs')] })
      expect(result.surface).toBe('cloud')
      const [lifetime, size] = result.findings
      expect(lifetime).toMatchObject({ status: 'unverifiable', reason: 'cloud-default-differs-from-self-managed' })
      expect(size).toMatchObject({ status: 'unverifiable', reason: 'cloud-unavailable' })
    })

    test('--write applies only auto-safe exact matches, and they render identically', () => {
      const file = path.join(root, 'docs/modules/manage/pages/a.adoc')
      const before = fs.readFileSync(file, 'utf8')
      const result = scanRepo({ docsDir: path.join(root, 'docs'), write: true })
      const after = fs.readFileSync(file, 'utf8')
      expect(result.changedFiles).toBe(1)
      expect(after).toContain('which defaults to propval:log_segment_ms[default].')
      // The mismatch and the previous-sentence match stay as written.
      expect(after).toContain('defaults to 1 GiB.')
      expect(after).toContain('The default is `604800000`.')
      expect(fs.readFileSync(path.join(root, 'docs/modules/get-started/pages/release-notes/redpanda.adoc'), 'utf8')).toContain('now defaults to 2 weeks.')

      const Asciidoctor = require('@asciidoctor/core')()
      const files = [{ src: { component: 'streaming', version: '26.2', module: 'reference', family: 'attachment', relative: 'redpanda-properties-v26.2.4.json' }, contents: Buffer.from(JSON.stringify(SAMPLE)) }]
      const catalog = { findBy: (q) => files.filter((f) => Object.entries(q).every(([k, v]) => f.src[k] === v)), getComponent: () => ({ versions: [{ version: '26.2', asciidoc: { attributes: {} } }] }) }
      const text = (source) => {
        const registry = Asciidoctor.Extensions.create()
        register(registry, { contentCatalog: catalog, file: { src: { path: 'a.adoc', component: 'streaming', version: '26.2', module: 'manage' } } })
        return Asciidoctor.convert(source, { extension_registry: registry }).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      }
      expect(text(after)).toBe(text(before))
    })

    test('renders a Markdown report listing every mismatch with file:line', () => {
      const result = scanRepo({ docsDir: path.join(root, 'docs') })
      const md = renderMarkdown([{ ...result, label: 'docs' }])
      expect(md).toContain('### Mismatches (1)')
      expect(md).toContain('| modules/manage/pages/a.adoc:4 | `log_segment_size` | default | 1 GiB | 134217728 |')
    })

    test('counts example output separately and lists stale examples in their own section', () => {
      write('docs/modules/manage/pages/d.adoc', ['----', 'KEY            VALUE       SOURCE', 'segment.bytes  1073741824  DEFAULT_CONFIG', 'retention.ms   604800000   DEFAULT_CONFIG', '----'].join('\n'))
      write('docs/modules/manage/pages/kubernetes/k-e.adoc', ['----', 'KEY            VALUE       SOURCE', 'segment.bytes  67108864    DEFAULT_CONFIG', '----'].join('\n'))
      const result = scanRepo({ docsDir: path.join(root, 'docs') })
      expect(result.counts).toMatchObject({ exact: 3, mismatch: 1, 'example-output': 3, exampleStale: 1 })
      const md = renderMarkdown([{ ...result, label: 'docs' }])
      expect(md).toContain('### Example output (3: 1 stale, 1 matching, 1 unverifiable)')
      expect(md).toContain('| modules/manage/pages/d.adoc:3 | `segment.bytes` | log_segment_size | 1073741824 | 134217728 | DEFAULT_CONFIG | config-table |')
      expect(md).toContain('| modules/manage/pages/kubernetes/k-e.adoc:3 | `segment.bytes` | log_segment_size | 67108864 | 134217728 | helm-operator-context |')
    })

    test('reports unset findings in their own section and count', () => {
      write('docs/modules/manage/pages/c.adoc', '* prop:compaction_ctrl_backlog_size[]: Backlog size. (default: 10% of disk capacity)\n')
      const result = scanRepo({ docsDir: path.join(root, 'docs') })
      expect(result.counts.unset).toBe(1)
      const md = renderMarkdown([{ ...result, label: 'docs' }])
      expect(md).toContain('### Not set in the data (1)')
      expect(md).toContain('| modules/manage/pages/c.adoc:1 | `compaction_ctrl_backlog_size` | default | 10% | not set in the data; the prose states 10%, which may be a runtime fallback |')
    })
  })

  describe('review fixes', () => {
    test('a cloud-hidden field in a tagged region outside ifndef::env-cloud[] is proposed, not written', () => {
      const line = 'Set prop:log_segment_ms[], which defaults to 2 weeks.'
      const tagged = ['// tag::single-source[]', line, '// end::single-source[]'].join('\n')
      const result = scanDocument(tagged, REGISTRY, { write: true })
      expect(result.findings[0]).toMatchObject({ status: 'exact', autoSafe: false, note: 'proposed: page may be single-sourced; wrap in ifndef::env-cloud[] first' })
      expect(result.content).toBe(tagged)
      // Inside ifndef::env-cloud[] the line never reaches Cloud.
      const guarded = ['// tag::single-source[]', 'ifndef::env-cloud[]', line, 'endif::[]', '// end::single-source[]'].join('\n')
      expect(scanDocument(guarded, REGISTRY, { write: true }).findings[0]).toMatchObject({ status: 'exact', autoSafe: true })
      // A file with no tag:: regions stays auto-safe.
      expect(scanDocument(line, REGISTRY, { write: true }).content).toBe('Set prop:log_segment_ms[], which defaults to propval:log_segment_ms[default].')
    })

    test('any field of a property Cloud does not support is proposed in a tagged region', () => {
      const registry = { ...REGISTRY, properties: { only_sm: { name: 'only_sm', type: 'integer', config_scope: 'cluster', cloud_supported: false, default: 3, minimum: 5 } } }
      const content = '// tag::x[]\nThe prop:only_sm[] property has a minimum of 5.\n// end::x[]'
      expect(scanDocument(content, registry, { write: true }).findings[0]).toMatchObject({ field: 'min', status: 'exact', autoSafe: false })
    })

    test('a comma (OR) condition naming env-cloud renders on Cloud', () => {
      const ifdef = 'ifdef::env-cloud,env-kubernetes[]\nprop:log_segment_ms[] defaults to 2 weeks.\nendif::[]'
      expect(only(ifdef)).toMatchObject({ status: 'unverifiable', qualifier: 'ifdef::env-cloud' })
      const ifndef = '// tag::x[]\nifndef::env-cloud,env-kubernetes[]\nprop:log_segment_ms[] defaults to 2 weeks.\nendif::[]\n// end::x[]'
      expect(only(ifndef)).toMatchObject({ status: 'exact', autoSafe: true })
      const cloud = { ...REGISTRY, surface: 'cloud' }
      expect(scan(ifndef, cloud)).toEqual([])
    })

    test('a .ms topic property compares as milliseconds', () => {
      expect(only('The `retention.ms` property defaults to 1 day.')).toMatchObject({ property: 'retention.ms', status: 'mismatch' })
      expect(only('The `retention.ms` property defaults to 7 days.')).toMatchObject({ status: 'equivalent' })
    })

    test('a hyphenated word is not a boolean', () => {
      expect(parseValue('on-demand mode')).toMatchObject({ kind: 'string', string: 'on-demand' })
      expect(scan('prop:enable_transactions[] defaults to on-demand.')).toEqual([])
    })

    test('"the default for prop:x[] is" reads the mention after the phrase', () => {
      expect(only('The default for prop:log_segment_ms[] is 2 weeks.')).toMatchObject({ property: 'log_segment_ms', status: 'exact' })
    })

    test('a nested table keeps the outer table\'s Default column', () => {
      const content = [
        '|===',
        '| Property | Default | Notes',
        '',
        '| prop:log_segment_ms[]',
        '| 2 weeks',
        'a|',
        '!===',
        '! a ! b',
        '!===',
        '',
        '| prop:log_segment_size[]',
        '| 134217728',
        '| text',
        '|===',
      ].join('\n')
      expect(scan(content).map((f) => [f.line, f.property, f.association])).toEqual([
        [5, 'log_segment_ms', 'table-default-column'],
        [12, 'log_segment_size', 'table-default-column'],
      ])
    })

    test('another property in the sentence or list entry makes a finding proposed only', () => {
      expect(only('Set `log_retention_ms` higher than prop:log_segment_ms[], which defaults to 2 weeks.')).toMatchObject({ property: 'log_segment_ms', status: 'exact', autoSafe: false })
      expect(only('* prop:log_retention_ms[] sets retention. It accepts values like prop:log_segment_ms[], where the default is 2 weeks.')).toMatchObject({ property: 'log_segment_ms', status: 'exact', autoSafe: false })
    })

    test('a null default is exact but never auto-safe', () => {
      const content = 'prop:compaction_ctrl_backlog_size[] defaults to null.'
      const result = scanDocument(content, REGISTRY, { write: true })
      expect(result.findings[0]).toMatchObject({ status: 'exact', autoSafe: false })
      expect(result.content).toBe(content)
    })
  })
})
