'use strict'

const fs = require('fs')
const path = require('path')
const handlebars = require('handlebars')

const anchorName = require('../../../tools/property-extractor/helpers/anchorName')
const normalizePropertyAnchors = require('../../../tools/property-extractor/helpers/normalizePropertyAnchors')
const helpers = require('../../../tools/property-extractor/helpers')

const TEMPLATES = path.join(__dirname, '../../../tools/property-extractor/templates')

function compile (name) {
  const hbs = handlebars.create()
  Object.entries(helpers).forEach(([k, v]) => hbs.registerHelper(k, v))
  return hbs.compile(fs.readFileSync(path.join(TEMPLATES, name), 'utf8'))
}

// Strip whichever branch the reader's doc set would not see, the way the
// AsciiDoc preprocessor does, so a test can assert on one doc set at a time.
function forDocSet (adoc, cloud) {
  const keep = cloud ? 'ifdef' : 'ifndef'
  const drop = cloud ? 'ifndef' : 'ifdef'
  return adoc
    .replace(new RegExp(`${drop}::env-cloud\\[\\]\\n[\\s\\S]*?\\nendif::\\[\\]\\n`, 'g'), '')
    .replace(new RegExp(`${keep}::env-cloud\\[\\]\\n|\\nendif::\\[\\]`, 'g'), '')
}

describe('anchorName', () => {
  // Antora renders these headings with idprefix='' and idseparator='-', so the
  // anchor has to match what Asciidoctor derives from the heading text.
  test.each([
    ['cleanup.policy', 'cleanup-policy'],
    ['retention.ms', 'retention-ms'],
    ['max.message.bytes', 'max-message-bytes'],
    ['redpanda.storage.mode.impl', 'redpanda-storage-mode-impl'],
    ['confluent.value.schema.validation', 'confluent-value-schema-validation'],
    // Underscores are word characters, so Asciidoctor keeps them.
    ['redpanda.cloud_topic.enabled', 'redpanda-cloud_topic-enabled'],
    ['cloud_storage_bucket', 'cloud_storage_bucket']
  ])('%s -> %s', (name, expected) => {
    expect(anchorName(name)).toBe(expected)
  })

  test('rejects a name with no usable characters', () => {
    expect(() => anchorName('...')).toThrow(/Invalid property name/)
  })
})

describe('normalizePropertyAnchors', () => {
  const properties = {
    'redpanda.storage.mode': { config_scope: 'topic' },
    'redpanda.storage.mode.impl': { config_scope: 'topic' },
    'redpanda.remote.read': { config_scope: 'topic' },
    'redpanda.remote.write': { config_scope: 'topic' },
    'flush.ms': { config_scope: 'topic' },
    'retention.bytes': { config_scope: 'topic' },
    retention_bytes: { config_scope: 'cluster' },
    cloud_storage_bucket: { config_scope: 'cluster' }
  }

  test.each([
    ['<<redpandastoragemodeimpl,x>>', 'redpanda-storage-mode-impl'],
    ['<<redpandastorage-mode, x>>', 'redpanda-storage-mode'],
    ['<<redpandaremoteread,x>> and <<redpandaremotewrite,y>>', 'redpanda-remote-read'],
    ['<<flushms, x>>', 'flush-ms']
  ])('repairs %s', (input, expected) => {
    expect(normalizePropertyAnchors(input, properties, 'topic').text).toContain(`<<${expected}`)
  })

  test('resolves a cross-scope collision in favour of the referring scope', () => {
    // retention.bytes and retention_bytes both squash to "retentionbytes".
    expect(normalizePropertyAnchors('<<retentionbytes,x>>', properties, 'topic').text)
      .toContain('<<retention-bytes')
    expect(normalizePropertyAnchors('<<retentionbytes,x>>', properties, 'cluster').text)
      .toContain('<<retention_bytes')
  })

  test('refuses to guess when the collision cannot be broken', () => {
    const result = normalizePropertyAnchors('<<retentionbytes,x>>', properties)
    expect(result.rewrites).toEqual([])
    expect(result.text).toBe('<<retentionbytes,x>>')
  })

  test('leaves anchors that are already correct alone', () => {
    for (const anchor of ['retention-bytes', 'cloud_storage_bucket']) {
      const result = normalizePropertyAnchors(`<<${anchor},x>>`, properties, 'topic')
      expect(result.rewrites).toEqual([])
    }
  })

  test('leaves an anchor that names no property alone', () => {
    const input = 'see <<configure-message-retention,Configure message retention>>'
    expect(normalizePropertyAnchors(input, properties, 'topic').text).toBe(input)
  })

  test('is a no-op on text with no anchors', () => {
    expect(normalizePropertyAnchors('plain text', properties, 'topic').text).toBe('plain text')
  })

  test('accepts a bare list of names as well as the property map', () => {
    expect(normalizePropertyAnchors('<<flushms,x>>', ['flush.ms']).text).toContain('<<flush-ms')
  })
})

