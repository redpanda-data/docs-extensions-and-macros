const fs = require('fs');
const path = require('path');
const {
  generateReleaseNotes,
  buildReleaseSection,
  clusterSectionByArea,
  assertSectionMatchesTag,
  insertReleaseSection,
  compareVersions,
  isGaTag,
  readFloor,
  hasVersionSection,
} = require('../../tools/redpanda-release-notes/generate-release-notes');

const FIXTURES = path.join(__dirname, '../fixtures/release-notes');
const BODY = fs.readFileSync(path.join(FIXTURES, 'v26.2.2-streaming-enterprise.md'), 'utf8');
const CURATED_V2623 = fs.readFileSync(path.join(FIXTURES, 'curated/v26.2.3-curated.adoc'), 'utf8');

// A page shaped like modules/reference/pages/releases/redpanda.adoc.
function page({ floor = '26.2.2', withV2622 = true } = {}) {
  const lines = [
    '= Redpanda Release Notes',
    ':description: Detailed release notes for each Redpanda patch release, organized by version.',
    ':page-topic-type: reference',
    `:earliest-tracked-version: ${floor}`,
    '',
    'This page lists the changes in each Redpanda release from version {earliest-tracked-version} onward.',
    '',
  ];
  if (withV2622) {
    lines.push('== v26.2.2 (2026-08-21)', '', '=== Features', '', '* Something shipped.', '');
  }
  lines.push('== Release notes for older versions', '', 'See the Redpanda releases page.', '');
  return lines.join('\n');
}

describe('compareVersions', () => {
  it('orders versions numerically, not lexically', () => {
    expect(compareVersions('26.2.10', '26.2.2')).toBe(1);
    expect(compareVersions('v26.2.2', '26.2.2')).toBe(0);
    expect(compareVersions('26.1.9', '26.2.0')).toBe(-1);
  });
});

describe('isGaTag', () => {
  it('accepts bare vX.Y.Z', () => {
    expect(isGaTag('v26.2.3')).toBe(true);
    expect(isGaTag('26.2.3')).toBe(true);
  });
  it('rejects prereleases', () => {
    expect(isGaTag('v26.2.3-rc1')).toBe(false);
    expect(isGaTag('v26.2.3-beta')).toBe(false);
  });
});

describe('readFloor / hasVersionSection', () => {
  it('reads the floor attribute', () => {
    expect(readFloor(page())).toBe('26.2.2');
  });
  it('detects an existing version section', () => {
    expect(hasVersionSection(page(), 'v26.2.2')).toBe(true);
    expect(hasVersionSection(page(), '26.2.3')).toBe(false);
  });
});

