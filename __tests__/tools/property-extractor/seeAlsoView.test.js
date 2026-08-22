'use strict'

const seeAlsoView = require('../../../tools/property-extractor/helpers/seeAlsoView')
const { normalizeSeeAlso } = seeAlsoView

describe('normalizeSeeAlso', () => {
  it('returns an empty array when neither see_also nor related_topics is set', () => {
    expect(normalizeSeeAlso({ name: 'x' })).toEqual([])
  })

  it('normalizes plain see_also strings as unconditional items', () => {
    const items = normalizeSeeAlso({ see_also: ['xref:a.adoc[]'] })
    expect(items).toEqual([{ content: 'xref:a.adoc[]', cloudOnly: false, selfHostedOnly: false }])
  })

  it('normalizes structured see_also objects', () => {
    const items = normalizeSeeAlso({
      see_also: [
        { content: 'xref:cloud.adoc[]', cloud_only: true },
        { content: 'xref:sh.adoc[]', self_hosted_only: true },
      ],
    })
    expect(items).toEqual([
      { content: 'xref:cloud.adoc[]', cloudOnly: true, selfHostedOnly: false },
      { content: 'xref:sh.adoc[]', cloudOnly: false, selfHostedOnly: true },
    ])
  })

  it('falls back to related_topics when see_also is absent', () => {
    const items = normalizeSeeAlso({ related_topics: ['xref:a.adoc[]'] })
    expect(items).toEqual([{ content: 'xref:a.adoc[]', cloudOnly: false, selfHostedOnly: false }])
  })

  it('prefers see_also over related_topics when both are present', () => {
    const items = normalizeSeeAlso({
      see_also: ['xref:new.adoc[]'],
      related_topics: ['xref:old.adoc[]'],
    })
    expect(items).toEqual([{ content: 'xref:new.adoc[]', cloudOnly: false, selfHostedOnly: false }])
  })

  it('parses the deprecated cloud-only: prefix out of related_topics strings', () => {
    const items = normalizeSeeAlso({ related_topics: ['cloud-only: xref:a.adoc[]'] })
    expect(items).toEqual([{ content: 'xref:a.adoc[]', cloudOnly: true, selfHostedOnly: false }])
  })

  it('parses the deprecated self-managed-only: prefix out of related_topics strings', () => {
    const items = normalizeSeeAlso({ related_topics: ['self-managed-only: xref:a.adoc[]'] })
    expect(items).toEqual([{ content: 'xref:a.adoc[]', cloudOnly: false, selfHostedOnly: true }])
  })

  it('drops an item with no usable content', () => {
    const items = normalizeSeeAlso({ see_also: ['', '   ', { cloud_only: true }, 'xref:a.adoc[]'] })
    expect(items).toEqual([{ content: 'xref:a.adoc[]', cloudOnly: false, selfHostedOnly: false }])
  })
})

describe('seeAlsoView', () => {
  it('reports sectionType "normal" and an empty item list when there is nothing to show', () => {
    expect(seeAlsoView({ name: 'x' })).toEqual({ items: [], sectionType: 'normal' })
  })

  it('reports sectionType "cloud" only when every item is cloud-only', () => {
    const view = seeAlsoView({
      see_also: [{ content: 'a', cloud_only: true }, { content: 'b', cloud_only: true }],
    })
    expect(view.sectionType).toBe('cloud')
  })

  it('reports sectionType "self-managed" only when every item is self-hosted-only', () => {
    const view = seeAlsoView({
      see_also: [{ content: 'a', self_hosted_only: true }],
    })
    expect(view.sectionType).toBe('self-managed')
  })

  it('reports sectionType "normal" for a mix of conditional and unconditional items', () => {
    const view = seeAlsoView({
      see_also: ['a', { content: 'b', cloud_only: true }, { content: 'c', self_hosted_only: true }],
    })
    expect(view.sectionType).toBe('normal')
    expect(view.items).toHaveLength(3)
  })

  it('reports sectionType "normal" when cloud-only and self-hosted-only items are both present with nothing unconditional', () => {
    // Neither "every item is cloud-only" nor "every item is self-hosted-only" holds,
    // so each item must still be wrapped individually — this is exactly the case the
    // old allTopicsConditional() "all-same" fast path did not cover on its own.
    const view = seeAlsoView({
      see_also: [{ content: 'a', cloud_only: true }, { content: 'b', self_hosted_only: true }],
    })
    expect(view.sectionType).toBe('normal')
  })
})