describe('corresponding cluster property row', () => {
  const template = compile('topic-property.hbs')
  const base = { name: 'x.y', config_scope: 'topic', type: 'string', cluster_property_doc_file: 'cluster-properties.adoc' }

  test('links when Cloud publishes the counterpart', () => {
    const out = template({ ...base, corresponding_cluster_property: 'log_retention_ms', corresponding_cluster_property_cloud_supported: true })
    expect(forDocSet(out, true)).toContain('xref:reference:properties/cluster-properties.adoc#log_retention_ms[`log_retention_ms`]')
  })

  test('keeps the name but drops the link when Cloud does not publish it', () => {
    const cloud = forDocSet(template({ ...base, corresponding_cluster_property: 'log_cleanup_policy', corresponding_cluster_property_cloud_supported: false }), true)
    expect(cloud).toContain('`log_cleanup_policy`')
    // A link would land on an anchor that does not exist on Cloud's reference page.
    expect(cloud).not.toContain('xref:reference:properties/cluster-properties.adoc#log_cleanup_policy')
    // And it must not assert who manages the value: cloud_supported cannot tell
    // "Redpanda manages it" from "does not apply to Cloud".
    expect(cloud).not.toMatch(/managed by Redpanda/i)
  })

  test('self-managed always links, whatever Cloud supports', () => {
    const sm = forDocSet(template({ ...base, corresponding_cluster_property: 'log_cleanup_policy', corresponding_cluster_property_cloud_supported: false }), false)
    expect(sm).toContain('xref:reference:properties/cluster-properties.adoc#log_cleanup_policy[`log_cleanup_policy`]')
  })

  test('never emits the legacy resource ID, which Cloud cannot resolve', () => {
    const out = template({ ...base, corresponding_cluster_property: 'log_retention_ms', corresponding_cluster_property_cloud_supported: true })
    expect(out).not.toContain('xref:reference:cluster-properties.adoc#')
  })

  test('routes an object storage counterpart to its own page', () => {
    const out = template({ ...base, corresponding_cluster_property: 'cloud_storage_enable_remote_read', cluster_property_doc_file: 'object-storage-properties.adoc', corresponding_cluster_property_cloud_supported: true })
    expect(forDocSet(out, true)).toContain('xref:reference:properties/object-storage-properties.adoc#cloud_storage_enable_remote_read')
  })
})

describe('topic property mappings table', () => {
  const template = compile('topic-property-mappings.hbs')
  const row = (over) => ({ name: 'segment.bytes', cluster_property_doc_file: 'cluster-properties.adoc', corresponding_cluster_property: 'log_segment_size', ...over })

  test('left column uses the real heading anchor', () => {
    expect(template({ topicProperties: [row({ cluster_property_mapping_cloud_supported: true })] }))
      .toContain('<<segment-bytes,`segment.bytes`>>')
  })

  test('drops both links when either counterpart is unreachable in Cloud', () => {
    const cloud = forDocSet(template({
      topicProperties: [row({
        alternate_cluster_property: 'compacted_log_segment_size',
        alternate_cluster_property_doc_file: 'cluster-properties.adoc',
        cluster_property_mapping_cloud_supported: false
      })]
    }), true)
    expect(cloud).toContain('`log_segment_size` or `compacted_log_segment_size`')
    expect(cloud).not.toContain('xref:./cluster-properties.adoc#log_segment_size')
  })

  test('self-managed keeps both links', () => {
    const sm = forDocSet(template({
      topicProperties: [row({
        alternate_cluster_property: 'compacted_log_segment_size',
        alternate_cluster_property_doc_file: 'cluster-properties.adoc',
        cluster_property_mapping_cloud_supported: false
      })]
    }), false)
    expect(sm).toContain('xref:./cluster-properties.adoc#log_segment_size[`log_segment_size`]')
    expect(sm).toContain('xref:./cluster-properties.adoc#compacted_log_segment_size[`compacted_log_segment_size`]')
  })
})