describe('insertReleaseSection', () => {
  it('inserts before the first existing version heading (newest-first)', () => {
    const out = insertReleaseSection(page(), '== v26.2.3 (2026-09-15)\n\n=== Features\n\n* New.\n');
    expect(out.indexOf('== v26.2.3')).toBeLessThan(out.indexOf('== v26.2.2'));
  });
  it('inserts before the older-versions footer when there are no version sections yet', () => {
    const out = insertReleaseSection(page({ withV2622: false }), '== v26.2.3 (2026-09-15)\n\n* New.\n');
    expect(out.indexOf('== v26.2.3')).toBeLessThan(out.indexOf('== Release notes for older versions'));
  });

  // Finding 3: descending-version order for out-of-sequence (backfill) inserts.
  const multi = [
    '= Redpanda Release Notes',
    ':earliest-tracked-version: 26.2.0',
    '',
    'Intro.',
    '',
    '== v26.2.5 (2026-10-01)', '', '=== Features', '', '* Five.', '',
    '== v26.2.2 (2026-08-21)', '', '=== Features', '', '* Two.', '',
    '== Release notes for older versions', '', 'GitHub.', '',
  ].join('\n');

  it('places a backfilled middle version between the newer and older sections', () => {
    const out = insertReleaseSection(multi, '== v26.2.3 (2026-09-15)\n\n=== Features\n\n* Three.\n');
    expect(out.indexOf('== v26.2.5')).toBeLessThan(out.indexOf('== v26.2.3'));
    expect(out.indexOf('== v26.2.3')).toBeLessThan(out.indexOf('== v26.2.2'));
  });

  it('places a version older than all present above the footer, below the last section', () => {
    const out = insertReleaseSection(multi, '== v26.2.1 (2026-08-01)\n\n=== Features\n\n* One.\n');
    expect(out.indexOf('== v26.2.2')).toBeLessThan(out.indexOf('== v26.2.1'));
    expect(out.indexOf('== v26.2.1')).toBeLessThan(out.indexOf('== Release notes for older versions'));
  });

  it('places a version newer than all present at the top', () => {
    const out = insertReleaseSection(multi, '== v26.2.9 (2026-11-01)\n\n=== Features\n\n* Nine.\n');
    expect(out.indexOf('== v26.2.9')).toBeLessThan(out.indexOf('== v26.2.5'));
  });

  // Finding 1: a section that opens with a blank line or comment still orders
  // correctly (multiline version parse).
  it('orders a section that opens with a blank line or comment', () => {
    const out = insertReleaseSection(multi, '\n// generated\n== v26.2.9 (2026-11-01)\n\n=== Features\n\n* Nine.\n');
    expect(out.indexOf('== v26.2.9')).toBeLessThan(out.indexOf('== v26.2.5'));
  });

  // Finding 3: older-than-all on a footerless page lands after the last section.
  it('places an older-than-all backfill after the last section when there is no footer', () => {
    const footerless = [
      '= Redpanda Release Notes', ':earliest-tracked-version: 26.2.0', '', 'Intro.', '',
      '== v26.2.5 (2026-10-01)', '', '=== Features', '', '* Five.', '',
      '== v26.2.4 (2026-09-20)', '', '=== Features', '', '* Four.', '',
    ].join('\n');
    const out = insertReleaseSection(footerless, '== v26.2.1 (2026-08-01)\n\n=== Features\n\n* One.\n');
    expect(out.indexOf('== v26.2.4')).toBeLessThan(out.indexOf('== v26.2.1'));
    // and it is the last release section on the page
    expect(out.lastIndexOf('== v')).toBe(out.indexOf('== v26.2.1'));
  });
});

describe('clusterSectionByArea', () => {
  const scattered = [
    '== v26.2.9 (2026-11-01)', '',
    '=== Bug fixes', '',
    'Security:: Alpha.', '',
    'Kafka API:: Beta.', '',
    'Security:: Gamma.', '',
    'Cloud Topics:: Delta.', '',
    'Kafka API:: Epsilon.', '',
    '=== Improvements', '',
    'rpk:: Zeta.', '',
    'Security:: Theta.', '',
  ].join('\n');

  const clustered = [
    '== v26.2.9 (2026-11-01)', '',
    '=== Bug fixes', '',
    'Security:: Alpha.', '',
    'Security:: Gamma.', '',
    'Kafka API:: Beta.', '',
    'Kafka API:: Epsilon.', '',
    'Cloud Topics:: Delta.', '',
    '=== Improvements', '',
    'rpk:: Zeta.', '',
    'Security:: Theta.', '',
  ].join('\n');

  it('clusters same-area entries by first appearance, stable within an area', () => {
    expect(clusterSectionByArea(scattered)).toBe(clustered);
  });

  it('is idempotent: clustering a clustered section changes nothing', () => {
    expect(clusterSectionByArea(clustered)).toBe(clustered);
  });

  it('does not move entries across a category boundary', () => {
    // The Bug fixes "Security" entries do not absorb the Improvements "Security".
    const out = clusterSectionByArea(scattered);
    expect(out.indexOf('Security:: Theta.')).toBeGreaterThan(out.indexOf('=== Improvements'));
  });

  it('leaves a category of plain bullets (a phase-1 candidate) untouched', () => {
    const bullets = [
      '== v26.2.9 (2026-11-01)', '',
      '=== Features', '',
      '* First.', '',
      '* Second.', '',
    ].join('\n');
    expect(clusterSectionByArea(bullets)).toBe(bullets);
  });

  it('bails on a category that mixes an Area:: entry with a non-labeled one', () => {
    const mixed = [
      '== v26.2.9 (2026-11-01)', '',
      '=== Bug fixes', '',
      'Security:: One.', '',
      '* Unlabeled.', '',
      'Security:: Two.', '',
    ].join('\n');
    // Order preserved (no reorder), so the unlabeled entry stays between them.
    expect(clusterSectionByArea(mixed)).toBe(mixed);
  });

  it('bails on bullet-form entries that carry a :: (a leading list marker is not an area)', () => {
    // A plain `*` bullet that happens to contain `::` must not be mistaken for
    // an area entry and reordered — the whole bullet list is left untouched.
    const bulletsWithColons = [
      '== v26.2.9 (2026-11-01)', '',
      '=== Bug fixes', '',
      '* Security:: First.', '',
      '* Kafka API:: Beta.', '',
      '* Security:: Gamma.', '',
    ].join('\n');
    expect(clusterSectionByArea(bulletsWithColons)).toBe(bulletsWithColons);
  });
});

