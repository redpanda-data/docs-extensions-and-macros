'use strict'

const classify = require('../../../tools/overrides-audit/classify')
const { CLASSES } = classify

/**
 * Build a minimal extracted source property.
 *
 * @param {Object} fields - Fields to merge over the defaults.
 * @returns {Object} Extracted property object.
 */
function sourceProp (fields = {}) {
  return {
    name: 'test_property',
    description: 'The source description.',
    type: 'integer',
    default: 100,
    defined_in: 'src/v/config/configuration.cc',
    ...fields
  }
}

describe('normalizeText', () => {
  test('collapses whitespace runs and unwraps lines', () => {
    expect(classify.normalizeText('One  two\nthree\n\n four ')).toBe('One two three four')
  })

  test('returns empty string for non-strings', () => {
    expect(classify.normalizeText(undefined)).toBe('')
    expect(classify.normalizeText(null)).toBe('')
  })
})

describe('detectDocsMarkup', () => {
  test.each([
    ['xref', 'See xref:reference:properties.adoc[the properties page].'],
    ['glossterm', 'Network address for the glossterm:Admin API[] server.'],
    ['include', 'include::shared:partial$note.adoc[]'],
    ['conditional', 'Cloud only.\nifdef::env-cloud[]\nExtra.\nendif::[]'],
    ['pass', 'Uses pass:q[`literal`] rendering.'],
    ['anchor-xref', 'If not set, the <<kafka_api, `kafka_api`>> property is used.'],
    ['property-link', 'See config_ref:retention_ms,true,properties/cluster-properties[] for details.'],
    ['property-link', 'See prop:retention_ms[link=true] for details.'],
    ['attribute', 'Runs on {node-count} brokers.']
  ])('detects %s markup', (kind, text) => {
    expect(classify.detectDocsMarkup(text)).toContain(kind)
  })

  test('plain prose with backticks and admonitions is markup-free', () => {
    const text = 'NOTE: Set `retention_ms` to `-1` to disable.\n\n* One\n* Two'
    expect(classify.detectDocsMarkup(text)).toEqual([])
  })

  test('escaped attribute literals do not count as attributes', () => {
    expect(classify.detectDocsMarkup('The path is `/v1/\\{prefix}/namespaces`.')).toEqual([])
  })

  test('allowlisted attributes do not count as markup', () => {
    expect(classify.detectDocsMarkup('Works with {product}.', ['product'])).toEqual([])
    expect(classify.detectDocsMarkup('Works with {product}.', [])).toEqual(['attribute'])
  })
})

describe('stripDocsMarkup', () => {
  test('keeps xref link text', () => {
    expect(classify.stripDocsMarkup('See xref:manage:security.adoc[the security guide].'))
      .toBe('See the security guide.')
  })

  test('derives text from the xref target when the label is empty', () => {
    expect(classify.stripDocsMarkup('See xref:manage:cluster-maintenance.adoc[].'))
      .toBe('See cluster maintenance.')
  })

  test('keeps the glossterm term', () => {
    expect(classify.stripDocsMarkup('Network address for the glossterm:Admin API[] server.'))
      .toBe('Network address for the Admin API server.')
  })

  test('keeps anchor cross-reference labels and bare anchors', () => {
    expect(classify.stripDocsMarkup('Uses <<kafka_api, `kafka_api`>> when unset.'))
      .toBe('Uses `kafka_api` when unset.')
    expect(classify.stripDocsMarkup('Uses <<kafka_api>> when unset.'))
      .toBe('Uses kafka_api when unset.')
  })

  test('converts property-link macros to backticked names or display text', () => {
    expect(classify.stripDocsMarkup('See config_ref:retention_ms,true,properties/cluster-properties[].'))
      .toBe('See `retention_ms`.')
    expect(classify.stripDocsMarkup('See prop:retention_ms[link=true,text=the retention setting].'))
      .toBe('See the retention setting.')
    expect(classify.stripDocsMarkup('See prop:retention_ms[].'))
      .toBe('See `retention_ms`.')
  })

  test('unwraps pass:q content and drops include and conditional lines', () => {
    const text = 'Intro pass:q[`code`] here.\ninclude::partial$x.adoc[]\nifdef::env-cloud[]\nCloud line.\nendif::[]\nOutro.'
    expect(classify.stripDocsMarkup(text)).toBe('Intro `code` here.\nCloud line.\nOutro.')
  })
})

