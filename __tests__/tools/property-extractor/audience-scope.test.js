'use strict';

const parseAudience = require('../../../tools/property-extractor/helpers/audienceScope');
const { normalizeSeeAlso } = require('../../../tools/property-extractor/helpers/seeAlsoView');

describe('parseAudience', () => {
  it('reads the cloud-only string prefix', () => {
    expect(parseAudience('cloud-only: xref:manage:monitor-cloud.adoc[Monitor]'))
      .toEqual({ content: 'xref:manage:monitor-cloud.adoc[Monitor]', cloudOnly: true, selfHostedOnly: false });
  });

  it('reads the self-managed-only string prefix', () => {
    expect(parseAudience('self-managed-only: #foo'))
      .toEqual({ content: '#foo', cloudOnly: false, selfHostedOnly: true });
  });

  it('treats an unprefixed string as unconditional', () => {
    expect(parseAudience('  xref:a.adoc[A]  '))
      .toEqual({ content: 'xref:a.adoc[A]', cloudOnly: false, selfHostedOnly: false });
  });

  it('reads the object booleans', () => {
    expect(parseAudience({ content: 'x', cloud_only: true }))
      .toEqual({ content: 'x', cloudOnly: true, selfHostedOnly: false });
    expect(parseAudience({ content: 'x', self_hosted_only: true }))
      .toEqual({ content: 'x', cloudOnly: false, selfHostedOnly: true });
  });

  it('only honors a boolean that is exactly true', () => {
    // A truthy-but-not-true value would otherwise scope content on a typo.
    expect(parseAudience({ content: 'x', cloud_only: 'yes' }).cloudOnly).toBe(false);
  });

  it('returns null for an item with no usable content', () => {
    expect(parseAudience(null)).toBeNull();
    expect(parseAudience(42)).toBeNull();
    expect(parseAudience({ cloud_only: true })).toBeNull();
  });

  it('only strips a prefix that leads the string', () => {
    // A mid-sentence mention is prose, not a scope marker.
    expect(parseAudience('Applies cloud-only: sometimes').cloudOnly).toBe(false);
  });

  it('is the same parser see_also uses, so the two spellings cannot drift', () => {
    const viaPrefix = normalizeSeeAlso({ related_topics: ['cloud-only: xref:a.adoc[A]'] });
    const viaBoolean = normalizeSeeAlso({ see_also: [{ content: 'xref:a.adoc[A]', cloud_only: true }] });
    expect(viaPrefix).toEqual(viaBoolean);
  });
});