describe('assertSectionMatchesTag (finding 1)', () => {
  it('accepts a section whose single heading matches the tag', () => {
    expect(() => assertSectionMatchesTag('== v26.2.3 (2026-09-15)\n\n=== Features\n\n* X.\n', '26.2.3')).not.toThrow();
  });
  it('rejects a heading whose version does not match the tag', () => {
    expect(() => assertSectionMatchesTag('== v99.9.9 (2026-09-15)\n\n* X.\n', '26.2.3')).toThrow(/does not match/);
  });
  it('rejects a section with no release heading', () => {
    expect(() => assertSectionMatchesTag('=== Features\n\n* X.\n', '26.2.3')).toThrow(/exactly one/);
  });
  it('rejects a section with several release headings', () => {
    expect(() => assertSectionMatchesTag('== v26.2.3 (2026-09-15)\n\n== v26.2.4 (2026-09-16)\n', '26.2.3')).toThrow(/exactly one/);
  });
  it('rejects malformed headings that only satisfy the prefix (finding 2)', () => {
    expect(() => assertSectionMatchesTag('== v26.2.3 (\n\n* X.\n', '26.2.3')).toThrow(/Malformed/);
    expect(() => assertSectionMatchesTag('== v26.2.3 (not-a-date\n\n* X.\n', '26.2.3')).toThrow(/Malformed/);
    expect(() => assertSectionMatchesTag('== v26.2.3 (2026-09-15) trailing\n\n* X.\n', '26.2.3')).toThrow(/Malformed/);
  });
  it('accepts the exact well-formed heading', () => {
    expect(() => assertSectionMatchesTag('== v26.2.3 (2026-09-15)\n\n* X.\n', '26.2.3')).not.toThrow();
  });
});

describe('generateReleaseNotes guards', () => {
  it('skips a non-GA tag', () => {
    const res = generateReleaseNotes({ body: BODY, tag: 'v26.2.3-rc1', date: '2026-09-15', pageContent: page() });
    expect(res.status).toBe('skipped');
    expect(res.reason).toMatch(/GA/);
  });

  it('skips a version at or below the floor', () => {
    const res = generateReleaseNotes({ body: BODY, tag: 'v26.2.1', date: '2026-09-15', pageContent: page() });
    expect(res.status).toBe('skipped');
    expect(res.reason).toMatch(/floor/);
  });

  it('skips a version already on the page (idempotent re-run)', () => {
    // Floor below the existing section, so only the idempotency guard can fire.
    const res = generateReleaseNotes({ body: BODY, tag: 'v26.2.2', date: '2026-08-21', pageContent: page({ floor: '26.2.0' }) });
    expect(res.status).toBe('skipped');
    expect(res.reason).toMatch(/already/);
  });
});