describe('contentHash', () => {
  test('is stable across whitespace-only changes and unique per name and text', () => {
    const a = classify.contentHash('prop_a', 'Some  text\nhere.')
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(classify.contentHash('prop_a', 'Some text here.')).toBe(a)
    expect(classify.contentHash('prop_b', 'Some text here.')).not.toBe(a)
    expect(classify.contentHash('prop_a', 'Other text.')).not.toBe(a)
  })
})

describe('classifyDescription', () => {
  test('REDUNDANT when source matches after normalization', () => {
    const override = { description: 'The  source\ndescription.' }
    const row = classify.classifyDescription('p', override, sourceProp())
    expect(row.class).toBe(CLASSES.REDUNDANT)
    expect(row.source_file).toBe('src/v/config/configuration.cc')
    expect(row.content_hash).toMatch(/^[0-9a-f]{16}$/)
    expect(row.upstream_candidate_text).toBeUndefined()
  })

  test('UPSTREAMABLE when different and markup-free, carrying the override text', () => {
    const override = { description: 'A corrected, markup-free description of `things`.' }
    const row = classify.classifyDescription('p', override, sourceProp())
    expect(row.class).toBe(CLASSES.UPSTREAMABLE)
    expect(row.upstream_candidate_text).toBe(override.description)
  })

  test('KEEP_UNTIL_UPSTREAMED (SPLIT) when different and markup-laden, emitting stripped prose', () => {
    const override = { description: 'A corrected description. See xref:manage:tiered-storage.adoc[Tiered Storage].' }
    const row = classify.classifyDescription('p', override, sourceProp())
    expect(row.class).toBe(CLASSES.KEEP_UNTIL_UPSTREAMED)
    expect(row.upstream_candidate_text).toBe('A corrected description. See Tiered Storage.')
    expect(row.note).toContain('SPLIT')
  })

  test('KEEP when the markup-stripped prose already matches source (markup-only enrichment)', () => {
    const override = { description: 'The glossterm:source[] description.' }
    const src = sourceProp({ description: 'The source description.' })
    const row = classify.classifyDescription('p', override, src)
    expect(row.class).toBe(CLASSES.KEEP)
    expect(row.note).toContain('Markup-only enrichment')
  })

  test('REVIEW when the property is missing from the extracted JSON', () => {
    const row = classify.classifyDescription('p', { description: 'Anything.' }, null)
    expect(row.class).toBe(CLASSES.REVIEW)
    expect(row.note).toContain('not present')
  })

  test('carries upstream_ref into the manifest row', () => {
    const override = {
      description: 'A corrected description.',
      upstream_ref: 'https://github.com/redpanda-data/redpanda/pull/12345'
    }
    const row = classify.classifyDescription('p', override, sourceProp())
    expect(row.upstream_ref).toBe('https://github.com/redpanda-data/redpanda/pull/12345')
  })
})

