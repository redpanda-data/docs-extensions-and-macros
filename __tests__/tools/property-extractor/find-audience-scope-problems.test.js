'use strict';

const findAudienceScopeProblems = require('../../../tools/property-extractor/helpers/findAudienceScopeProblems.js');
const { findSuspiciousPrefix, findSuspiciousFlags } = findAudienceScopeProblems;
const { flattenDescription } = require('../../../tools/property-extractor/helpers/applyPropertyLinks.js');

describe('the correct spellings are never reported', () => {
  it.each([
    ['cloud-only: Cloud sentence.'],
    ['self-managed-only: Self-Managed sentence.'],
    ['  cloud-only: leading whitespace is fine.'],
    ['Plain prose with no scope at all.'],
    ['A sentence mentioning cloud-only: midway through, not as a prefix.']
  ])('%s', (value) => {
    expect(findSuspiciousPrefix(value)).toBeNull();
  });

  it('leaves the deprecated self_hosted_only boolean alone, since parseAudience honours it', () => {
    expect(findSuspiciousFlags({ content: 'x', self_hosted_only: true })).toEqual([]);
  });
});

describe('near-miss prefixes are reported', () => {
  // Every one of these was verified to render as literal page text: the
  // prefix is published, prefix and colon included, in both builds.
  it.each([
    ['cloud_only: A.', 'cloud_only'],
    ['cloud-only : A.', 'cloud-only'],
    ['self-hosted-only: A.', 'self-hosted-only'],
    ['Cloud-only: A.', 'Cloud-only'],
    ['cloudonly: A.', 'cloudonly'],
    ['self_managed_only: A.', 'self_managed_only'],
    ['SELF-MANAGED-ONLY: A.', 'SELF-MANAGED-ONLY']
  ])('%s reports %s', (value, expected) => {
    expect(findSuspiciousPrefix(value)).toBe(expected);
  });
});

describe('near-miss flags are reported', () => {
  it.each([
    [{ cloudOnly: true }, ['cloudOnly']],
    [{ 'cloud-only': true }, ['cloud-only']],
    [{ selfManagedOnly: true }, ['selfManagedOnly']],
    [{ 'self managed only': true }, ['self managed only']]
  ])('%o reports %p', (item, expected) => {
    expect(findSuspiciousFlags(item)).toEqual(expected);
  });

  it('reports nothing for the two valid flags', () => {
    expect(findSuspiciousFlags({ cloud_only: true, self_managed_only: false })).toEqual([]);
  });
});

describe('every audience-scopable field is walked', () => {
  const properties = {
    a: { description: ['Base.', 'cloud_only: A.'] },
    b: { links: { key: 'cloud_only: #rpc_server' } },
    c: { see_also: ['cloud_only: xref:x.adoc[X]'] },
    d: { related_topics: ['Cloud-only: xref:y.adoc[Y]'] },
    e: { admonitions: [{ type: 'NOTE', text: 't', cloudOnly: true }] },
    f: { includes: [{ target: 'x.adoc', 'cloud-only': true }] }
  };

  const problems = findAudienceScopeProblems(properties);

  it('finds one problem per field, and no more', () => {
    expect(problems).toHaveLength(6);
  });

  it.each([
    ['a', 'description[1]', 'unrecognized-prefix'],
    ['b', 'links["key"]', 'unrecognized-prefix'],
    ['c', 'see_also[0]', 'unrecognized-prefix'],
    ['d', 'related_topics[0]', 'unrecognized-prefix'],
    ['e', 'admonitions[0]', 'unrecognized-flag'],
    ['f', 'includes[0]', 'unrecognized-flag']
  ])('reports %s %s as %s', (property, field, problem) => {
    expect(problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ property, field, problem })])
    );
  });
});

describe('the reported problems are real, not theoretical', () => {
  // The negative control for the whole feature: prove that a prefix this
  // module reports is genuinely published as literal text, and that one it
  // stays quiet about is genuinely turned into a conditional. If flatten ever
  // learns to accept these spellings, this test fails and the detector should
  // be relaxed to match.
  it('a reported prefix survives into the rendered AsciiDoc as literal text', () => {
    const suspicious = 'cloud_only: Cloud sentence.';
    expect(findSuspiciousPrefix(suspicious)).toBe('cloud_only');

    const out = flattenDescription(['Base prose.', suspicious]);
    expect(out).toContain('cloud_only: Cloud sentence.');
    expect(out).not.toMatch(/^ifn?def::env-cloud\[\]$/m);
  });

  it('an unreported prefix becomes a conditional and leaves no literal prefix', () => {
    const correct = 'cloud-only: Cloud sentence.';
    expect(findSuspiciousPrefix(correct)).toBeNull();

    const out = flattenDescription(['Base prose.', correct]);
    expect(out).toMatch(/^ifdef::env-cloud\[\]$/m);
    expect(out).not.toContain('cloud-only:');
  });
});

describe('the live corpus is clean', () => {
  it('reports no problems for the vendored overrides corpus', () => {
    const corpus = require('../../docs-data/property-overrides.json');
    const properties = corpus.properties || corpus;
    expect(findAudienceScopeProblems(properties)).toEqual([]);
  });
});

describe('malformed input does not throw', () => {
  it.each([
    [undefined],
    [null],
    [{}],
    [{ a: null }],
    [{ a: { description: 'a plain string description' } }],
    [{ a: { links: null, see_also: 'not an array', admonitions: 7 } }]
  ])('%p', (input) => {
    expect(() => findAudienceScopeProblems(input)).not.toThrow();
  });
});