describe('generateReleaseNotes (real fixture, newer tag)', () => {
  const res = generateReleaseNotes({ body: BODY, tag: 'v26.2.3', date: '2026-09-15', pageContent: page() });

  it('returns ok and inserts the new section above the older one', () => {
    expect(res.status).toBe('ok');
    expect(res.content.indexOf('== v26.2.3 (2026-09-15)')).toBeLessThan(res.content.indexOf('== v26.2.2 (2026-08-21)'));
  });

  it('produces a candidate section with cleaned entries and no Area:: labels', () => {
    expect(res.section).toContain('=== Features');
    expect(res.section).toContain('=== Improvements');
    expect(res.section).toContain('=== Bug fixes');
    expect(res.section).not.toMatch(/by @/);
    expect(res.section).not.toMatch(/::/);
  });

  it('leaves the older-versions footer intact', () => {
    expect(res.content).toContain('== Release notes for older versions');
  });
});

// Deterministic candidate goldens: exact-match the committed expected section for
// each real release body. These lock down parse/strip/dedup/order/transforms.
// They are NOT the curated page — curation (Area:: labels, present-tense voice,
// dropping bodyless and out-of-scope entries) is a separate, judgment-bearing
// step with its own future golden. Regenerate with:
//   node -e "const fs=require('fs');const {buildReleaseSection}=require('./tools/redpanda-release-notes/generate-release-notes');\
//   for(const [t,d] of [['v26.2.2','2026-08-21'],['v26.2.3','2026-09-17']]) fs.writeFileSync(\
//   '__tests__/fixtures/release-notes/expected/'+t+'-candidate.adoc',\
//   buildReleaseSection({body:fs.readFileSync('__tests__/fixtures/release-notes/'+t+'-streaming-enterprise.md','utf8'),version:t,date:d}))"
describe('generateReleaseNotes phase 2 (insert a curated section)', () => {
  it('inserts the curated section newest-first, clustering its entries by area', () => {
    const res = generateReleaseNotes({ section: CURATED_V2623, tag: 'v26.2.3', pageContent: page() });
    expect(res.status).toBe('ok');
    // Curated labels are kept (proves it used the curated section, not rebuilt
    // from a body — a rebuild would carry no Area:: labels).
    expect(res.content).toContain('Cluster:: Reconnection logic is hardened');
    expect(res.content.indexOf('== v26.2.3')).toBeLessThan(res.content.indexOf('== v26.2.2'));
    // The scattered fixture is clustered on the way in: the order changed, and
    // the result is itself cluster-stable.
    expect(res.section).not.toBe(CURATED_V2623);
    expect(clusterSectionByArea(res.section)).toBe(res.section);
  });

  it('applies the floor guard on the section path too', () => {
    const res = generateReleaseNotes({
      section: '== v26.2.2 (2026-08-21)\n\n=== Features\n\nrpk:: x.\n',
      tag: 'v26.2.2',
      pageContent: page({ floor: '26.2.2' }),
    });
    expect(res.status).toBe('skipped');
  });

  it('throws when both body and section are given', () => {
    expect(() => generateReleaseNotes({ body: BODY, section: CURATED_V2623, tag: 'v26.2.3', pageContent: page() }))
      .toThrow(/only one/i);
  });

  it('throws when neither body nor section is given', () => {
    expect(() => generateReleaseNotes({ tag: 'v26.2.3', pageContent: page() }))
      .toThrow(/either body .* or section/i);
  });

  it('throws when the curated section heading does not match the tag (finding 1)', () => {
    const mismatched = '== v99.9.9 (2026-09-15)\n\n=== Features\n\nrpk:: X.\n';
    expect(() => generateReleaseNotes({ section: mismatched, tag: 'v26.2.3', pageContent: page() }))
      .toThrow(/does not match/);
  });
});

describe('candidate goldens', () => {
  it.each([
    ['v26.2.2', '2026-08-21'],
    ['v26.2.3', '2026-09-17'],
  ])('matches the expected candidate for %s', (tag, date) => {
    const body = fs.readFileSync(path.join(FIXTURES, `${tag}-streaming-enterprise.md`), 'utf8');
    const expected = fs.readFileSync(path.join(FIXTURES, `expected/${tag}-candidate.adoc`), 'utf8');
    expect(buildReleaseSection({ body, version: tag, date })).toBe(expected);
  });
});