describe('classifyField', () => {
  test('example classifies UPSTREAMABLE_SLOT, flagging block markup', () => {
    const plain = classify.classifyField('p', 'example', { example: '`tiered_v2`' }, sourceProp())
    expect(plain.class).toBe(CLASSES.UPSTREAMABLE_SLOT)
    expect(plain.note).not.toContain('block markup')

    const block = classify.classifyField('p', 'example', { example: ['[,yaml]', '----', 'a: 1', '----'] }, sourceProp())
    expect(block.class).toBe(CLASSES.UPSTREAMABLE_SLOT)
    expect(block.note).toContain('block markup')
  })

  test('example_file and example_yaml classify KEEP (docs-only variants)', () => {
    expect(classify.classifyField('p', 'example_file', { example_file: 'x.adoc' }, sourceProp()).class).toBe(CLASSES.KEEP)
    expect(classify.classifyField('p', 'example_yaml', { example_yaml: { config: {} } }, sourceProp()).class).toBe(CLASSES.KEEP)
  })

  test('accepted_values classifies REDUNDANT_OR_UPSTREAMABLE on enum properties, KEEP otherwise', () => {
    const enumProp = sourceProp({ enum: ['a', 'b', 'c'] })
    const same = classify.classifyField('p', 'accepted_values', { accepted_values: ['c', 'a', 'b'] }, enumProp)
    expect(same.class).toBe(CLASSES.REDUNDANT_OR_UPSTREAMABLE)
    expect(same.note).toContain('exactly')

    const filtered = classify.classifyField('p', 'accepted_values', { accepted_values: ['a', 'b'] }, enumProp)
    expect(filtered.class).toBe(CLASSES.REDUNDANT_OR_UPSTREAMABLE)
    expect(filtered.note).toContain('differ')

    const notEnum = classify.classifyField('p', 'accepted_values', { accepted_values: ['a'] }, sourceProp())
    expect(notEnum.class).toBe(CLASSES.KEEP)
  })

  test('default and type classify REDUNDANT when equal, REVIEW when different', () => {
    expect(classify.classifyField('p', 'default', { default: 100 }, sourceProp()).class).toBe(CLASSES.REDUNDANT)
    expect(classify.classifyField('p', 'default', { default: 200 }, sourceProp()).class).toBe(CLASSES.REVIEW)
    expect(classify.classifyField('p', 'type', { type: 'integer' }, sourceProp()).class).toBe(CLASSES.REDUNDANT)
    expect(classify.classifyField('p', 'type', { type: 'boolean' }, sourceProp()).class).toBe(CLASSES.REVIEW)
  })

  test('default/type classify REVIEW when the property is missing from the extracted JSON', () => {
    expect(classify.classifyField('p', 'default', { default: 1 }, null).class).toBe(CLASSES.REVIEW)
  })

  test.each(classify.KEEP_BY_DESIGN_FIELDS)('%s classifies KEEP by design', (field) => {
    const row = classify.classifyField('p', field, { [field]: 'anything' }, sourceProp())
    expect(row.class).toBe(CLASSES.KEEP)
    expect(row.note).toContain('by design')
  })

  test('the acceptable_values typo is flagged as REVIEW', () => {
    const row = classify.classifyField('p', 'acceptable_values', { acceptable_values: ['a'] }, sourceProp())
    expect(row.class).toBe(CLASSES.REVIEW)
    expect(row.note).toContain("Typo'd key")
    expect(row.note).toContain('accepted_values')
  })

  test('meta fields produce no row; unknown fields classify KEEP with a note', () => {
    expect(classify.classifyField('p', '_comment', { _comment: 'x' }, sourceProp())).toBeNull()
    expect(classify.classifyField('p', 'upstream_ref', { upstream_ref: 'x' }, sourceProp())).toBeNull()
    const unknown = classify.classifyField('p', 'mystery_field', { mystery_field: 1 }, sourceProp())
    expect(unknown.class).toBe(CLASSES.KEEP)
    expect(unknown.note).toContain('Unrecognized')
  })
})

describe('classifyProperties', () => {
  const overridesDoc = {
    properties: {
      redundant_prop: { description: 'Matches source.', config_scope: 'cluster' },
      upstreamable_prop: { description: 'Better text.', upstream_ref: 'PR-1' },
      split_prop: { description: 'Better text. See xref:x.adoc[the guide].' },
      malformed_prop: 'not-an-object'
    }
  }
  const extractedDoc = {
    properties: {
      redundant_prop: sourceProp({ description: 'Matches  source.' }),
      upstreamable_prop: sourceProp(),
      split_prop: sourceProp()
    }
  }

  test('classifies every field of every entry and summarizes counts', () => {
    const { manifest, summary } = classify.classifyProperties(overridesDoc, extractedDoc)
    const byName = Object.fromEntries(manifest.filter((r) => r.field === 'description').map((r) => [r.name, r]))
    expect(byName.redundant_prop.class).toBe(CLASSES.REDUNDANT)
    expect(byName.upstreamable_prop.class).toBe(CLASSES.UPSTREAMABLE)
    expect(byName.upstreamable_prop.upstream_ref).toBe('PR-1')
    expect(byName.split_prop.class).toBe(CLASSES.KEEP_UNTIL_UPSTREAMED)

    const malformed = manifest.find((r) => r.name === 'malformed_prop')
    expect(malformed.class).toBe(CLASSES.REVIEW)

    expect(summary.total).toBe(manifest.length)
    expect(summary.byClass[CLASSES.REDUNDANT]).toBe(1)
    expect(summary.byField.description[CLASSES.UPSTREAMABLE]).toBe(1)
  })

  test('is deterministic: reruns produce identical manifests', () => {
    const first = classify.classifyProperties(overridesDoc, extractedDoc)
    const second = classify.classifyProperties(overridesDoc, extractedDoc)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })
})
