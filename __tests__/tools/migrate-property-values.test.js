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
  })

  describe('statuses', () => {
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

    test('tables', () => {
      expect(scan('|===\n| prop:log_segment_ms[] | defaults to 1 day\n|===')).toEqual([])
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
  })
})
